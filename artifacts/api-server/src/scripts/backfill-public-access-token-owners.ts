import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type OwnershipPlan = {
  unowned: number;
  active: number;
  expired: number;
  terminal: number;
  partial: number;
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

function count(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Public token owner backfill returned invalid ${name}.`);
  }
  return parsed;
}

async function loadPlan(): Promise<OwnershipPlan> {
  const result = await db.execute(sql`
    select
      count(*) filter (
        where owner_kind is null
          and owner_user_id is null
          and owner_assigned_at is null
          and owner_assignment_source is null
      ) as unowned,
      count(*) filter (
        where owner_kind is null
          and owner_user_id is null
          and owner_assigned_at is null
          and owner_assignment_source is null
          and revoked_at is null
          and consumed_at is null
          and expires_at > now()
      ) as active,
      count(*) filter (
        where owner_kind is null
          and owner_user_id is null
          and owner_assigned_at is null
          and owner_assignment_source is null
          and revoked_at is null
          and consumed_at is null
          and expires_at <= now()
      ) as expired,
      count(*) filter (
        where owner_kind is null
          and owner_user_id is null
          and owner_assigned_at is null
          and owner_assignment_source is null
          and (revoked_at is not null or consumed_at is not null)
      ) as terminal,
      count(*) filter (
        where num_nonnulls(
          owner_kind,
          owner_user_id,
          owner_assigned_at,
          owner_assignment_source
        ) between 1 and 3
      ) as partial
    from public_access_tokens
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Public token owner backfill returned no row.");
  return {
    unowned: count(row.unowned, "unowned count"),
    active: count(row.active, "active count"),
    expired: count(row.expired, "expired count"),
    terminal: count(row.terminal, "terminal count"),
    partial: count(row.partial, "partial count"),
  };
}

async function main(): Promise<void> {
  const database = databaseName();
  const before = await loadPlan();
  if (!execute) {
    console.log(JSON.stringify({ mode: "dry-run", database, before }, null, 2));
    return;
  }
  if (argument("confirm") !== "ASSIGN_PUBLIC_TOKEN_ORGANIZATION_OWNER") {
    throw new Error(
      "Execution requires --confirm=ASSIGN_PUBLIC_TOKEN_ORGANIZATION_OWNER.",
    );
  }
  if (argument("database") !== database) {
    throw new Error(
      "Execution requires --database=<exact DATABASE_URL database name>.",
    );
  }
  if (before.partial !== 0) {
    throw new Error(
      `Execution refused: ${before.partial} token(s) have partial ownership metadata.`,
    );
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`lock table public_access_tokens in share row exclusive mode`,
    );
    await tx.execute(sql`
      update public_access_tokens
         set owner_kind = 'organization',
             owner_assigned_at = created_at,
             owner_assignment_source = 'legacy_organization_assignment'
       where owner_kind is null
         and owner_user_id is null
         and owner_assigned_at is null
         and owner_assignment_source is null
    `);
  });

  const after = await loadPlan();
  if (after.unowned !== 0 || after.partial !== 0) {
    throw new Error("Public token owner backfill did not reach a clean state.");
  }
  console.log(
    JSON.stringify(
      {
        mode: "execute",
        database,
        assigned: before.unowned,
        ownerKind: "organization",
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
