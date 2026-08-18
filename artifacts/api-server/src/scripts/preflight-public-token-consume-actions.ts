import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type InvalidConsumeActionGroup = {
  purpose: string;
  consumeAction: string | null;
  consumed: boolean;
  count: number;
};

const args = process.argv.slice(2);

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

function safeCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Consume-action preflight returned an invalid count.");
  }
  return parsed;
}

async function loadInvalidGroups(): Promise<InvalidConsumeActionGroup[]> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return tx.execute(sql`
      select
        purpose,
        consume_action,
        consumed_at is not null as consumed,
        count(*) as violations
      from public_access_tokens
      where not (
        (consumed_at is null and consume_action is null) or
        (
          consumed_at is not null and (
            (purpose in ('job_signature', 'ppe_signature') and consume_action = 'signed') or
            (purpose = 'ppe_confirmation' and consume_action = 'confirmed') or
            (purpose = 'quote_decision' and consume_action in ('accepted', 'rejected'))
          )
        )
      )
      group by purpose, consume_action, consumed_at is not null
      order by purpose, consume_action nulls first, consumed_at is not null
    `);
  });

  return result.rows.map((row) => {
    if (typeof row.purpose !== "string") {
      throw new Error("Consume-action preflight returned an invalid purpose.");
    }
    if (row.consume_action !== null && typeof row.consume_action !== "string") {
      throw new Error("Consume-action preflight returned an invalid action.");
    }
    if (typeof row.consumed !== "boolean") {
      throw new Error("Consume-action preflight returned an invalid terminal state.");
    }
    return {
      purpose: row.purpose,
      consumeAction: row.consume_action,
      consumed: row.consumed,
      count: safeCount(row.violations),
    };
  });
}

async function main(): Promise<void> {
  const database = databaseName();
  if (argument("database") !== database) {
    throw new Error(
      "Preflight requires --database=<exact DATABASE_URL database name>.",
    );
  }

  const invalidGroups = await loadInvalidGroups();
  const invalidCount = invalidGroups.reduce((sum, group) => sum + group.count, 0);
  const blocked = invalidCount > 0;
  console.log(JSON.stringify({
    mode: "read-only",
    database,
    check: "public_access_tokens_consume_action_by_purpose",
    invalidCount,
    invalidGroups,
    decision: blocked ? "BLOCK" : "PASS",
  }, null, 2));
  if (blocked) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
