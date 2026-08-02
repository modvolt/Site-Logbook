import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  parseLegacyPpeMaxAgeDays,
  type LegacyPpeMaxAgeDays,
} from "./public-token-preflight-policy";

type TokenAgeRisk = {
  active: number;
  olderThanPolicy: number;
  oldestAgeDays: number;
};

const args = process.argv.slice(2);
const confirmation = process.env.PUBLIC_TOKEN_PREFLIGHT_CONFIRM_ISOLATED;

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function databaseIdentity(): { database: string; hostname: string } {
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
  return { database, hostname: url.hostname.toLowerCase() };
}

function count(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Public token preflight returned invalid ${label}.`);
  }
  return parsed;
}

function assertIsolatedTarget(database: string, hostname: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing public token preflight with NODE_ENV=production.",
    );
  }
  if (confirmation !== "true") {
    throw new Error(
      "PUBLIC_TOKEN_PREFLIGHT_CONFIRM_ISOLATED=true is required.",
    );
  }
  if (
    !/(^|[_-])(stage|staging|test|qa|sandbox|preview)([_-]|$)/i.test(database)
  ) {
    throw new Error(
      "Database name must contain an isolated staging/test segment.",
    );
  }
  if (/(^|[_-])(prod|production|live)([_-]|$)/i.test(database)) {
    throw new Error("Refusing a production-like database name.");
  }
  if (hostname === "modvoltapp.cz" || hostname.endsWith(".modvoltapp.cz")) {
    throw new Error("Refusing the production application host.");
  }
}

async function loadRisk(maxAgeDays: LegacyPpeMaxAgeDays): Promise<{
  signature: TokenAgeRisk;
  confirmation: TokenAgeRisk;
}> {
  const result = await db.execute(sql`
    select
      count(*) filter (
        where signature_token is not null
          and employee_confirmed_at is null
      ) as signature_active,
      count(*) filter (
        where signature_token is not null
          and employee_confirmed_at is null
          and created_at < now() - (${maxAgeDays.ppe_signature} * interval '1 day')
      ) as signature_over_age,
      coalesce(max(greatest(0, floor(extract(epoch from (now() - created_at)) / 86400))) filter (
        where signature_token is not null
          and employee_confirmed_at is null
      ), 0) as signature_oldest_age_days,
      count(*) filter (
        where confirm_token is not null
          and employee_confirmed_at is null
          and (confirm_token_expires_at is null or confirm_token_expires_at > now())
      ) as confirmation_active,
      count(*) filter (
        where confirm_token is not null
          and employee_confirmed_at is null
          and (confirm_token_expires_at is null or confirm_token_expires_at > now())
          and coalesce(confirm_email_sent_at, created_at) < now() - (${maxAgeDays.ppe_confirmation} * interval '1 day')
      ) as confirmation_over_age,
      coalesce(max(greatest(0, floor(extract(epoch from (
        now() - coalesce(confirm_email_sent_at, created_at)
      )) / 86400))) filter (
        where confirm_token is not null
          and employee_confirmed_at is null
          and (confirm_token_expires_at is null or confirm_token_expires_at > now())
      ), 0) as confirmation_oldest_age_days
    from ppe_assignments
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Public token preflight returned no row.");
  return {
    signature: {
      active: count(row.signature_active, "signature active count"),
      olderThanPolicy: count(
        row.signature_over_age,
        "signature over-age count",
      ),
      oldestAgeDays: count(
        row.signature_oldest_age_days,
        "signature oldest age",
      ),
    },
    confirmation: {
      active: count(row.confirmation_active, "confirmation active count"),
      olderThanPolicy: count(
        row.confirmation_over_age,
        "confirmation over-age count",
      ),
      oldestAgeDays: count(
        row.confirmation_oldest_age_days,
        "confirmation oldest age",
      ),
    },
  };
}

async function main(): Promise<void> {
  const { database, hostname } = databaseIdentity();
  const expectedDatabase = argument("database");
  if (!expectedDatabase || expectedDatabase !== database) {
    throw new Error(
      "Preflight requires --database=<exact DATABASE_URL database name>.",
    );
  }
  assertIsolatedTarget(database, hostname);
  const maxAgeDays = parseLegacyPpeMaxAgeDays(args);
  const ppe = await loadRisk(maxAgeDays);
  const blocked =
    ppe.signature.olderThanPolicy + ppe.confirmation.olderThanPolicy > 0;

  console.log(
    JSON.stringify(
      {
        mode: "read-only",
        database,
        policy: { maxActiveLegacyPpeAgeDays: maxAgeDays },
        ppe,
        decision: blocked ? "BLOCK" : "PASS",
      },
      null,
      2,
    ),
  );
  if (blocked) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
