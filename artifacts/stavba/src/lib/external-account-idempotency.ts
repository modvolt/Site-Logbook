const STORAGE_PREFIX = "modvolt.external-account-idempotency.v1";
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const MAX_AUTOMATIC_ATTEMPTS = 2;

export type LifecycleMethod = "POST" | "PUT" | "PATCH";
type IntentState = "retryable" | "ambiguous";

type IntentRecord = {
  version: 1;
  idempotencyKey: string;
  state: IntentState;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type RequesterOptions = {
  fetchImpl?: typeof fetch;
  storage?: StorageLike;
  randomUUID?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
};

const memoryStorage = new Map<string, string>();
const fallbackStorage: StorageLike = {
  getItem: (key) => memoryStorage.get(key) ?? null,
  setItem: (key, value) => memoryStorage.set(key, value),
  removeItem: (key) => memoryStorage.delete(key),
};

function defaultStorage(): StorageLike {
  try {
    if (globalThis.sessionStorage) return globalThis.sessionStorage;
  } catch {
    // Sandboxed/private browser contexts may deny sessionStorage. The in-memory
    // fallback still preserves a key for retries within the current page.
  }
  return fallbackStorage;
}

function slotKey(method: LifecycleMethod, path: string): string {
  return `${STORAGE_PREFIX}:${method}:${path}`;
}

function parseIntentRecord(raw: string | null): IntentRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<IntentRecord>;
    if (
      value.version !== 1 ||
      !KEY_PATTERN.test(value.idempotencyKey ?? "") ||
      !["retryable", "ambiguous"].includes(value.state ?? "") ||
      Object.keys(value).sort().join(",") !== "idempotencyKey,state,version"
    ) {
      return null;
    }
    return value as IntentRecord;
  } catch {
    return null;
  }
}

function writeIntent(
  storage: StorageLike,
  method: LifecycleMethod,
  path: string,
  record: IntentRecord,
): void {
  storage.setItem(slotKey(method, path), JSON.stringify(record));
}

function removeIntent(
  storage: StorageLike,
  method: LifecycleMethod,
  path: string,
): void {
  storage.removeItem(slotKey(method, path));
}

function retryDelay(response: Response): number {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds)
    ? Math.max(0, Math.min(seconds * 1_000, 2_000))
    : 150;
}

function errorPayload(data: unknown): { error?: string; code?: string } {
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as { error?: string; code?: string })
    : {};
}

export class ExternalAccountLifecycleError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly code: string,
    public readonly method: LifecycleMethod,
    public readonly path: string,
    public readonly reconciliationRequired: boolean,
  ) {
    super(message);
    this.name = "ExternalAccountLifecycleError";
  }
}

export function createExternalAccountLifecycleRequester(
  options: RequesterOptions = {},
): <T>(path: string, method: LifecycleMethod, body: unknown) => Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage = options.storage ?? defaultStorage();
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return async function request<T>(
    path: string,
    method: LifecycleMethod,
    body: unknown,
  ): Promise<T> {
    const storageKey = slotKey(method, path);
    const rawIntent = storage.getItem(storageKey);
    let intent = parseIntentRecord(rawIntent);
    if (rawIntent !== null && !intent) {
      throw new ExternalAccountLifecycleError(
        "Uložený stav předchozí operace je poškozený. Nejprve ověřte skutečný stav účtu a potom záznam výslovně vymažte.",
        409,
        "idempotency_intent_invalid",
        method,
        path,
        true,
      );
    }
    if (!intent) {
      intent = {
        version: 1,
        idempotencyKey: randomUUID(),
        state: "retryable",
      };
      if (!KEY_PATTERN.test(intent.idempotencyKey)) {
        throw new Error("Generated Idempotency-Key has an invalid format.");
      }
      writeIntent(storage, method, path, intent);
    }
    if (intent.state === "ambiguous") {
      throw new ExternalAccountLifecycleError(
        "Předchozí výsledek této operace je nejasný. Nejprve obnovte seznam a detail účtu, ověřte skutečný stav a teprve potom výslovně povolte nový pokus.",
        409,
        "idempotency_ambiguous",
        method,
        path,
        true,
      );
    }

    for (let attempt = 0; attempt < MAX_AUTOMATIC_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`/api${path}`, {
          method,
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        if (attempt + 1 < MAX_AUTOMATIC_ATTEMPTS) {
          await sleep(150);
          continue;
        }
        writeIntent(storage, method, path, intent);
        throw new ExternalAccountLifecycleError(
          cause instanceof Error
            ? cause.message
            : "Síťový výsledek operace nelze určit.",
          undefined,
          "idempotency_transport_unknown",
          method,
          path,
          false,
        );
      }

      const data = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        removeIntent(storage, method, path);
        return data as T;
      }

      const payload = errorPayload(data);
      const code = payload.code ?? "external_account_operation_failed";
      const transient =
        code === "idempotency_in_progress" ||
        code === "idempotency_unavailable" ||
        [408, 425, 429].includes(response.status);
      if (transient && attempt + 1 < MAX_AUTOMATIC_ATTEMPTS) {
        await sleep(retryDelay(response));
        continue;
      }

      const reconciliationRequired =
        code === "idempotency_ambiguous" ||
        code === "idempotency_key_reused" ||
        response.status >= 500;
      if (reconciliationRequired) {
        writeIntent(storage, method, path, {
          ...intent,
          state: "ambiguous",
        });
      } else if (
        transient ||
        code === "biometric_required" ||
        response.status === 403
      ) {
        writeIntent(storage, method, path, intent);
      } else {
        removeIntent(storage, method, path);
      }

      throw new ExternalAccountLifecycleError(
        payload.error ?? "Operace externího účtu selhala.",
        response.status,
        code,
        method,
        path,
        reconciliationRequired,
      );
    }

    throw new Error("External account retry loop terminated unexpectedly.");
  };
}

const defaultRequester = createExternalAccountLifecycleRequester();

export function externalAccountLifecycleRequest<T>(
  path: string,
  method: LifecycleMethod,
  body: unknown,
): Promise<T> {
  return defaultRequester<T>(path, method, body);
}

export function clearExternalAccountLifecycleIntent(
  method: LifecycleMethod,
  path: string,
  storage: StorageLike = defaultStorage(),
): void {
  removeIntent(storage, method, path);
}
