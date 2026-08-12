import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  auditChainHeadsTable,
  auditEventsTable,
  auditExportOutboxTable,
  db,
  pool,
} from "@workspace/db";
import {
  appendAuditEventInTransaction,
  canonicalAuditChainRecordJson,
  canonicalAuditExportIntentJson,
  createAuditChainRecord,
} from "../src/lib/audit-chain-contract";
import { createAuditChainDbAdapter } from "../src/lib/audit-chain-db-adapter";
import {
  auditProjectionSha256,
  canonicalAuditEventJson,
  createAuditEventEnvelope,
  type AuditEventInputV1,
} from "../src/lib/audit-event-envelope";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";

const EVENT_ID = "018f6f8e-7c20-7a4b-8c4d-1234567890d1";
const UNBOUND_EVENT_ID = "018f6f8e-7c20-7a4b-8c4d-1234567890d2";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_D = "d".repeat(64);

type MutableAuditEvent = {
  actor: { authentication: string };
  source: { component: string };
  action: { class: string };
  state: { before: { data: { notePresent?: boolean } | null } };
  integrity: { eventSha256: string };
  [key: string]: unknown;
};

type MutableLedger = {
  eventSha256: string;
  integrity: { ledgerSha256: string };
  [key: string]: unknown;
};
const rollbackSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../lib/db/rollbacks/0107_canonical_audit_evidence.down.sql",
  ),
  "utf8",
);

async function rejectionChain(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      if ("message" in current && typeof current.message === "string") {
        messages.push(current.message);
      }
      current = "cause" in current ? current.cause : null;
    }
    return messages.join("\ncaused by: ");
  }
  throw new Error("Expected the database operation to be rejected.");
}

async function waitForRollbackTableLock(
  backendPid: number,
  relation = "public.audit_chain_heads",
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      `select exists (
         select 1
         from pg_locks
         where pid = $1
           and relation = $2::regclass
           and mode = 'AccessExclusiveLock'
           and not granted
       ) as waiting`,
      [backendPid, relation],
    );
    if (result.rows[0]?.waiting) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Rollback did not wait on the writer's ${relation} lock.`);
}

function eventInput(eventId: string): AuditEventInputV1 {
  const before = { id: 123, notePresent: false };
  const after = { id: 123, notePresent: true };
  return {
    eventId,
    occurredAt: "2026-08-11T10:11:12.345Z",
    actor: {
      kind: "user",
      id: "user:42",
      authentication: "session",
      delegatedById: null,
    },
    source: {
      kind: "api",
      component: "api-server",
      operation: "job.note.update",
      buildRevision: "1".repeat(40),
      requestIdSha256: HASH_A,
    },
    action: { code: "job.note.update", outcome: "succeeded" },
    entity: { type: "job", id: "123", version: "7" },
    reason: { code: null, detailArtifactRef: null, detailSha256: null },
    state: {
      before: {
        availability: "present",
        completeness: "complete",
        projection: "job.audit/v1",
        data: before,
        sha256: auditProjectionSha256("job.audit/v1", before),
        missingFields: [],
        reason: null,
      },
      after: {
        availability: "present",
        completeness: "complete",
        projection: "job.audit/v1",
        data: after,
        sha256: auditProjectionSha256("job.audit/v1", after),
        missingFields: [],
        reason: null,
      },
    },
    correlation: {
      correlationIdSha256: HASH_A,
      causationEventSha256: null,
      idempotencyKeySha256: HASH_B,
    },
    artifactRefs: [],
  };
}

function absent(reason: "not-created" | "deleted") {
  return {
    availability: "absent" as const,
    completeness: "not-applicable" as const,
    projection: null,
    data: null,
    sha256: null,
    missingFields: [],
    reason,
  };
}

function notCaptured(reason: "operation-not-applied" | "not-applicable") {
  return {
    availability: "not-captured" as const,
    completeness: "not-applicable" as const,
    projection: null,
    data: null,
    sha256: null,
    missingFields: [],
    reason,
  };
}

