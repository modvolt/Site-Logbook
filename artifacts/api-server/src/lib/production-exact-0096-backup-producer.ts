import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Readable,
  Transform,
  type TransformCallback,
  type Writable,
} from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import {
  BACKUP_ACTIVE_KEY_ENV,
  BACKUP_KEYRING_ENV,
  loadEncryptionKeyring,
  type EncryptionKeyring,
} from "./secret-envelope";
import {
  ObjectStorageService,
  type ProductionExactVersionedObjectHead,
} from "./objectStorage";

const MVE1_MAGIC = Buffer.from("MVE1", "ascii");
const AES_GCM = "aes-256-gcm";
const IV_BYTES = 12;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CANONICAL_ROW_BYTES = 8 * 1024 * 1024;
const MAX_CANONICAL_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_RELATION_BYTES = 1024 * 1024 * 1024;
const CHILD_TERM_GRACE_MS = 2_000;
const CHILD_KILL_GRACE_MS = 2_000;
const RELATION = /^[a-z_][a-z0-9_$]*\.[a-z_][a-z0-9_$]*$/;
const IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;

export const PRODUCTION_EXACT_0096_CONTENT_DIGEST_ALGORITHM =
  "sha256-canonical-jsonl-column-order-pk-or-all-column-sort-v1";

export class ProductionExact0096ProducerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProductionExact0096ProducerError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductionExact0096ProducerError(code, message);
}

function stableValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString("hex")}`;
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail("PRODUCTION_BACKUP_ROW_VALUE_INVALID", "Non-finite row value.");
    }
    return value;
  }
  fail("PRODUCTION_BACKUP_ROW_VALUE_INVALID", "Unsupported row value type.");
}

export function canonicalProductionExact0096Row(
  values: readonly unknown[],
): string {
  return `${JSON.stringify(stableValue(values))}\n`;
}

export function canonicalizeProductionExact0096JsonText(raw: string): string {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(raw[offset] ?? "")) offset += 1;
  };
  const string = (): { decoded: string; canonical: string } => {
    const start = offset;
    if (raw[offset] !== '"')
      fail("PRODUCTION_BACKUP_ROW_VALUE_INVALID", "JSON string expected.");
    offset += 1;
    while (offset < raw.length) {
      if (raw[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (raw[offset] === '"') {
        offset += 1;
        const decoded = JSON.parse(raw.slice(start, offset)) as string;
        return { decoded, canonical: JSON.stringify(decoded) };
      }
      offset += 1;
    }
    fail("PRODUCTION_BACKUP_ROW_VALUE_INVALID", "Unterminated JSON string.");
  };
  const value = (): string => {
    whitespace();
    if (raw[offset] === '"') return string().canonical;
    if (raw[offset] === "[") {
      offset += 1;
      whitespace();
      const items: string[] = [];
      if (raw[offset] !== "]") {
        while (true) {
          items.push(value());
          whitespace();
          if (raw[offset] === "]") break;
          if (raw[offset] !== ",")
            fail(
              "PRODUCTION_BACKUP_ROW_VALUE_INVALID",
              "JSON array delimiter invalid.",
            );
          offset += 1;
        }
      }
      offset += 1;
      return `[${items.join(",")}]`;
    }
    if (raw[offset] === "{") {
      offset += 1;
      whitespace();
      const entries: Array<{ key: string; encoded: string; value: string }> =
        [];
      if (raw[offset] !== "}") {
        while (true) {
          whitespace();
          const key = string();
          whitespace();
          if (raw[offset] !== ":")
            fail(
              "PRODUCTION_BACKUP_ROW_VALUE_INVALID",
              "JSON object delimiter invalid.",
            );
          offset += 1;
          entries.push({
            key: key.decoded,
            encoded: key.canonical,
            value: value(),
          });
          whitespace();
          if (raw[offset] === "}") break;
          if (raw[offset] !== ",")
            fail(
              "PRODUCTION_BACKUP_ROW_VALUE_INVALID",
              "JSON object delimiter invalid.",
            );
          offset += 1;
        }
      }
      offset += 1;
      entries.sort((left, right) =>
        left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      );
      if (
        entries.some(
          (entry, index) => index > 0 && entry.key === entries[index - 1].key,
        )
      ) {
        fail(
          "PRODUCTION_BACKUP_ROW_VALUE_INVALID",
          "Duplicate JSON object key.",
        );
      }
      return `{${entries.map((entry) => `${entry.encoded}:${entry.value}`).join(",")}}`;
    }
    const token =
      /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        raw.slice(offset),
      )?.[0];
    if (!token)
      fail("PRODUCTION_BACKUP_ROW_VALUE_INVALID", "JSON token invalid.");
    offset += token.length;
    return token;
  };
  const canonical = value();
  whitespace();
  if (offset !== raw.length)
    fail("PRODUCTION_BACKUP_ROW_VALUE_INVALID", "Trailing JSON bytes.");
  return canonical;
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) {
    fail("PRODUCTION_BACKUP_RELATION_INVALID", "Non-canonical SQL identifier.");
  }
  return `"${value}"`;
}

type SnapshotQueryClient = Pick<pg.Client, "query">;

type SnapshotClient = SnapshotQueryClient & {
  connect(): Promise<void>;
  end(): Promise<void>;
};

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value))}\n`;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

