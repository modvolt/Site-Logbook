import pg, { type ClientConfig } from "pg";

const { Client } = pg;

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CLEANUP_WAIT_MS = 250;

interface ReadinessClient {
  connect(): Promise<unknown>;
  query(queryText: string): Promise<unknown>;
  end(): Promise<void>;
}

type ReadinessClientFactory = (config: ClientConfig) => ReadinessClient;

interface ProbeOptions {
  connectionString?: string;
  timeoutMs?: number;
  clientFactory?: ReadinessClientFactory;
}

function positiveTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Database readiness timeout must be a positive number.");
  }
  return Math.floor(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function closeClient(client: ReadinessClient, timeoutMs: number): Promise<void> {
  let closePromise: Promise<void>;
  try {
    closePromise = Promise.resolve(client.end()).catch(() => undefined);
  } catch {
    return;
  }

  await Promise.race([
    closePromise,
    delay(Math.min(MAX_CLEANUP_WAIT_MS, timeoutMs)),
  ]);
}

/**
 * Runs the readiness query on a short-lived, isolated connection.
 *
 * The application pool deliberately keeps its normal operational timeouts.
 * A separate client prevents a disconnected database from leaving health
 * requests queued in that pool and gives every recovery check a fresh socket.
 */
export async function probeDatabaseReadiness(
  options: ProbeOptions = {},
): Promise<number> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the database readiness probe.");
  }

  const timeoutMs = positiveTimeout(options.timeoutMs);
  const clientFactory =
    options.clientFactory ??
    ((config: ClientConfig) => new Client(config));
  const client = clientFactory({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
    application_name: "site-logbook-readiness",
  });
  const startedAt = Date.now();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new Error(`Database readiness probe timed out after ${timeoutMs} ms.`),
      );
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  const operation = (async () => {
    await client.connect();
    await client.query("SELECT 1");
  })();

  try {
    await Promise.race([operation, timeout]);
    return Date.now() - startedAt;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    await closeClient(client, timeoutMs);
  }
}
