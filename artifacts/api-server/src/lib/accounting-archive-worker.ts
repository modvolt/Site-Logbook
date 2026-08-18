import {
  AccountingArchiveContractError,
  createAccountingArchiveManifest,
  MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES,
  MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES,
  MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES,
  prepareAccountingArchivePayload,
  verifyAccountingArchive,
  type AccountingArchiveEntryBytes,
  type AccountingArchiveEntryKind,
  type AccountingArchiveReceiptV1,
} from "./accounting-archive-contract";
import { verifyCanonicalAccountingExportIntentJsonBytes } from "./accounting-persistence-contract";

export const ACCOUNTING_ARCHIVE_LEASE_MS = 5 * 60_000;
export const ACCOUNTING_ARCHIVE_MAX_ATTEMPTS = 8;

export interface ClaimedAccountingArchiveIntent {
  intentId: string;
  leaseToken: string;
  attemptCount: number;
  canonicalIntentJson: string;
}

export interface AccountingArchiveFailure {
  category: string;
  retryable: boolean;
  occurredAt: Date;
}

export interface AccountingArchiveRepositoryPort {
  claimNext(input: {
    now: Date;
    leaseExpiresAt: Date;
  }): Promise<ClaimedAccountingArchiveIntent | null>;
  loadEntry(input: {
    kind: AccountingArchiveEntryKind;
    id: string;
  }): Promise<AccountingArchiveEntryBytes | null>;
  markExported(input: {
    claim: ClaimedAccountingArchiveIntent;
    receipt: AccountingArchiveReceiptV1;
    exportedAt: Date;
  }): Promise<boolean>;
  markFailed(input: {
    claim: ClaimedAccountingArchiveIntent;
    failure: AccountingArchiveFailure;
  }): Promise<"pending" | "dead_letter" | "lost_lease">;
}

export interface AccountingArchiveStoragePort {
  /**
   * Creates a versioned object once, or returns the already existing exact
   * version after independently verifying its bytes. Implementations must not
   * create a new version when the same content-addressed key is retried.
   */
  putImmutable(input: {
    objectKey: string;
    body: Buffer;
    mediaType: "application/json" | "text/plain";
    sha256: string;
  }): Promise<{
    objectKey: string;
    versionId: string;
    alreadyExisted: boolean;
  }>;
  /** Reads the exact provider version; a mutable current-version read is invalid. */
  readImmutable(input: {
    objectKey: string;
    versionId: string;
    maximumBytes: number;
  }): Promise<Buffer>;
}

export class AccountingArchiveStorageError extends Error {
  readonly category: string;
  readonly retryable: boolean;

  constructor(input: {
    message: string;
    category: string;
    retryable: boolean;
  }) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.category)) {
      throw new Error("Accounting archive failure category is invalid.");
    }
    super(input.message);
    this.name = "AccountingArchiveStorageError";
    this.category = input.category;
    this.retryable = input.retryable;
  }
}

export type AccountingArchiveWorkerResult =
  | { state: "idle" }
  | {
      state: "exported" | "lost_lease";
      intentId: string;
      receipt: AccountingArchiveReceiptV1;
    }
  | {
      state: "pending" | "dead_letter" | "lost_lease";
      intentId: string;
      failure: AccountingArchiveFailure;
    };

