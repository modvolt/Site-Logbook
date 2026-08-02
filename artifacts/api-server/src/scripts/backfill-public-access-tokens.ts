import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Counts = {
  jobSignature: number;
  ppeSignature: number;
  ppeConfirmation: number;
  quoteDecision: number;
};

type Plan = {
  plaintext: Counts;
  unmatched: Counts;
};

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const confirmation = [...args]
  .find((arg) => arg.startsWith("--confirm="))
  ?.slice(10);
const expectedDatabase = [...args]
  .find((arg) => arg.startsWith("--database="))
  ?.slice(11);

function databaseName(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required.");
  try {
    return decodeURIComponent(new URL(raw).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL is invalid.");
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Public token backfill returned an invalid count.");
  }
  return parsed;
}

async function loadPlan(): Promise<Plan> {
  const result = await db.execute(sql`
    select
      (select count(*) from jobs where signature_token is not null) as job_plaintext,
      (select count(*) from ppe_assignments where signature_token is not null) as ppe_signature_plaintext,
      (select count(*) from ppe_assignments where confirm_token is not null) as ppe_confirmation_plaintext,
      (select count(*) from quotes where share_token is not null) as quote_plaintext,
      (select count(*) from jobs legacy where legacy.signature_token is not null and not exists (
        select 1 from public_access_tokens token
        where token.purpose = 'job_signature'
          and token.resource_type = 'job'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.signature_token, 'UTF8')), 'hex')
      )) as job_unmatched,
      (select count(*) from ppe_assignments legacy where legacy.signature_token is not null and not exists (
        select 1 from public_access_tokens token
        where token.purpose = 'ppe_signature'
          and token.resource_type = 'ppe_assignment'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.signature_token, 'UTF8')), 'hex')
      )) as ppe_signature_unmatched,
      (select count(*) from ppe_assignments legacy where legacy.confirm_token is not null and not exists (
        select 1 from public_access_tokens token
        where token.purpose = 'ppe_confirmation'
          and token.resource_type = 'ppe_assignment'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.confirm_token, 'UTF8')), 'hex')
      )) as ppe_confirmation_unmatched,
      (select count(*) from quotes legacy where legacy.share_token is not null and not exists (
        select 1 from public_access_tokens token
        where token.purpose = 'quote_decision'
          and token.resource_type = 'quote'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.share_token, 'UTF8')), 'hex')
      )) as quote_unmatched
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Public token backfill plan returned no row.");
  return {
    plaintext: {
      jobSignature: numberValue(row.job_plaintext),
      ppeSignature: numberValue(row.ppe_signature_plaintext),
      ppeConfirmation: numberValue(row.ppe_confirmation_plaintext),
      quoteDecision: numberValue(row.quote_plaintext),
    },
    unmatched: {
      jobSignature: numberValue(row.job_unmatched),
      ppeSignature: numberValue(row.ppe_signature_unmatched),
      ppeConfirmation: numberValue(row.ppe_confirmation_unmatched),
      quoteDecision: numberValue(row.quote_unmatched),
    },
  };
}

function total(counts: Counts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

async function main(): Promise<void> {
  const database = databaseName();
  const plan = await loadPlan();
  if (!execute) {
    console.log(JSON.stringify({ mode: "dry-run", database, ...plan }, null, 2));
    return;
  }
  if (confirmation !== "CLEAR_PUBLIC_TOKEN_PLAINTEXT") {
    throw new Error(
      "Execution requires --confirm=CLEAR_PUBLIC_TOKEN_PLAINTEXT.",
    );
  }
  if (!expectedDatabase || expectedDatabase !== database) {
    throw new Error(
      "Execution requires --database=<exact DATABASE_URL database name>.",
    );
  }
  if (total(plan.unmatched) !== 0) {
    throw new Error(
      `Execution refused: ${total(plan.unmatched)} plaintext token(s) have no exact hash record.`,
    );
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`lock table public_access_tokens in share row exclusive mode`);
    await tx.execute(sql`
      update jobs as legacy set signature_token = null
      where legacy.signature_token is not null and exists (
        select 1 from public_access_tokens token
        where token.purpose = 'job_signature'
          and token.resource_type = 'job'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.signature_token, 'UTF8')), 'hex')
      )
    `);
    await tx.execute(sql`
      update ppe_assignments as legacy set signature_token = null
      where legacy.signature_token is not null and exists (
        select 1 from public_access_tokens token
        where token.purpose = 'ppe_signature'
          and token.resource_type = 'ppe_assignment'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.signature_token, 'UTF8')), 'hex')
      )
    `);
    await tx.execute(sql`
      update ppe_assignments as legacy set confirm_token = null
      where legacy.confirm_token is not null and exists (
        select 1 from public_access_tokens token
        where token.purpose = 'ppe_confirmation'
          and token.resource_type = 'ppe_assignment'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.confirm_token, 'UTF8')), 'hex')
      )
    `);
    await tx.execute(sql`
      update quotes as legacy set share_token = null
      where legacy.share_token is not null and exists (
        select 1 from public_access_tokens token
        where token.purpose = 'quote_decision'
          and token.resource_type = 'quote'
          and token.resource_id = legacy.id
          and token.token_hash = encode(sha256(convert_to(legacy.share_token, 'UTF8')), 'hex')
      )
    `);
  });

  const remaining = await loadPlan();
  if (total(remaining.plaintext) !== 0 || total(remaining.unmatched) !== 0) {
    throw new Error("Public token plaintext cleanup did not reach zero.");
  }
  console.log(JSON.stringify({
    mode: "execute",
    database,
    cleared: plan.plaintext,
    remaining: remaining.plaintext,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
