import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { logger } from "./logger";
import type { OperationalAlertTransition } from "./operational-alert-policy";

export type OperationalAlertTransportMode =
  | "local_log_only"
  | "local_log_and_https_webhook";

interface DisabledTransportConfig {
  mode: "disabled";
}

export interface HttpsWebhookTransportConfig {
  mode: "https_webhook";
  url: string;
  bearerToken: string;
  timeoutMs: number;
  cooldownMs: number;
}

export type OperationalAlertTransportConfig =
  | DisabledTransportConfig
  | HttpsWebhookTransportConfig;

export class OperationalAlertTransportConfigError extends Error {
  readonly code = "OPERATIONAL_ALERT_TRANSPORT_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "OperationalAlertTransportConfigError";
  }
}

function failConfig(message: string): never {
  throw new OperationalAlertTransportConfigError(message);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  variable: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    failConfig(`${variable} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function isPrivateIpv4(hostname: string): boolean {
  const [a, b, c] = hostname.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isPrivateIpLiteral(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (version === 4) return isPrivateIpv4(normalized);
  if (version !== 6) return false;

  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    /^fe[c-f]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return true;
  }
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  const mappedHex = normalized.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mappedHex) return false;
  const high = Number.parseInt(mappedHex[1], 16);
  const low = Number.parseInt(mappedHex[2], 16);
  return isPrivateIpv4(
    `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`,
  );
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function allowedWebhookHosts(raw: string | undefined): Set<string> {
  const hosts = (raw ?? "")
    .split(",")
    .map((host) => normalizeHostname(host.trim()))
    .filter(Boolean);
  if (hosts.length === 0 || hosts.some((host) => /[\/@?#]/.test(host))) {
    failConfig(
      "OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS must contain exact comma-separated hostnames.",
    );
  }
  return new Set(hosts);
}

function validateWebhookUrl(
  raw: string | undefined,
  allowedHosts: Set<string>,
): string {
  if (!raw?.trim())
    failConfig("OPERATIONAL_ALERT_WEBHOOK_URL is required when enabled.");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    failConfig("OPERATIONAL_ALERT_WEBHOOK_URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    failConfig("OPERATIONAL_ALERT_WEBHOOK_URL must use HTTPS.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    failConfig(
      "OPERATIONAL_ALERT_WEBHOOK_URL cannot contain credentials, a query, or a fragment.",
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    (isIP(hostname) === 0 && !hostname.includes(".")) ||
    isPrivateIpLiteral(hostname)
  ) {
    failConfig(
      "OPERATIONAL_ALERT_WEBHOOK_URL must target a public HTTPS host.",
    );
  }
  if (!allowedHosts.has(hostname)) {
    failConfig(
      "OPERATIONAL_ALERT_WEBHOOK_URL host must be explicitly allowlisted.",
    );
  }
  return parsed.toString();
}

export function loadOperationalAlertTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperationalAlertTransportConfig {
  const mode = (env.OPERATIONAL_ALERT_TRANSPORT ?? "disabled")
    .trim()
    .toLowerCase();
  if (mode === "" || mode === "disabled") return { mode: "disabled" };
  if (mode !== "https_webhook") {
    failConfig(
      'OPERATIONAL_ALERT_TRANSPORT must be "disabled" or "https_webhook".',
    );
  }

  const bearerToken = env.OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{43,}$/.test(bearerToken)) {
    failConfig(
      "OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN must be at least 32 random bytes encoded as base64url.",
    );
  }

  return {
    mode: "https_webhook",
    url: validateWebhookUrl(
      env.OPERATIONAL_ALERT_WEBHOOK_URL,
      allowedWebhookHosts(env.OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS),
    ),
    bearerToken,
    timeoutMs: boundedInteger(
      env.OPERATIONAL_ALERT_WEBHOOK_TIMEOUT_MS,
      4_000,
      500,
      30_000,
      "OPERATIONAL_ALERT_WEBHOOK_TIMEOUT_MS",
    ),
    cooldownMs:
      boundedInteger(
        env.OPERATIONAL_ALERT_WEBHOOK_COOLDOWN_SECONDS,
        900,
        60,
        86_400,
        "OPERATIONAL_ALERT_WEBHOOK_COOLDOWN_SECONDS",
      ) * 1_000,
  };
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface TransportDependencies {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onFailure?: (failure: DeliveryFailure) => void;
  onSuccess?: (result: {
    transitionCount: number;
    pendingCount: number;
  }) => void;
}

export interface DeliveryFailure {
  category:
    | "network"
    | "timeout"
    | "http_retryable"
    | "http_permanent"
    | "redirect_refused"
    | "queue_overflow";
  retryable: boolean;
  status: number | null;
  attemptCount: number;
  pendingCount: number;
}

export type DeliveryResult =
  | { state: "disabled" | "empty" | "cooldown"; pendingCount: number }
  | { state: "delivered"; transitionCount: number; pendingCount: number }
  | {
      state: "deferred" | "dropped";
      failure: DeliveryFailure;
      pendingCount: number;
    };

class WebhookDeliveryError extends Error {
  constructor(
    readonly category: DeliveryFailure["category"],
    readonly retryable: boolean,
    readonly status: number | null,
    readonly attemptCount: number,
  ) {
    super(category);
    this.name = "WebhookDeliveryError";
  }
}

const MAX_BATCH_TRANSITIONS = 32;
const MAX_PENDING_TRANSITIONS = 128;
const MAX_PAYLOAD_BYTES = 16 * 1_024;
const RETRY_DELAYS_MS = [250, 1_000] as const;

function safeString(value: string, maxLength: number): string {
  return value.slice(0, maxLength);
}

function safeNumber(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function safeTransition(transition: OperationalAlertTransition) {
  return {
    kind: transition.kind,
    observedAt: safeString(transition.observedAt, 40),
    fingerprint: safeString(transition.alert.fingerprint, 256),
    code: safeString(transition.alert.code, 128),
    severity: transition.alert.severity,
    owner: safeString(transition.alert.owner, 128),
    runbook: safeString(transition.alert.runbook, 256),
    metric: safeString(transition.alert.metric, 128),
    observed: safeNumber(transition.alert.observed),
    threshold: safeNumber(transition.alert.threshold),
  } as const;
}

function transitionKey(transition: OperationalAlertTransition): string {
  return createHash("sha256")
    .update(transition.kind)
    .update("\0")
    .update(transition.alert.severity)
    .update("\0")
    .update(transition.alert.fingerprint)
    .digest("hex");
}

function payloadFor(transitions: OperationalAlertTransition[]): {
  body: string;
  count: number;
} {
  const safeTransitions = transitions.map(safeTransition);
  while (safeTransitions.length > 0) {
    const body = JSON.stringify({
      schemaVersion: 1,
      event: "operational_alert_transitions",
      transitions: safeTransitions,
    });
    if (Buffer.byteLength(body, "utf8") <= MAX_PAYLOAD_BYTES) {
      return { body, count: safeTransitions.length };
    }
    safeTransitions.pop();
  }
  throw new WebhookDeliveryError("http_permanent", false, null, 0);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class OperationalAlertWebhookTransport {
  private readonly pending = new Map<string, OperationalAlertTransition>();
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly onFailure: NonNullable<TransportDependencies["onFailure"]>;
  private readonly onSuccess: NonNullable<TransportDependencies["onSuccess"]>;
  private readonly cooldownUntilByKey = new Map<string, number>();
  private inFlight: Promise<DeliveryResult> | null = null;

  constructor(
    private readonly config: HttpsWebhookTransportConfig,
    dependencies: TransportDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.onFailure = dependencies.onFailure ?? (() => undefined);
    this.onSuccess = dependencies.onSuccess ?? (() => undefined);
  }

  deliver(transitions: OperationalAlertTransition[]): Promise<DeliveryResult> {
    const suppressedByCooldown = this.enqueue(transitions);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.flush(suppressedByCooldown).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * Sends one database-outbox event without the process-local queue/cooldown.
   * The stable event key survives retries, restarts, and replica hand-off.
   */
  async deliverDurable(
    transition: OperationalAlertTransition,
    idempotencyKey: string,
  ): Promise<DeliveryResult> {
    const payload = payloadFor([transition]);
    try {
      await this.sendWithRetry(payload.body, idempotencyKey);
      return { state: "delivered", transitionCount: 1, pendingCount: 0 };
    } catch (error) {
      const failureError =
        error instanceof WebhookDeliveryError
          ? error
          : new WebhookDeliveryError("network", true, null, 3);
      const failure: DeliveryFailure = {
        category: failureError.category,
        retryable: failureError.retryable,
        status: failureError.status,
        attemptCount: failureError.attemptCount,
        pendingCount: 0,
      };
      return {
        state: failure.retryable ? "deferred" : "dropped",
        failure,
        pendingCount: 0,
      };
    }
  }

  private enqueue(transitions: OperationalAlertTransition[]): number {
    const now = this.now();
    for (const [key, expiresAt] of this.cooldownUntilByKey) {
      if (expiresAt <= now) this.cooldownUntilByKey.delete(key);
    }
    let suppressed = 0;
    for (const transition of transitions) {
      const key = transitionKey(transition);
      if ((this.cooldownUntilByKey.get(key) ?? 0) > now) {
        suppressed += 1;
        continue;
      }
      this.pending.set(key, transition);
      if (this.pending.size <= MAX_PENDING_TRANSITIONS) continue;
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest) this.pending.delete(oldest);
      this.onFailure({
        category: "queue_overflow",
        retryable: false,
        status: null,
        attemptCount: 0,
        pendingCount: this.pending.size,
      });
    }
    return suppressed;
  }

  private async flush(suppressedByCooldown: number): Promise<DeliveryResult> {
    if (this.pending.size === 0) {
      return {
        state: suppressedByCooldown > 0 ? "cooldown" : "empty",
        pendingCount: 0,
      };
    }

    let deliveredCount = 0;
    while (this.pending.size > 0) {
      const entries = [...this.pending.entries()].slice(0, MAX_BATCH_TRANSITIONS);
      const payload = payloadFor(entries.map(([, transition]) => transition));
      const deliveredEntries = entries.slice(0, payload.count);

      try {
        await this.sendWithRetry(payload.body);
        const cooldownUntil = this.now() + this.config.cooldownMs;
        for (const [key] of deliveredEntries) {
          this.pending.delete(key);
          this.cooldownUntilByKey.set(key, cooldownUntil);
        }
        deliveredCount += deliveredEntries.length;
        this.onSuccess({
          transitionCount: deliveredEntries.length,
          pendingCount: this.pending.size,
        });
      } catch (error) {
        const failureError =
          error instanceof WebhookDeliveryError
            ? error
            : new WebhookDeliveryError("network", true, null, 3);
        if (!failureError.retryable) {
          for (const [key] of deliveredEntries) this.pending.delete(key);
        }
        const failure: DeliveryFailure = {
          category: failureError.category,
          retryable: failureError.retryable,
          status: failureError.status,
          attemptCount: failureError.attemptCount,
          pendingCount: this.pending.size,
        };
        this.onFailure(failure);
        return {
          state: failure.retryable ? "deferred" : "dropped",
          failure,
          pendingCount: this.pending.size,
        };
      }
    }

    return {
      state: "delivered",
      transitionCount: deliveredCount,
      pendingCount: 0,
    };
  }

  private async sendWithRetry(
    body: string,
    idempotencyKey = createHash("sha256").update(body).digest("hex"),
  ): Promise<void> {
    let lastError: WebhookDeliveryError | null = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.post(body, idempotencyKey, attempt);
        return;
      } catch (error) {
        const deliveryError =
          error instanceof WebhookDeliveryError
            ? error
            : new WebhookDeliveryError("network", true, null, attempt);
        lastError = deliveryError;
        if (!deliveryError.retryable || attempt === 3) throw deliveryError;
        await this.sleep(RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[1]);
      }
    }
    throw lastError ?? new WebhookDeliveryError("network", true, null, 3);
  }

  private async post(
    body: string,
    idempotencyKey: string,
    attempt: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    try {
      let response: Response;
      try {
        response = await this.fetch(this.config.url, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.config.bearerToken}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body,
        });
      } catch (error) {
        throw new WebhookDeliveryError(
          error instanceof Error && error.name === "AbortError"
            ? "timeout"
            : "network",
          true,
          null,
          attempt,
        );
      }

      // The payload is status-only. Cancel any response stream while the same
      // deadline is still active so an infinite/chunked body cannot pin an
      // Undici connection after headers arrive.
      await response.body?.cancel().catch(() => undefined);

      if (response.status >= 200 && response.status < 300) return;
      if (response.status >= 300 && response.status < 400) {
        throw new WebhookDeliveryError(
          "redirect_refused",
          false,
          response.status,
          attempt,
        );
      }
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new WebhookDeliveryError(
          "http_retryable",
          true,
          response.status,
          attempt,
        );
      }
      throw new WebhookDeliveryError(
        "http_permanent",
        false,
        response.status,
        attempt,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const configuredTransport = loadOperationalAlertTransportConfig();
const webhookTransport =
  configuredTransport.mode === "https_webhook"
    ? new OperationalAlertWebhookTransport(configuredTransport, {
        onFailure: (failure) => {
          logger.warn(
            {
              event: "operational_alert_webhook_delivery_failed",
              category: failure.category,
              retryable: failure.retryable,
              status: failure.status,
              attemptCount: failure.attemptCount,
              pendingCount: failure.pendingCount,
            },
            "Operational alert webhook delivery failed",
          );
        },
        onSuccess: (result) => {
          logger.info(
            {
              event: "operational_alert_webhook_delivered",
              transitionCount: result.transitionCount,
              pendingCount: result.pendingCount,
            },
            "Operational alert webhook delivered",
          );
        },
      })
    : null;

/** Explicit bootstrap guard; importing this module already parses fail-closed. */
export function validateOperationalAlertTransportConfiguration(): void {
  void configuredTransport;
}

export function getOperationalAlertTransportMode(): OperationalAlertTransportMode {
  return webhookTransport ? "local_log_and_https_webhook" : "local_log_only";
}

export function deliverOperationalAlertTransitions(
  transitions: OperationalAlertTransition[],
): Promise<DeliveryResult> {
  if (!webhookTransport) {
    return Promise.resolve({ state: "disabled", pendingCount: 0 });
  }
  return webhookTransport.deliver(transitions);
}

export function deliverOperationalAlertTransitionDurably(
  transition: OperationalAlertTransition,
  idempotencyKey: string,
): Promise<DeliveryResult> {
  if (!webhookTransport) {
    return Promise.resolve({ state: "disabled", pendingCount: 0 });
  }
  return webhookTransport.deliverDurable(transition, idempotencyKey);
}
