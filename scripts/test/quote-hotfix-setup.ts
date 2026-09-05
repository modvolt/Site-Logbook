import pg from "pg";
import {
  REQUIRED_TABLE_GRANTS,
  REQUIRED_SEQUENCE_GRANTS,
} from "../../lib/db/src/production-role-separation-contract";

const url = new URL(process.env.QUOTE_HOTFIX_ADMIN_URL ?? "");
if (
  url.hostname !== "127.0.0.1" ||
  !/^\/quote_hotfix_test(?:_|$)/.test(url.pathname) ||
  url.search !== "" ||
  !["postgresql:", "postgres:"].includes(url.protocol)
) {
  throw new Error(
    "Only the disposable loopback quote_hotfix_test database is allowed",
  );
}
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
await client.query(
  "CREATE ROLE quote_hotfix_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT",
);
await client.query(
  "GRANT USAGE ON SCHEMA public, drizzle TO quote_hotfix_runtime",
);
for (const grant of REQUIRED_TABLE_GRANTS) {
  if (grant.privileges.length)
    await client.query(
      `GRANT ${grant.privileges.join(",")} ON TABLE "${grant.schema}"."${grant.name}" TO quote_hotfix_runtime`,
    );
}
for (const grant of REQUIRED_SEQUENCE_GRANTS) {
  if (grant.privileges.length)
    await client.query(
      `GRANT ${grant.privileges.join(",")} ON SEQUENCE "${grant.schema}"."${grant.name}" TO quote_hotfix_runtime`,
    );
}
await client.end();