type RelationColumn = Readonly<{
  name: string;
  ordinal: number;
  primaryKeyOrdinal: number | null;
}>;

type RelationCatalogRow = Readonly<{
  schema_name: string;
  relation_name: string;
  relation_kind: string;
  persistence: string;
  is_partition: boolean;
}>;

async function assertExactProductionRelationCatalog(
  client: SnapshotQueryClient,
  expectedNames: readonly string[],
): Promise<void> {
  const result = await client.query<RelationCatalogRow>(
    `SELECT n.nspname AS schema_name,
            c.relname AS relation_name,
            c.relkind::text AS relation_kind,
            c.relpersistence::text AS persistence,
            c.relispartition AS is_partition
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
        AND c.relkind IN ('r', 'p', 'm', 'f')
      ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`,
  );
  const observed: string[] = [];
  for (const row of result.rows) {
    if (
      !IDENTIFIER.test(row.schema_name) ||
      !IDENTIFIER.test(row.relation_name) ||
      !["r", "p", "m", "f"].includes(row.relation_kind) ||
      !["p", "u", "t"].includes(row.persistence) ||
      typeof row.is_partition !== "boolean"
    ) {
      fail(
        "PRODUCTION_BACKUP_RELATION_INVALID",
        "Live relation catalog returned a non-canonical identity.",
      );
    }
    const identity = `${row.schema_name}.${row.relation_name}`;
    if (
      row.relation_kind !== "r" ||
      row.persistence !== "p" ||
      row.is_partition
    ) {
      fail(
        "PRODUCTION_BACKUP_UNSUPPORTED_RELATION",
        `Live relation ${identity} is not a permanent standalone table.`,
      );
    }
    observed.push(identity);
  }
  const expected = [...expectedNames].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  observed.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    fail(
      "PRODUCTION_BACKUP_RELATION_MANIFEST_DRIFT",
      "Live persistent relation catalog differs from the frozen exact-0096 manifest.",
    );
  }
}