function criticalInput(
  eventId: string,
  action: "external-account.grant" | "vault.credential.reveal",
): AuditEventInputV1 {
  const entityType =
    action === "external-account.grant"
      ? "external-account"
      : "device-credential";
  const input: AuditEventInputV1 = {
    ...eventInput(eventId),
    actor: {
      kind: "user",
      id: "user:42",
      authentication: "step-up",
      delegatedById: null,
    },
    source: {
      kind: "api",
      component: "api-server",
      operation: action,
      buildRevision: "1".repeat(40),
      requestIdSha256: HASH_A,
    },
    action: { code: action, outcome: "succeeded" },
    entity: { type: entityType, id: "9", version: "7" },
    reason: {
      code:
        action === "external-account.grant"
          ? "external-access-approved"
          : "credential-access-approved",
      detailArtifactRef: null,
      detailSha256: null,
    },
    state:
      action === "external-account.grant"
        ? {
            before: absent("not-created"),
            after: {
              availability: "present",
              completeness: "complete",
              projection: "critical-aggregate.audit/v1",
              data: {
                entityType,
                entityId: "9",
                aggregateVersion: "7",
                lifecycleState: "active",
                contentSha256: HASH_D,
                relationSetSha256: null,
              },
              sha256: auditProjectionSha256("critical-aggregate.audit/v1", {
                entityType,
                entityId: "9",
                aggregateVersion: "7",
                lifecycleState: "active",
                contentSha256: HASH_D,
                relationSetSha256: null,
              }),
              missingFields: [],
              reason: null,
            },
          }
        : {
            before: notCaptured("not-applicable"),
            after: notCaptured("not-applicable"),
          },
    correlation: {
      correlationIdSha256: HASH_A,
      causationEventSha256: null,
      idempotencyKeySha256: action === "external-account.grant" ? HASH_B : null,
    },
    artifactRefs: [
      {
        role: "approval",
        ref: "approval:7",
        sha256: HASH_A,
        byteLength: 64,
        mediaType: "application/json",
      },
    ],
  };
  if (action === "external-account.grant") {
    input.artifactRefs.push({
      role: "after-snapshot",
      ref: "snapshot:2",
      sha256: HASH_D,
      byteLength: 256,
      mediaType: "application/json",
    });
  }
  return input;
}

beforeAll(async () => {
  const installed = await pool.query<{ table_name: string | null }>(
    "select to_regclass('public.audit_events')::text as table_name",
  );
  if (installed.rows[0]?.table_name !== "audit_events") {
    throw new Error("R09 tests require the exact 0107 expand migration.");
  }
});

