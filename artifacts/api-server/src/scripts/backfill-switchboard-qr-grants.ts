import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { maximumSwitchboardQrExpiry } from "../lib/switchboard-qr";

type Plan = {
  enabled: number;
  activeWithoutOwner: number;
  activeWithoutExpiry: number;
  partialOwner: number;
};

const args = process.argv.slice(2);
const execute = args.includes("--execute");

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function databaseName(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must name a database.");
  return database;
}

function count(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Switchboard QR grant backfill returned invalid ${label}.`);
  }
  return parsed;
}

async function loadPlan(): Promise<Plan> {
  const result = await db.execute(sql`
    select
      count(*) filter (
        where qr_enabled = true
          and archived_at is null
          and qr_token_hash is not null
      ) as enabled,
      count(*) filter (
        where qr_enabled = true
          and archived_at is null
          and qr_token_hash is not null
          and (qr_expires_at is null or qr_expires_at > now())
          and qr_owner_kind is null
          and qr_owner_user_id is null
          and qr_owner_assigned_at is null
          and qr_owner_assignment_source is null
      ) as active_without_owner,
      count(*) filter (
        where qr_enabled = true
          and archived_at is null
          and qr_token_hash is not null
          and qr_expires_at is null
      ) as active_without_expiry,
      count(*) filter (
        where num_nonnulls(
          qr_owner_kind,
          qr_owner_user_id,
          qr_owner_assigned_at,
          qr_owner_assignment_source
        ) between 1 and 3
      ) as partial_owner
    from switchboards
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Switchboard QR grant backfill returned no row.");
  return {
    enabled: count(row.enabled, "enabled count"),
    activeWithoutOwner: count(
      row.active_without_owner,
      "active without owner count",
    ),
    activeWithoutExpiry: count(
      row.active_without_expiry,
      "active without expiry count",
    ),
    partialOwner: count(row.partial_owner, "partial owner count"),
  };
}

function legacyExpiry(now: Date, required: boolean): Date | null {
  const raw = argument("legacy-expires-at");
  if (!raw) {
    if (required) {
      throw new Error(
        "Active perpetual QR grants require --legacy-expires-at=<ISO date-time>.",
      );
    }
    return null;
  }
  const value = new Date(raw);
  if (
    !Number.isFinite(value.getTime()) ||
    value <= now ||
    value > maximumSwitchboardQrExpiry(now)
  ) {
    throw new Error(
      "Legacy QR expiry must be in the future and no more than five years away.",
    );
  }
  return value;
}

async function main(): Promise<void> {
  const database = databaseName();
  const before = await loadPlan();
  if (!execute) {
    console.log(JSON.stringify({ mode: "dry-run", database, before }, null, 2));
    return;
  }
  if (argument("confirm") !== "ASSIGN_SWITCHBOARD_QR_GRANTS") {
    throw new Error(
      "Execution requires --confirm=ASSIGN_SWITCHBOARD_QR_GRANTS.",
    );
  }
  if (argument("database") !== database) {
    throw new Error(
      "Execution requires --database=<exact DATABASE_URL database name>.",
    );
  }
  if (before.partialOwner !== 0) {
    throw new Error(
      `Execution refused: ${before.partialOwner} board(s) have partial QR ownership metadata.`,
    );
  }
  const now = new Date();
  const expiresAt = legacyExpiry(now, before.activeWithoutExpiry > 0);

  await db.transaction(async (tx) => {
    await tx.execute(sql`lock table switchboards in share row exclusive mode`);
    await tx.execute(sql`
      update switchboards
         set qr_owner_kind = 'resource',
             qr_owner_assigned_at = coalesce(qr_token_encrypted_at, created_at),
             qr_owner_assignment_source = 'legacy_resource_assignment'
       where qr_token_hash is not null
         and qr_owner_kind is null
         and qr_owner_user_id is null
         and qr_owner_assigned_at is null
         and qr_owner_assignment_source is null
    `);
    if (expiresAt) {
      await tx.execute(sql`
        update switchboards
           set qr_expires_at = ${expiresAt}
         where qr_enabled = true
           and archived_at is null
           and qr_token_hash is not null
           and qr_expires_at is null
      `);
    }
  });

  const after = await loadPlan();
  if (
    after.activeWithoutOwner !== 0 ||
    after.activeWithoutExpiry !== 0 ||
    after.partialOwner !== 0
  ) {
    throw new Error("Switchboard QR grant backfill did not reach a clean state.");
  }
  console.log(
    JSON.stringify(
      {
        mode: "execute",
        database,
        ownerKind: "resource",
        assignedLegacyExpiry: expiresAt?.toISOString() ?? null,
        before,
        after,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
