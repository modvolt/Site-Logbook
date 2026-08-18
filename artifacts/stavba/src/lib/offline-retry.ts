import type { OfflineFailureKind } from "@/lib/offline-queue";

export const OFFLINE_MAX_ATTEMPTS = 5;
export const OFFLINE_BACKOFF_BASE_MS = 1_000;
export const OFFLINE_BACKOFF_MAX_MS = 30_000;

export class OfflineReplayError extends Error {
  constructor(
    message: string,
    readonly kind: OfflineFailureKind,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "OfflineReplayError";
  }
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, OFFLINE_BACKOFF_MAX_MS);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - Date.now(), OFFLINE_BACKOFF_MAX_MS));
}

export function classifyReplayFailure(
  status: number,
  code?: string,
): OfflineFailureKind {
  if (status === 401 || code === "offline_scope_mismatch" || code === "offline_identity_unavailable") {
    return "auth";
  }
  if (code === "idempotency_ambiguous") return "ambiguous";
  if (
    code === "idempotency_key_reused"
    || code === "invalid_idempotency_key"
    || code === "idempotency_key_required"
    || code === "offline_content_digest_required"
    || code === "offline_content_digest_mismatch"
  ) return "permanent";
  if (code === "idempotency_in_progress" || code === "idempotency_unavailable") return "transient";
  if ([408, 425, 429].includes(status) || status >= 500) return "transient";
  if (status === 409) return "conflict";
  return "permanent";
}

export async function throwReplayResponse(
  response: Response,
  label = "Offline operace selhala",
): Promise<never> {
  const text = await response.text().catch(() => "");
  let code: string | undefined;
  let detail = text.slice(0, 200);
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.error === "string") detail = body.error.slice(0, 200);
  } catch {
    // Keep the bounded text response.
  }
  throw new OfflineReplayError(
    `${label} (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    classifyReplayFailure(response.status, code),
    response.status,
    code,
    retryAfterMs(response),
  );
}

export function normalizeReplayError(error: unknown): OfflineReplayError {
  if (error instanceof OfflineReplayError) return error;
  if (error instanceof TypeError) {
    return new OfflineReplayError(error.message || "Síť není dostupná.", "transient");
  }
  return new OfflineReplayError(
    error instanceof Error ? error.message : "Neznámá chyba offline synchronizace.",
    "permanent",
  );
}

export function canManuallyRetryOfflineFailure(
  kind: OfflineFailureKind | undefined,
): boolean {
  return kind === undefined || kind === "transient";
}

export function offlineBackoffMs(
  attempts: number,
  retryAfter: number | undefined,
  random = Math.random,
): number {
  if (retryAfter !== undefined) return Math.max(0, Math.min(retryAfter, OFFLINE_BACKOFF_MAX_MS));
  const exponent = Math.max(0, attempts - 1);
  const bounded = Math.min(OFFLINE_BACKOFF_BASE_MS * 2 ** exponent, OFFLINE_BACKOFF_MAX_MS);
  const jitter = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.round(bounded * jitter);
}