describe("R09 canonical audit evidence expand migration", () => {
  it("compiles qualified digest functions with fixed search_path and revoked public CREATE", async () => {
    const functions = await pool.query<{
      function_count: number;
      fixed_search_path: boolean;
    }>(`SELECT count(*)::integer AS function_count,
               bool_and(p.proconfig @> ARRAY['search_path=pg_catalog']::text[]) AS fixed_search_path
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND (p.proname LIKE 'audit\\_%' ESCAPE '\\'
             OR p.proname LIKE 'guard_audit\\_%' ESCAPE '\\'
             OR p.proname LIKE 'deny_audit\\_%' ESCAPE '\\')`);
    expect(functions.rows[0]).toEqual({
      function_count: 16,
      fixed_search_path: true,
    });
    const domain = "site-logbook.test/v1";
    const canonical = '{"ok":true}';
    const expected = createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from(domain),
          Buffer.from([0]),
          Buffer.from(canonical),
        ]),
      )
      .digest("hex");
    const digest = await pool.query<{ digest: string }>(
      "SELECT public.audit_domain_sha256($1, $2) AS digest",
      [domain, canonical],
    );
    expect(digest.rows[0]?.digest).toBe(expected);
    const privilege = await pool.query<{ public_can_create: boolean }>(
      "SELECT has_schema_privilege('public', 'public', 'CREATE') AS public_can_create",
    );
    expect(privilege.rows[0]?.public_can_create).toBe(false);
  });

  it("persists event, ledger, outbox and exact head CAS in one caller transaction", async () => {
    const envelope = createAuditEventEnvelope(eventInput(EVENT_ID));
    const result = await db.transaction((tx) =>
      appendAuditEventInTransaction(createAuditChainDbAdapter(tx), envelope),
    );

    const [eventRow] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.eventId, EVENT_ID));
    const [outboxRow] = await db
      .select()
      .from(auditExportOutboxTable)
      .where(eq(auditExportOutboxTable.intentId, EVENT_ID));
    const [headRow] = await db.select().from(auditChainHeadsTable);

    expect(eventRow).toMatchObject({
      eventId: EVENT_ID,
      sequence: BigInt(result.ledgerRecord.sequence),
      eventSha256: envelope.integrity.eventSha256,
      ledgerSha256: result.ledgerRecord.integrity.ledgerSha256,
    });
    expect(outboxRow).toMatchObject({
      intentId: EVENT_ID,
      eventId: EVENT_ID,
      state: "pending",
      attemptCount: 0,
      throughLedgerSha256: result.ledgerRecord.integrity.ledgerSha256,
    });
    expect(headRow).toMatchObject({
      sequence: BigInt(result.ledgerRecord.sequence),
      ledgerSha256: result.ledgerRecord.integrity.ledgerSha256,
    });

    const databaseDigests = await pool.query<{
      event_canonical: string;
      event_sha256: string;
      ledger_canonical: string;
      ledger_sha256: string;
      intent_canonical: string;
      intent_sha256: string;
    }>(
      `select
        audit_canonical_json($1::jsonb) as event_canonical,
        audit_domain_sha256(
          'site-logbook.audit-event/v1',
          audit_canonical_json(jsonb_set($1::jsonb, '{integrity,eventSha256}', 'null'::jsonb, false))
        ) as event_sha256,
        audit_canonical_json($2::jsonb) as ledger_canonical,
        audit_domain_sha256(
          'site-logbook.audit-chain-record/v1',
          audit_canonical_json(jsonb_set($2::jsonb, '{integrity,ledgerSha256}', 'null'::jsonb, false))
        ) as ledger_sha256,
        audit_canonical_json($3::jsonb) as intent_canonical,
        audit_domain_sha256(
          'site-logbook.audit-export-intent/v1',
          audit_canonical_json(jsonb_set($3::jsonb, '{integrity,intentSha256}', 'null'::jsonb, false))
        ) as intent_sha256`,
      [
        canonicalAuditEventJson(result.event),
        canonicalAuditChainRecordJson(result.ledgerRecord),
        canonicalAuditExportIntentJson(result.exportIntent),
      ],
    );
    expect(databaseDigests.rows[0]).toEqual({
      event_canonical: canonicalAuditEventJson(result.event),
      event_sha256: result.event.integrity.eventSha256,
      ledger_canonical: canonicalAuditChainRecordJson(result.ledgerRecord),
      ledger_sha256: result.ledgerRecord.integrity.ledgerSha256,
      intent_canonical: canonicalAuditExportIntentJson(result.exportIntent),
      intent_sha256: result.exportIntent.integrity.intentSha256,
    });

    const client = await pool.connect();
    try {
      await expect(client.query(rollbackSql)).rejects.toThrow(
        /0107 rollback blocked: canonical audit evidence/i,
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });

  it("accepts verified critical evidence with artifacts, absent and not-captured states", async () => {
    const grant = createAuditEventEnvelope(
      criticalInput(
        "018f6f8e-7c20-7a4b-8c4d-1234567890d4",
        "external-account.grant",
      ),
    );
    const reveal = createAuditEventEnvelope(
      criticalInput(
        "018f6f8e-7c20-7a4b-8c4d-1234567890d5",
        "vault.credential.reveal",
      ),
    );

    await db.transaction(async (tx) => {
      const adapter = createAuditChainDbAdapter(tx);
      await appendAuditEventInTransaction(adapter, grant);
      await appendAuditEventInTransaction(adapter, reveal);
    });

    const rows = await db
      .select({ eventId: auditEventsTable.eventId })
      .from(auditEventsTable)
      .where(
        sql`${auditEventsTable.eventId} in (${grant.eventId}, ${reveal.eventId})`,
      );
    expect(rows.map(({ eventId }) => eventId).sort()).toEqual(
      [grant.eventId, reveal.eventId].sort(),
    );
  });

  it("matches JS CJSON edge fixtures and rejects ambiguous JSON numbers", async () => {
    const fixtures: unknown[] = [
      {
        z: null,
        a: true,
        array: [null, false, "Příliš žluťoučký"],
        escaped: 'quote" slash\\ control\u0001',
        nested: { ž: "české", a: "ASCII-first" },
      },
      { minimum: -9_007_199_254_740_991, maximum: 9_007_199_254_740_991 },
    ];
    for (const fixture of fixtures) {
      const result = await pool.query<{ canonical: string }>(
        "select audit_canonical_json($1::jsonb) as canonical",
        [JSON.stringify(fixture)],
      );
      expect(result.rows[0]?.canonical).toBe(canonicalEvidenceJson(fixture));
    }

    await expect(
      pool.query("select audit_canonical_json('1.5'::jsonb)"),
    ).rejects.toThrow(/safe integer/i);
    await expect(
      pool.query("select audit_canonical_json('9007199254740992'::jsonb)"),
    ).rejects.toThrow(/safe integer/i);
    const exponent = await pool.query<{ canonical: string; exact: boolean }>(
      "select audit_canonical_json($1::jsonb) as canonical, audit_canonical_json($1::jsonb) = $2::text as exact",
      ["1e3", "1e3"],
    );
    expect(exponent.rows[0]).toEqual({ canonical: "1000", exact: false });
  });

  it("rejects raw missing, extra, empty and noncanonical event JSON", async () => {
    const envelope = createAuditEventEnvelope(
      eventInput("018f6f8e-7c20-7a4b-8c4d-1234567890d3"),
    );
    const [head] = await db.select().from(auditChainHeadsTable);
    const record = createAuditChainRecord(envelope, {
      streamId: "site-logbook:audit:global:v1",
      sequence: head!.sequence.toString(),
      ledgerSha256: head!.ledgerSha256,
    });
    const canonicalEvent = canonicalAuditEventJson(envelope);
    const canonicalLedger = canonicalAuditChainRecordJson(record);
    const parsedEvent = JSON.parse(canonicalEvent) as Record<string, unknown>;

    const insertRaw = (eventJson: string, ledgerJson = canonicalLedger) => {
      const eventDocument = JSON.parse(eventJson) as {
        integrity?: { eventSha256?: string };
      };
      const ledgerDocument = JSON.parse(ledgerJson) as {
        integrity?: { ledgerSha256?: string };
      };
      return pool.query(
        `insert into audit_events
          (event_id, stream_id, sequence, occurred_at, canonical_event_json,
           event_sha256, canonical_ledger_json, previous_ledger_sha256, ledger_sha256)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          envelope.eventId,
          record.streamId,
          record.sequence,
          envelope.occurredAt,
          eventJson,
          eventDocument.integrity?.eventSha256 ??
            envelope.integrity.eventSha256,
          ledgerJson,
          record.previousLedgerSha256,
          ledgerDocument.integrity?.ledgerSha256 ??
            record.integrity.ledgerSha256,
        ],
      );
    };

    const signMutation = (mutate: (document: MutableAuditEvent) => void) => {
      const eventDocument = structuredClone(parsedEvent) as MutableAuditEvent;
      mutate(eventDocument);
      eventDocument.integrity.eventSha256 = sha256Hex(
        `site-logbook.audit-event/v1\0${canonicalEvidenceJson({
          ...eventDocument,
          integrity: { ...eventDocument.integrity, eventSha256: null },
        })}`,
      );
      const ledgerDocument = JSON.parse(canonicalLedger) as MutableLedger;
      ledgerDocument.eventSha256 = eventDocument.integrity.eventSha256;
      ledgerDocument.integrity.ledgerSha256 = sha256Hex(
        `site-logbook.audit-chain-record/v1\0${canonicalEvidenceJson({
          ...ledgerDocument,
          integrity: { ...ledgerDocument.integrity, ledgerSha256: null },
        })}`,
      );
      return {
        eventJson: canonicalEvidenceJson(eventDocument),
        ledgerJson: canonicalEvidenceJson(ledgerDocument),
      };
    };

    expect(await rejectionChain(insertRaw("{}"))).toMatch(
      /shape|audit_events_event_shape_chk/i,
    );
    const missing = { ...parsedEvent };
    delete missing.correlation;
    expect(
      await rejectionChain(insertRaw(canonicalEvidenceJson(missing))),
    ).toMatch(/shape/i);
    expect(
      await rejectionChain(
        insertRaw(canonicalEvidenceJson({ ...parsedEvent, unexpected: true })),
      ),
    ).toMatch(/shape/i);
    expect(await rejectionChain(insertRaw(` ${canonicalEvent}`))).toMatch(
      /canonical bytes/i,
    );
    const reversed = JSON.stringify(
      Object.fromEntries(Object.entries(parsedEvent).reverse()),
    );
    expect(await rejectionChain(insertRaw(reversed))).toMatch(
      /canonical bytes/i,
    );
    for (const mutation of [
      signMutation((event) => {
        event.actor.authentication = "migration";
      }),
      signMutation((event) => {
        event.source.component = "api-worker";
      }),
      signMutation((event) => {
        event.action.class = "create";
      }),
      signMutation((event) => {
        if (event.state.before.data) {
          event.state.before.data.notePresent = true;
        }
      }),
    ]) {
      expect(
        await rejectionChain(
          insertRaw(mutation.eventJson, mutation.ledgerJson),
        ),
      ).toMatch(/core semantics/i);
    }
  });

  it("rejects a commit missing both the exact outbox and head advance", async () => {
    const envelope = createAuditEventEnvelope(eventInput(UNBOUND_EVENT_ID));
    const rejection = await rejectionChain(
      db.transaction(async (tx) => {
        const adapter = createAuditChainDbAdapter(tx);
        const head = await adapter.lockHeadForUpdate(
          "site-logbook:audit:global:v1",
        );
        await adapter.insertEventAndLedger(
          envelope,
          createAuditChainRecord(envelope, head),
        );
      }),
    );
    expect(rejection).toMatch(/requires its exact export intent/i);

    const remaining = await db
      .select({ eventId: auditEventsTable.eventId })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.eventId, UNBOUND_EVENT_ID));
    expect(remaining).toHaveLength(0);
  });

  it("waits for an in-flight writer and refuses to remove committed evidence", async () => {
    const concurrentEventId = "018f6f8e-7c20-7a4b-8c4d-1234567890d6";
    const envelope = createAuditEventEnvelope(eventInput(concurrentEventId));
    let announceInsert!: () => void;
    let releaseWriter!: () => void;
    const inserted = new Promise<void>((resolvePromise) => {
      announceInsert = resolvePromise;
    });
    const release = new Promise<void>((resolvePromise) => {
      releaseWriter = resolvePromise;
    });
    const writer = db.transaction(async (tx) => {
      await appendAuditEventInTransaction(
        createAuditChainDbAdapter(tx),
        envelope,
      );
      announceInsert();
      await release;
    });

    await inserted;
    const rollbackClient = await pool.connect();
    let writerReleased = false;
    try {
      const backend = await rollbackClient.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const rollbackOutcome = rollbackClient.query(rollbackSql).then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForRollbackTableLock(backend.rows[0]!.pid);
      releaseWriter();
      writerReleased = true;
      await writer;

      const outcome = await rollbackOutcome;
      expect(outcome.ok).toBe(false);
      expect(
        outcome.error instanceof Error
          ? `${outcome.error.message}\n${String(outcome.error.cause ?? "")}`
          : String(outcome.error),
      ).toMatch(/0107 rollback blocked: canonical audit evidence/i);

      const persisted = await db
        .select({ eventId: auditEventsTable.eventId })
        .from(auditEventsTable)
        .where(eq(auditEventsTable.eventId, concurrentEventId));
      expect(persisted).toEqual([{ eventId: concurrentEventId }]);
    } finally {
      if (!writerReleased) releaseWriter();
      await writer.catch(() => undefined);
      await rollbackClient.query("rollback").catch(() => undefined);
      rollbackClient.release();
    }
  });

  it("locks the migration journal against a concurrent direct lineage insert", async () => {
    const decoyHash = "f".repeat(64);
    const writerClient = await pool.connect();
    const rollbackClient = await pool.connect();
    let writerCommitted = false;
    try {
      await writerClient.query("begin");
      await writerClient.query(
        "insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)",
        [decoyHash, 1786484628859],
      );
      const backend = await rollbackClient.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );
      const rollbackOutcome = rollbackClient.query(rollbackSql).then(
        () => ({ ok: true as const, error: null }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitForRollbackTableLock(
        backend.rows[0]!.pid,
        "drizzle.__drizzle_migrations",
      );
      await writerClient.query("commit");
      writerCommitted = true;

      const outcome = await rollbackOutcome;
      expect(outcome.ok).toBe(false);
      expect(
        outcome.error instanceof Error
          ? `${outcome.error.message}\n${String(outcome.error.cause ?? "")}`
          : String(outcome.error),
      ).toMatch(/0107 rollback blocked: canonical audit evidence/i);
      const retained = await pool.query<{ count: number }>(
        `select count(*)::integer as count
           from drizzle.__drizzle_migrations
          where created_at = 1786484628859 and hash = $1`,
        [decoyHash],
      );
      expect(retained.rows[0]?.count).toBe(1);
    } finally {
      if (!writerCommitted)
        await writerClient.query("rollback").catch(() => undefined);
      await rollbackClient.query("rollback").catch(() => undefined);
      writerClient.release();
      rollbackClient.release();
      await pool.query(
        "delete from drizzle.__drizzle_migrations where created_at = 1786484628859 and hash = $1",
        [decoyHash],
      );
    }
  });

  it("rejects event tamper, head drift and unsafe outbox state transitions", async () => {
    expect(
      await rejectionChain(
        db
          .update(auditEventsTable)
          .set({ canonicalEventJson: '{"tampered":true}' })
          .where(eq(auditEventsTable.eventId, EVENT_ID)),
      ),
    ).toMatch(/immutable/i);

    expect(
      await rejectionChain(
        db
          .update(auditChainHeadsTable)
          .set({ sequence: sql`${auditChainHeadsTable.sequence} + 2` }),
      ),
    ).toMatch(/exactly one record/i);

    const leaseToken = "018f6f8e-7c20-7a4b-8c4d-1234567890e1";
    await db
      .update(auditExportOutboxTable)
      .set({
        state: "exporting",
        attemptCount: 1,
        leaseToken,
        leaseExpiresAt: new Date("2042-03-04T10:00:00.000Z"),
        updatedAt: new Date("2042-03-04T09:00:00.000Z"),
      })
      .where(eq(auditExportOutboxTable.intentId, EVENT_ID));
    expect(
      await rejectionChain(
        db
          .update(auditExportOutboxTable)
          .set({
            state: "exporting",
            leaseToken: "018f6f8e-7c20-7a4b-8c4d-1234567890e2",
            leaseExpiresAt: new Date("2042-03-04T10:01:00.000Z"),
            updatedAt: new Date("2042-03-04T09:00:30.000Z"),
          })
          .where(eq(auditExportOutboxTable.intentId, EVENT_ID)),
      ),
    ).toMatch(/lease renewal is not supported/i);
    expect(
      await rejectionChain(
        db
          .update(auditExportOutboxTable)
          .set({
            state: "exported",
            leaseToken: null,
            leaseExpiresAt: null,
            objectKey: null,
            objectVersionId: null,
            objectSha256: null,
            exportedAt: new Date("2042-03-04T09:00:45.000Z"),
            updatedAt: new Date("2042-03-04T09:00:45.000Z"),
          })
          .where(eq(auditExportOutboxTable.intentId, EVENT_ID)),
      ),
    ).toMatch(/audit_export_outbox_terminal_chk/i);
    await db
      .update(auditExportOutboxTable)
      .set({
        state: "pending",
        availableAt: new Date("2042-03-04T10:01:00.000Z"),
        leaseToken: null,
        leaseExpiresAt: null,
        updatedAt: new Date("2042-03-04T09:01:00.000Z"),
      })
      .where(eq(auditExportOutboxTable.intentId, EVENT_ID));
    expect(
      await rejectionChain(
        db
          .update(auditExportOutboxTable)
          .set({
            state: "exported",
            objectKey: `audit-evidence/v1/${EVENT_ID}/${"0".repeat(64)}/audit.jsonl`,
            objectVersionId: "provider-version",
            objectSha256: "c".repeat(64),
            exportedAt: new Date("2042-03-04T09:02:00.000Z"),
            updatedAt: new Date("2042-03-04T09:02:00.000Z"),
          })
          .where(eq(auditExportOutboxTable.intentId, EVENT_ID)),
      ),
    ).toMatch(/claimed before transition/i);
  });
});
