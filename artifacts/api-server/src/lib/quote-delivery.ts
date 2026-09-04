import pg from "pg";
import { randomUUID } from "node:crypto";
import { evidenceSha256 } from "./evidence-hash";
import { QuoteVersionError } from "./quote-version-service";
import { logger } from "./logger";

const SCOPE = "quote-delivery:v1";
const LOCK_NAMESPACE = 718205;
// Session locks must not occupy every connection needed by the workflow's DB
// transactions. Keep coordination bounded and separate from the application pool.
const deliveryPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  allowExitOnIdle: true,
});
deliveryPool.on("error", () => {
  logger.error({ component: "quote-delivery" }, "Idle delivery coordination connection lost");
});
export const deliveryUnknown = () =>
  new QuoteVersionError(
    409,
    "quote_delivery_unknown",
    "Výsledek odeslání není jistý. E-mail mohl SMTP server přijmout. Neopakujte jej automaticky; nejprve ověřte výsledek u správce pošty.",
  );

/** Uses the existing durable ledger. SMTP never runs inside a retried transaction. */
export async function withQuoteDelivery<T>(
  input: {
    quoteId: number;
    userId: number;
    key?: string;
    request: unknown;
  },
  action: (attempt: {
    id: number;
    beforeSmtp: (version: { id: number; version: number }) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const connection = await deliveryPool.connect();
  let locked = false;
  let attemptId: number | undefined;
  let smtpStarted = false;
  let broken = false;
  const connectionError = () => {
    broken = true;
  };
  connection.on("error", connectionError);
  try {
    const lock = await connection.query(
      "select pg_try_advisory_lock($1, $2) as locked",
      [LOCK_NAMESPACE, input.quoteId],
    );
    locked = lock.rows[0].locked;
    if (!locked)
      throw new QuoteVersionError(
        409,
        "quote_delivery_in_progress",
        "Nabídka se právě odesílá. Vyčkejte na výsledek.",
      );
    const key = input.key ?? randomUUID();
    const path = `/quotes/${input.quoteId}/send`;
    const hash = evidenceSha256(input.request);
    const previous = await connection.query(
      "select * from api_idempotency_records where user_id=$1 and offline_scope=$2 and method='POST' and path=$3 and idempotency_key=$4",
      [input.userId, SCOPE, path, key],
    );
    if (previous.rows[0]) {
      const row = previous.rows[0];
      if (row.request_hash !== hash)
        throw new QuoteVersionError(
          409,
          "quote_delivery_key_reused",
          "Tento pokus už patří jinému obsahu e-mailu. Otevřete nové odeslání.",
        );
      if (row.state !== "completed") throw deliveryUnknown();
      if (row.response_status !== 200)
        throw new QuoteVersionError(
          row.response_status,
          "quote_delivery_failed",
          row.response_body.error,
        );
      return row.response_body as T;
    }
    const inserted = await connection.query(
      "insert into api_idempotency_records (user_id,offline_scope,idempotency_key,method,path,request_hash,state) values ($1,$2,$3,'POST',$4,$5,'pending') returning id",
      [input.userId, SCOPE, key, path, hash],
    );
    attemptId = inserted.rows[0].id;
    const result = await action({
      id: attemptId!,
      beforeSmtp: async (version) => {
        if (broken)
          throw new Error("Delivery coordination connection lost before SMTP");
        await connection.query(
          "update api_idempotency_records set response_body=$2,last_seen_at=now() where id=$1 and state='pending'",
          [attemptId, JSON.stringify({ quoteVersion: version.version, versionId: version.id })],
        );
        smtpStarted = true;
      },
    });
    await connection.query(
      "update api_idempotency_records set state='completed',response_status=200,response_body=$2,completed_at=now(),last_seen_at=now() where id=$1",
      [attemptId, JSON.stringify(result)],
    );
    return result;
  } catch (error) {
    // Only explicit SMTP refusal (or failure before entering SMTP) is safe to classify as failed.
    const definite =
      !smtpStarted ||
      (error as { definitelyNotAccepted?: boolean }).definitelyNotAccepted ===
        true;
    if (attemptId) {
      const status = (error as { statusCode?: number }).statusCode ?? 502;
      const message =
        error instanceof QuoteVersionError
          ? error.message
          : "Odeslání nabídky selhalo před přijetím SMTP serverem.";
      try {
        await connection.query(
          "update api_idempotency_records set state=$2,response_status=$3,response_body=coalesce(response_body,'{}'::jsonb) || coalesce($4::jsonb,'{}'::jsonb),last_seen_at=now() where id=$1",
          [
            attemptId,
            definite ? "completed" : "ambiguous",
            definite ? status : null,
            definite ? JSON.stringify({ error: message }) : null,
          ],
        );
      } catch {
        logger.error(
          { quoteId: input.quoteId, attemptId },
          "Quote delivery outcome could not be recorded",
        );
      }
      if (!definite) {
        logger.error(
          { quoteId: input.quoteId, attemptId },
          "Quote SMTP outcome requires reconciliation; no automatic retry",
        );
        throw deliveryUnknown();
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await connection.query("select pg_advisory_unlock($1,$2)", [
          LOCK_NAMESPACE,
          input.quoteId,
        ]);
      } catch {
        broken = true;
      }
    }
    connection.removeListener("error", connectionError);
    connection.release(broken);
  }
}