async function readRelationColumns(
  client: SnapshotQueryClient,
  schema: string,
  table: string,
): Promise<readonly RelationColumn[]> {
  const result = await client.query<{
    column_name: string;
    ordinal_position: number;
    primary_key_ordinal: number | null;
  }>(
    `SELECT a.attname AS column_name,
            a.attnum::integer AS ordinal_position,
            pk.primary_key_ordinal
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN LATERAL (
         SELECT k.ordinality::integer AS primary_key_ordinal
           FROM pg_catalog.pg_index i,
                unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
          WHERE i.indrelid = c.oid AND i.indisprimary AND k.attnum = a.attnum
       ) pk ON true
      WHERE n.nspname = $1 AND c.relname = $2
        AND c.relkind = 'r' AND c.relpersistence = 'p'
        AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, table],
  );
  if (result.rows.length === 0) {
    fail(
      "PRODUCTION_BACKUP_RELATION_INVALID",
      `Frozen relation ${schema}.${table} is absent or unsupported.`,
    );
  }
  return Object.freeze(
    result.rows.map((row) => {
      if (!IDENTIFIER.test(row.column_name)) {
        fail(
          "PRODUCTION_BACKUP_RELATION_INVALID",
          `Relation ${schema}.${table} has a non-canonical column.`,
        );
      }
      return Object.freeze({
        name: row.column_name,
        ordinal: row.ordinal_position,
        primaryKeyOrdinal: row.primary_key_ordinal,
      });
    }),
  );
}

export async function measureProductionExact0096Relations(
  client: SnapshotQueryClient,
  relationNames: readonly string[],
  options: {
    signal: AbortSignal;
    fetchRows?: number;
  },
): Promise<
  Readonly<
    Record<string, Readonly<{ rowCount: number; contentSha256: string }>>
  >
> {
  const names = [...relationNames];
  if (
    names.length === 0 ||
    new Set(names).size !== names.length ||
    names.some((name) => !RELATION.test(name)) ||
    options.signal.aborted
  ) {
    fail("PRODUCTION_BACKUP_RELATION_INVALID", "Relation manifest is invalid.");
  }
  const fetchRows = options.fetchRows ?? 256;
  if (!Number.isSafeInteger(fetchRows) || fetchRows < 1 || fetchRows > 4096) {
    fail("PRODUCTION_BACKUP_CURSOR_INVALID", "Cursor fetch size is invalid.");
  }
  const measured: Record<
    string,
    Readonly<{ rowCount: number; contentSha256: string }>
  > = {};
  await assertExactProductionRelationCatalog(client, names);
  for (const [relationIndex, relation] of names.entries()) {
    if (options.signal.aborted) throw options.signal.reason;
    const [schema, table] = relation.split(".");
    const columns = await readRelationColumns(client, schema, table);
    const primaryKey = columns
      .filter((column) => column.primaryKeyOrdinal !== null)
      .sort(
        (left, right) =>
          Number(left.primaryKeyOrdinal) - Number(right.primaryKeyOrdinal),
      );
    const sortColumns = primaryKey.length > 0 ? primaryKey : columns;
    const selected = columns
      .map((column) => quoteIdentifier(column.name))
      .join(",");
    const ordered = sortColumns
      .map(
        (column) =>
          `pg_catalog.to_jsonb(${quoteIdentifier(column.name)})::text COLLATE "C" ASC NULLS FIRST`,
      )
      .join(",");
    const canonicalProjection = `pg_catalog.json_build_array(${selected})::text`;
    const bounds = await client.query<{
      row_count: string;
      max_row_bytes: string;
      total_bytes: string;
    }>(
      `SELECT count(*)::text AS row_count,
              COALESCE(max(pg_catalog.octet_length(canonical_row)), 0)::text AS max_row_bytes,
              COALESCE(sum(pg_catalog.octet_length(canonical_row)), 0)::text AS total_bytes
         FROM (SELECT ${canonicalProjection} AS canonical_row
                 FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)}) bounded_rows`,
    );
    const declaredRowCount = Number(bounds.rows[0]?.row_count);
    const maxRowBytes = Number(bounds.rows[0]?.max_row_bytes);
    const totalBytes = Number(bounds.rows[0]?.total_bytes);
    if (
      !Number.isSafeInteger(declaredRowCount) ||
      declaredRowCount < 0 ||
      !Number.isSafeInteger(maxRowBytes) ||
      maxRowBytes < 0 ||
      maxRowBytes > MAX_CANONICAL_ROW_BYTES ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalBytes > MAX_CANONICAL_RELATION_BYTES
    ) {
      fail(
        "PRODUCTION_BACKUP_RELATION_BYTE_BOUND_EXCEEDED",
        `Relation ${relation} exceeds the reviewed canonical row or relation byte bound.`,
      );
    }
    const boundedFetchRows = Math.min(
      fetchRows,
      Math.max(
        1,
        Math.floor(MAX_CANONICAL_PAGE_BYTES / Math.max(1, maxRowBytes)),
      ),
    );
    const cursor = `production_backup_${relationIndex}`;
    await client.query(
      `DECLARE ${quoteIdentifier(cursor)} NO SCROLL CURSOR FOR SELECT ${canonicalProjection} AS canonical_row FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} ORDER BY ${ordered}`,
    );
    const digest = createHash("sha256");
    let rowCount = 0;
    try {
      while (true) {
        if (options.signal.aborted) throw options.signal.reason;
        const page = await client.query<{ canonical_row: string }>(
          `FETCH FORWARD ${boundedFetchRows} FROM ${quoteIdentifier(cursor)}`,
        );
        let pageBytes = 0;
        for (const row of page.rows) {
          if (typeof row.canonical_row !== "string") {
            fail(
              "PRODUCTION_BACKUP_ROW_VALUE_INVALID",
              `Relation ${relation} returned an invalid row projection.`,
            );
          }
          const canonical = `${canonicalizeProductionExact0096JsonText(row.canonical_row)}\n`;
          const canonicalBytes = Buffer.byteLength(canonical);
          pageBytes += canonicalBytes;
          if (
            canonicalBytes > MAX_CANONICAL_ROW_BYTES ||
            pageBytes > MAX_CANONICAL_PAGE_BYTES
          ) {
            fail(
              "PRODUCTION_BACKUP_RELATION_BYTE_BOUND_EXCEEDED",
              `Relation ${relation} exceeded the reviewed canonical row or page byte bound.`,
            );
          }
          digest.update(canonical);
          rowCount += 1;
          if (!Number.isSafeInteger(rowCount)) {
            fail("PRODUCTION_BACKUP_ROW_COUNT_INVALID", "Row count overflow.");
          }
        }
        if (page.rows.length < boundedFetchRows) break;
      }
    } finally {
      await client
        .query(`CLOSE ${quoteIdentifier(cursor)}`)
        .catch(() => undefined);
    }
    if (rowCount !== declaredRowCount) {
      fail(
        "PRODUCTION_BACKUP_RELATION_CHANGED",
        `Relation ${relation} changed while its exported snapshot was measured.`,
      );
    }
    measured[relation] = Object.freeze({
      rowCount,
      contentSha256: `sha256:${digest.digest("hex")}`,
    });
  }
  return Object.freeze(measured);
}

export type ProductionExact0096SnapshotArtifact = Readonly<{
  schemaVersion: "site-logbook.production-exact-0096-table-snapshot/v2";
  observedAt: string;
  transactionMode: "repeatable-read-read-only";
  exportedSnapshotUsed: true;
  exportedSnapshotIdPersisted: false;
  snapshotTokenSha256: string;
  catalogManifest: Readonly<Record<string, unknown>>;
  tableMeasurements: Readonly<
    Record<string, Readonly<{ rowCount: number; contentSha256: string }>>
  >;
  tableMeasurementsSha256: string;
  dataSnapshotSha256: string;
  unsupportedRelations: readonly [];
}>;

export class ProductionExact0096SnapshotSession {
  readonly snapshotTokenSha256: string;
  private closed = false;

  private constructor(
    private readonly client: SnapshotClient,
    private readonly exportedSnapshotId: string,
    private readonly signal: AbortSignal,
  ) {
    this.snapshotTokenSha256 = sha256(exportedSnapshotId);
  }

  static async open(
    databaseUrl: string,
    input: { signal: AbortSignal; queryTimeoutMs: number },
    dependencies: {
      clientFactory?: (
        databaseUrl: string,
        queryTimeoutMs: number,
      ) => SnapshotClient;
    } = {},
  ): Promise<ProductionExact0096SnapshotSession> {
    if (
      !databaseUrl ||
      input.signal.aborted ||
      !Number.isSafeInteger(input.queryTimeoutMs) ||
      input.queryTimeoutMs < 1
    ) {
      fail("PRODUCTION_BACKUP_SNAPSHOT_INVALID", "Snapshot input is invalid.");
    }
    const client = (
      dependencies.clientFactory ??
      ((connectionString, timeoutMs) => {
        return new pg.Client({
          application_name: "site-logbook-production-exact-0096-producer",
          connectionString,
          connectionTimeoutMillis: timeoutMs,
          query_timeout: timeoutMs,
          statement_timeout: timeoutMs,
        }) as unknown as SnapshotClient;
      })
    )(databaseUrl, input.queryTimeoutMs);
    try {
      await client.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET TRANSACTION DEFERRABLE");
      await client.query(
        "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
        [`${Math.min(input.queryTimeoutMs, 15 * 60_000)}ms`],
      );
      const exported = await client.query<{ snapshot_id: string }>(
        "SELECT pg_export_snapshot() AS snapshot_id",
      );
      const snapshotId = exported.rows[0]?.snapshot_id;
      if (!snapshotId || snapshotId.length > 256) {
        fail(
          "PRODUCTION_BACKUP_SNAPSHOT_INVALID",
          "PostgreSQL did not export one bounded snapshot token.",
        );
      }
      return new ProductionExact0096SnapshotSession(
        client,
        snapshotId,
        input.signal,
      );
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  }

  async measure(
    manifest: Readonly<{
      relationNames: readonly string[];
      relationNamesSha256: string;
      [key: string]: unknown;
    }>,
    now: () => Date = () => new Date(),
  ): Promise<ProductionExact0096SnapshotArtifact> {
    if (this.closed || this.signal.aborted) {
      fail("PRODUCTION_BACKUP_SNAPSHOT_INVALID", "Snapshot session is closed.");
    }
    const tableMeasurements = await measureProductionExact0096Relations(
      this.client,
      manifest.relationNames,
      { signal: this.signal },
    );
    const tableMeasurementsSha256 = sha256(canonicalJson(tableMeasurements));
    const dataSnapshotSha256 = sha256(
      canonicalJson({
        relationNamesSha256: manifest.relationNamesSha256,
        tableMeasurementsSha256,
      }),
    );
    return Object.freeze({
      schemaVersion: "site-logbook.production-exact-0096-table-snapshot/v2",
      observedAt: now().toISOString(),
      transactionMode: "repeatable-read-read-only",
      exportedSnapshotUsed: true,
      exportedSnapshotIdPersisted: false,
      snapshotTokenSha256: this.snapshotTokenSha256,
      catalogManifest: Object.freeze({ ...manifest }),
      tableMeasurements,
      tableMeasurementsSha256,
      dataSnapshotSha256,
      unsupportedRelations: Object.freeze([]) as readonly [],
    });
  }

  async createEncryptedDump(
    input: Omit<
      Parameters<typeof createProductionExact0096EncryptedPgDump>[0],
      "exportedSnapshotId"
    >,
    dependencies: Parameters<
      typeof createProductionExact0096EncryptedPgDump
    >[1] = {},
  ): Promise<ProductionExact0096EncryptedDump> {
    if (this.closed || this.signal.aborted || input.signal !== this.signal) {
      fail(
        "PRODUCTION_BACKUP_SNAPSHOT_INVALID",
        "Dump must use the live session AbortSignal.",
      );
    }
    return createProductionExact0096EncryptedPgDump(
      { ...input, exportedSnapshotId: this.exportedSnapshotId },
      dependencies,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.query("ROLLBACK").catch(() => undefined);
    await this.client.end();
  }
}

class ByteCeilingAndDigest extends Transform {
  readonly digest = createHash("sha256");
  bytes = 0;

  constructor(
    private readonly ceilingBytes: number,
    private readonly abortProducer: () => void,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const next = this.bytes + bytes.length;
    if (next > this.ceilingBytes) {
      this.bytes = this.ceilingBytes + 1;
      this.abortProducer();
      callback(
        new ProductionExact0096ProducerError(
          "PRODUCTION_BACKUP_STREAMING_OVERFLOW_REJECTED",
          "Producer exceeded the approved byte ceiling.",
        ),
      );
      return;
    }
    this.bytes = next;
    this.digest.update(bytes);
    callback(null, bytes);
  }
}

function mve1Aad(
  kind: "data" | "wrap",
  context: string,
  keyId?: string,
): Buffer {
  return Buffer.from(`modvolt:mve1:${kind}:${keyId ?? "-"}:${context}`, "utf8");
}

function encryptWrappedKey(
  dataKey: Buffer,
  context: string,
  keyring: EncryptionKeyring,
): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const kek = keyring.keys.get(keyring.activeKeyId);
  if (!kek)
    fail("PRODUCTION_BACKUP_KEYRING_INVALID", "Active backup key absent.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_GCM, kek, iv);
  cipher.setAAD(mve1Aad("wrap", context, keyring.activeKeyId));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function pgDumpEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail(
      "PRODUCTION_BACKUP_DUMP_INPUT_INVALID",
      "Database connection is not a valid PostgreSQL URL.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.pathname.slice(1) ||
    parsed.hash
  ) {
    fail(
      "PRODUCTION_BACKUP_DUMP_INPUT_INVALID",
      "Database URL shape is not supported by the exact producer.",
    );
  }
  const sslMode = parsed.searchParams.get("sslmode");
  if (
    [...parsed.searchParams.keys()].some((key) => key !== "sslmode") ||
    (sslMode !== null &&
      !["disable", "require", "verify-ca", "verify-full"].includes(sslMode))
  ) {
    fail(
      "PRODUCTION_BACKUP_DUMP_INPUT_INVALID",
      "Database URL contains an unreviewed connection option.",
    );
  }
  return {
    PATH: process.env.PATH,
    Path: process.env.Path,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    ...(sslMode === null ? {} : { PGSSLMODE: sslMode }),
  };
}

async function waitForChild(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const stderrStream = child.stderr;
  if (!stderrStream) {
    fail("PRODUCTION_BACKUP_PG_DUMP_FAILED", "pg_dump stderr is unavailable.");
  }
  stderrStream.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(stderr) >= MAX_STDERR_BYTES) return;
    const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr);
    stderr += chunk.subarray(0, remaining).toString("utf8");
  });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function childSettledWithin(
  childResult: Promise<{ code: number; stderr: string }>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      childResult.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateChildBounded(
  child: ReturnType<typeof spawn> | undefined,
  childResult: Promise<{ code: number; stderr: string }> | undefined,
): Promise<void> {
  if (!child || !childResult) return;
  child.kill("SIGTERM");
  if (await childSettledWithin(childResult, CHILD_TERM_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (!(await childSettledWithin(childResult, CHILD_KILL_GRACE_MS))) {
    fail(
      "PRODUCTION_BACKUP_PG_DUMP_TERMINATION_FAILED",
      "pg_dump did not close after bounded TERM and KILL grace periods.",
    );
  }
}

async function writeExactMve1Envelope(
  ciphertextPath: string,
  destinationPath: string,
  header: Record<string, string>,
  signal: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(MVE1_MAGIC.length + 4 + encodedHeader.length);
  MVE1_MAGIC.copy(prefix, 0);
  prefix.writeUInt32BE(encodedHeader.length, MVE1_MAGIC.length);
  encodedHeader.copy(prefix, MVE1_MAGIC.length + 4);
  const handle = await open(destinationPath, "wx", 0o600);
  try {
    await handle.write(prefix);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const digest = createHash("sha256").update(prefix);
  let bytes = prefix.length;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(ciphertextPath),
    meter,
    createWriteStream(destinationPath, { flags: "a", mode: 0o600 }),
    { signal },
  );
  return { bytes, sha256: `sha256:${digest.digest("hex")}` };
}

export type ProductionExact0096EncryptedDump = Readonly<{
  directory: string;
  encryptedPath: string;
  dumpId: string;
  completedAt: string;
  plaintextBytes: number;
  plaintextSha256: string;
  encryptedPayloadBytes: number;
  encryptedPayloadSha256: string;
  envelopeKeyId: string;
}>;

export async function createProductionExact0096EncryptedPgDump(
  input: {
    databaseUrl: string;
    exportedSnapshotId: string;
    dumpId?: string;
    ceilingBytes: number;
    signal: AbortSignal;
    now?: () => Date;
    pgDumpPath?: string;
  },
  dependencies: {
    spawnProcess?: typeof spawn;
    keyring?: EncryptionKeyring;
  } = {},
): Promise<ProductionExact0096EncryptedDump> {
  if (
    !input.databaseUrl ||
    !input.exportedSnapshotId ||
    (input.dumpId !== undefined &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.dumpId)) ||
    !Number.isSafeInteger(input.ceilingBytes) ||
    input.ceilingBytes < 4096 ||
    input.signal.aborted
  ) {
    fail("PRODUCTION_BACKUP_DUMP_INPUT_INVALID", "Dump input is invalid.");
  }
  const directory = await mkdtemp(join(tmpdir(), "production-exact-0096-"));
  const ciphertextPath = join(directory, "dump.ciphertext");
  const encryptedPath = join(directory, "dump.mve1");
  const dumpId = input.dumpId ?? `prod-dump-${randomUUID()}`;
  const context = `production-exact-0096:${dumpId}:pg_dump`;
  let dataKey: Buffer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let childResult: Promise<{ code: number; stderr: string }> | undefined;
  try {
    const keyring =
      dependencies.keyring ??
      loadEncryptionKeyring(BACKUP_KEYRING_ENV, BACKUP_ACTIVE_KEY_ENV);
    dataKey = randomBytes(32);
    const dataIv = randomBytes(IV_BYTES);
    const wrapped = encryptWrappedKey(dataKey, context, keyring);
    const headerShapeBytes = Buffer.byteLength(
      JSON.stringify({
        k: keyring.activeKeyId,
        wi: wrapped.iv.toString("base64url"),
        wt: wrapped.tag.toString("base64url"),
        wk: wrapped.ciphertext.toString("base64url"),
        di: dataIv.toString("base64url"),
        dt: Buffer.alloc(16).toString("base64url"),
      }),
    );
    const plaintextCeiling =
      input.ceilingBytes - MVE1_MAGIC.length - 4 - headerShapeBytes;
    if (plaintextCeiling < 1) {
      fail(
        "PRODUCTION_BACKUP_DUMP_INPUT_INVALID",
        "Payload ceiling cannot contain the MVE1 envelope.",
      );
    }
    const dataCipher = createCipheriv(AES_GCM, dataKey, dataIv);
    dataCipher.setAAD(mve1Aad("data", context));
    child = (dependencies.spawnProcess ?? spawn)(
      input.pgDumpPath ?? process.env.PG_DUMP_PATH ?? "pg_dump",
      [
        "--no-owner",
        "--no-acl",
        `--snapshot=${input.exportedSnapshotId}`,
        "--format=custom",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: pgDumpEnvironment(input.databaseUrl),
        windowsHide: true,
      },
    );
    if (!child.stdout || !child.stderr) {
      fail(
        "PRODUCTION_BACKUP_PG_DUMP_FAILED",
        "pg_dump pipes are unavailable.",
      );
    }
    childResult = waitForChild(child);
    const meter = new ByteCeilingAndDigest(plaintextCeiling, () => {
      child?.kill("SIGTERM");
    });
    await pipeline(
      child.stdout,
      meter,
      dataCipher,
      createWriteStream(ciphertextPath, { flags: "wx", mode: 0o600 }),
      { signal: input.signal },
    );
    const exited = await childResult;
    if (exited.code !== 0) {
      fail(
        "PRODUCTION_BACKUP_PG_DUMP_FAILED",
        `pg_dump exited non-zero: ${exited.stderr.trim()}`,
      );
    }
    const header = {
      k: keyring.activeKeyId,
      wi: wrapped.iv.toString("base64url"),
      wt: wrapped.tag.toString("base64url"),
      wk: wrapped.ciphertext.toString("base64url"),
      di: dataIv.toString("base64url"),
      dt: dataCipher.getAuthTag().toString("base64url"),
    };
    const envelope = await writeExactMve1Envelope(
      ciphertextPath,
      encryptedPath,
      header,
      input.signal,
    );
    if (envelope.bytes > input.ceilingBytes) {
      fail(
        "PRODUCTION_BACKUP_STREAMING_OVERFLOW_REJECTED",
        "Encrypted MVE1 envelope exceeds the approved byte ceiling.",
      );
    }
    return Object.freeze({
      directory,
      encryptedPath,
      dumpId,
      completedAt: (input.now ?? (() => new Date()))().toISOString(),
      plaintextBytes: meter.bytes,
      plaintextSha256: `sha256:${meter.digest.digest("hex")}`,
      encryptedPayloadBytes: envelope.bytes,
      encryptedPayloadSha256: envelope.sha256,
      envelopeKeyId: keyring.activeKeyId,
    });
  } catch (error) {
    let terminationError: unknown;
    try {
      await terminateChildBounded(child, childResult);
    } catch (caught) {
      terminationError = caught;
    }
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    if (terminationError) throw terminationError;
    throw error;
  } finally {
    dataKey?.fill(0);
  }
}

export async function persistProductionExact0096EncryptedDump(
  dump: ProductionExact0096EncryptedDump,
  input: {
    key: string;
    signal: AbortSignal;
  },
  storage = new ObjectStorageService(),
): Promise<ProductionExactVersionedObjectHead> {
  const metadata = await stat(dump.encryptedPath);
  if (metadata.size !== dump.encryptedPayloadBytes || input.signal.aborted) {
    fail(
      "PRODUCTION_BACKUP_DUMP_STATE_INVALID",
      "Encrypted dump state changed.",
    );
  }
  return storage.putProductionExactVersionedBackup({
    key: input.key,
    body: createReadStream(dump.encryptedPath),
    contentLength: dump.encryptedPayloadBytes,
    encryptedPayloadSha256: dump.encryptedPayloadSha256,
    signal: input.signal,
  });
}

export async function disposeProductionExact0096EncryptedDump(
  dump: ProductionExact0096EncryptedDump,
): Promise<void> {
  await rm(dump.directory, { recursive: true, force: true });
}

function decodeMve1Base64(value: unknown, expectedBytes: number): Buffer {
  if (typeof value !== "string") {
    fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 field is absent.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length !== expectedBytes ||
    decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 field is not canonical.");
  }
  return decoded;
}

export async function streamDecryptProductionExact0096Mve1(
  input: {
    encrypted: Readable;
    destination: Writable;
    dumpId: string;
    encryptedPayloadBytes: number;
    encryptedPayloadSha256: string;
    plaintextCeilingBytes: number;
    signal: AbortSignal;
  },
  dependencies: { keyring?: EncryptionKeyring } = {},
): Promise<Readonly<{ plaintextBytes: number; plaintextSha256: string }>> {
  if (
    !Number.isSafeInteger(input.encryptedPayloadBytes) ||
    input.encryptedPayloadBytes < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(input.encryptedPayloadSha256) ||
    !Number.isSafeInteger(input.plaintextCeilingBytes) ||
    input.plaintextCeilingBytes < 1 ||
    input.signal.aborted
  ) {
    fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "Restore input is invalid.");
  }
  const directory = await mkdtemp(
    join(tmpdir(), "production-exact-0096-read-"),
  );
  const encryptedPath = join(directory, "dump.mve1");
  const authenticatedPlaintextPath = join(
    directory,
    "dump.authenticated.pgcustom",
  );
  const encryptedMeter = new ByteCeilingAndDigest(
    input.encryptedPayloadBytes,
    () => {
      if ("destroy" in input.encrypted) input.encrypted.destroy();
    },
  );
  try {
    await pipeline(
      input.encrypted,
      encryptedMeter,
      createWriteStream(encryptedPath, { flags: "wx", mode: 0o600 }),
      { signal: input.signal },
    );
    if (
      encryptedMeter.bytes !== input.encryptedPayloadBytes ||
      `sha256:${encryptedMeter.digest.digest("hex")}` !==
        input.encryptedPayloadSha256
    ) {
      fail(
        "PRODUCTION_BACKUP_ENVELOPE_INVALID",
        "Downloaded exact object bytes do not match evidence.",
      );
    }
    const handle = await open(encryptedPath, "r");
    let headerLength: number;
    let headerBytes: Buffer;
    try {
      const prefix = Buffer.alloc(8);
      const prefixRead = await handle.read(prefix, 0, prefix.length, 0);
      if (
        prefixRead.bytesRead !== prefix.length ||
        !prefix.subarray(0, 4).equals(MVE1_MAGIC)
      ) {
        fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 magic is invalid.");
      }
      headerLength = prefix.readUInt32BE(4);
      if (headerLength < 1 || headerLength > 4096) {
        fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 header is invalid.");
      }
      headerBytes = Buffer.alloc(headerLength);
      const headerRead = await handle.read(headerBytes, 0, headerLength, 8);
      if (headerRead.bytesRead !== headerLength) {
        fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 header is truncated.");
      }
    } finally {
      await handle.close();
    }
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 header is not JSON.");
    }
    if (
      JSON.stringify(Object.keys(header).sort()) !==
      JSON.stringify(["di", "dt", "k", "wi", "wk", "wt"])
    ) {
      fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 header fields differ.");
    }
    const keyId = header.k;
    if (typeof keyId !== "string") {
      fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 key id is invalid.");
    }
    const keyring =
      dependencies.keyring ??
      loadEncryptionKeyring(BACKUP_KEYRING_ENV, BACKUP_ACTIVE_KEY_ENV);
    const kek = keyring.keys.get(keyId);
    if (!kek) {
      fail("PRODUCTION_BACKUP_KEYRING_INVALID", "MVE1 key is unavailable.");
    }
    const context = `production-exact-0096:${input.dumpId}:pg_dump`;
    const wrappedKey = decodeMve1Base64(header.wk, 32);
    const wrapDecipher = createDecipheriv(
      AES_GCM,
      kek,
      decodeMve1Base64(header.wi, IV_BYTES),
    );
    wrapDecipher.setAAD(mve1Aad("wrap", context, keyId));
    wrapDecipher.setAuthTag(decodeMve1Base64(header.wt, 16));
    const dataKey = Buffer.concat([
      wrapDecipher.update(wrappedKey),
      wrapDecipher.final(),
    ]);
    wrappedKey.fill(0);
    try {
      if (dataKey.length !== 32) {
        fail("PRODUCTION_BACKUP_ENVELOPE_INVALID", "MVE1 data key is invalid.");
      }
      const decipher = createDecipheriv(
        AES_GCM,
        dataKey,
        decodeMve1Base64(header.di, IV_BYTES),
      );
      decipher.setAAD(mve1Aad("data", context));
      decipher.setAuthTag(decodeMve1Base64(header.dt, 16));
      const plaintextMeter = new ByteCeilingAndDigest(
        input.plaintextCeilingBytes,
        () => undefined,
      );
      await pipeline(
        createReadStream(encryptedPath, { start: 8 + headerLength }),
        decipher,
        plaintextMeter,
        createWriteStream(authenticatedPlaintextPath, {
          flags: "wx",
          mode: 0o600,
        }),
        { signal: input.signal },
      );
      // GCM authenticates only when the decipher reaches final(). Never expose
      // even partial plaintext to pg_restore/the caller before that succeeds.
      await pipeline(
        createReadStream(authenticatedPlaintextPath),
        input.destination,
        { signal: input.signal },
      );
      return Object.freeze({
        plaintextBytes: plaintextMeter.bytes,
        plaintextSha256: `sha256:${plaintextMeter.digest.digest("hex")}`,
      });
    } finally {
      dataKey.fill(0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