function classifyFailure(
  error: unknown,
  attemptCount: number,
  now: Date,
  maxAttempts: number,
): AccountingArchiveFailure {
  let category = "unexpected";
  let retryable = true;
  if (error instanceof AccountingArchiveContractError) {
    category = "invalid_evidence";
    retryable = false;
  } else if (error instanceof AccountingArchiveStorageError) {
    category = error.category;
    retryable = error.retryable;
  }
  if (attemptCount >= maxAttempts) retryable = false;
  return { category, retryable, occurredAt: now };
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

export async function runAccountingArchiveWorkerOnce(input: {
  repository: AccountingArchiveRepositoryPort;
  storage: AccountingArchiveStoragePort;
  clock?: () => Date;
  now?: Date;
  leaseMs?: number;
  maxAttempts?: number;
}): Promise<AccountingArchiveWorkerResult> {
  const fixedNow = input.now ? new Date(input.now) : null;
  const readTime = () => {
    const value = fixedNow
      ? new Date(fixedNow)
      : new Date((input.clock ?? (() => new Date()))());
    if (Number.isNaN(value.valueOf()))
      throw new Error("Worker time is invalid.");
    return value;
  };
  const claimNow = readTime();
  const leaseMs = input.leaseMs ?? ACCOUNTING_ARCHIVE_LEASE_MS;
  const maxAttempts = input.maxAttempts ?? ACCOUNTING_ARCHIVE_MAX_ATTEMPTS;
  assertPositiveInteger("Accounting archive lease", leaseMs);
  assertPositiveInteger("Accounting archive max attempts", maxAttempts);
  const claim = await input.repository.claimNext({
    now: claimNow,
    leaseExpiresAt: new Date(claimNow.valueOf() + leaseMs),
  });
  if (!claim) return { state: "idle" };

  try {
    let intent;
    try {
      intent = verifyCanonicalAccountingExportIntentJsonBytes(
        claim.canonicalIntentJson,
      );
    } catch (error) {
      throw new AccountingArchiveContractError(
        `Claimed export intent is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    const entries: AccountingArchiveEntryBytes[] = [];
    for (const entry of intent.entries) {
      const loaded = await input.repository.loadEntry({
        kind: entry.kind,
        id: entry.id,
      });
      if (!loaded) {
        throw new AccountingArchiveContractError(
          `Accounting evidence ${entry.kind}:${entry.id} is missing.`,
        );
      }
      entries.push(loaded);
    }
    const payload = prepareAccountingArchivePayload({
      canonicalIntentJson: claim.canonicalIntentJson,
      entries,
    });
    if (payload.intent.intentId !== claim.intentId) {
      throw new AccountingArchiveContractError(
        "Claim identity does not match the export intent.",
      );
    }

    const bundleReceipt = await input.storage.putImmutable(payload.bundle);
    const checksumReceipt = await input.storage.putImmutable(payload.checksum);
    const manifestArtifact = createAccountingArchiveManifest({
      payload,
      bundleReceipt,
      checksumReceipt,
    });
    const manifestReceipt = await input.storage.putImmutable(manifestArtifact);
    if (manifestReceipt.objectKey !== manifestArtifact.objectKey) {
      throw new AccountingArchiveStorageError({
        message:
          "Storage returned a manifest receipt for a different object key.",
        category: "invalid_storage_receipt",
        retryable: false,
      });
    }

    const checksumBytes = await input.storage.readImmutable({
      objectKey: payload.checksum.objectKey,
      versionId: checksumReceipt.versionId,
      maximumBytes: MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES,
    });
    const manifestBytes = await input.storage.readImmutable({
      objectKey: manifestArtifact.objectKey,
      versionId: manifestReceipt.versionId,
      maximumBytes: MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES,
    });
    const bundleBytes = await input.storage.readImmutable({
      objectKey: payload.bundle.objectKey,
      versionId: bundleReceipt.versionId,
      maximumBytes: MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES,
    });
    const receipt: AccountingArchiveReceiptV1 = {
      manifestObjectKey: manifestArtifact.objectKey,
      manifestVersionId: manifestReceipt.versionId,
      manifestSha256: manifestArtifact.sha256,
      bundleSha256: payload.bundle.sha256,
      checksumSha256: payload.checksum.sha256,
    };
    const verified = verifyAccountingArchive({
      bundleBytes,
      checksumBytes,
      manifestBytes,
      observedManifestVersionId: manifestReceipt.versionId,
      expectedReceipt: receipt,
    });
    if (verified.intent.intentId !== claim.intentId) {
      throw new AccountingArchiveContractError(
        "Read-back archive belongs to another intent.",
      );
    }
    const applied = await input.repository.markExported({
      claim,
      receipt,
      exportedAt: readTime(),
    });
    return {
      state: applied ? "exported" : "lost_lease",
      intentId: claim.intentId,
      receipt,
    };
  } catch (error) {
    const failure = classifyFailure(
      error,
      claim.attemptCount,
      readTime(),
      maxAttempts,
    );
    const state = await input.repository.markFailed({ claim, failure });
    return { state, intentId: claim.intentId, failure };
  }
}
