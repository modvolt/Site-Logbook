import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAccountingArchiveManifest,
  prepareAccountingArchivePayload,
  verifyAccountingArchive,
  verifyCanonicalAccountingArchiveBundleBytes,
  type AccountingArchiveEntryBytes,
  type AccountingArchiveReceiptV1,
} from "../src/lib/accounting-archive-contract";
import {
  AccountingArchiveStorageError,
  runAccountingArchiveWorkerOnce,
  type AccountingArchiveFailure,
  type AccountingArchiveRepositoryPort,
  type AccountingArchiveStoragePort,
  type ClaimedAccountingArchiveIntent,
} from "../src/lib/accounting-archive-worker";
import {
  canonicalAccountingLifecycleEntryJson,
  createAccountingLifecycleEvent,
} from "../src/lib/accounting-lifecycle-event-contract";
import {
  canonicalAccountingExportIntentJson,
  createAccountingReasonArtifactExportIntent,
  createAccountingWarehousePriceExportIntent,
  verifyCanonicalAccountingExportIntentJsonBytes,
  type AccountingExportIntentV1,
} from "../src/lib/accounting-persistence-contract";
import {
  canonicalAccountingWarehousePriceObservationJson,
  createAccountingWarehousePriceObservation,
} from "../src/lib/accounting-warehouse-price-observation-contract";
import { canonicalEvidenceJson, sha256Hex } from "../src/lib/evidence-hash";
import {
  canonicalAccountingReasonArtifactJson,
  createAccountingReasonArtifact,
} from "../src/lib/accounting-reason-artifact-contract";

const INTENT_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PRICE_OBSERVATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REASON_ARTIFACT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECORDED_AT = "2042-03-04T10:01:00.000Z";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fixture() {
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: EVENT_ID,
    aggregate: {
      kind: "outgoing-invoice",
      id: "42",
      versionId: "11111111-1111-4111-8111-111111111111",
    },
    sequence: "0",
    previousEventSha256: null,
    eventType: "issued",
    actor: { kind: "user", id: "7", authentication: "step-up" },
    reasonCode: "document_issued",
    reasonDetailSha256: null,
    effectiveAt: "2042-03-04T10:00:00.000Z",
    recordedAt: RECORDED_AT,
    evidenceSha256: "d".repeat(64),
  });
  const body = {
    schemaVersion: "site-logbook.accounting-export-intent/v1" as const,
    intentId: INTENT_ID,
    operation: "lifecycle-event" as const,
    affectedAggregates: [{ kind: "outgoing-invoice" as const, id: "42" }],
    entries: [
      {
        kind: "lifecycle-event" as const,
        id: event.eventId,
        sha256: event.integrity.entrySha256,
      },
    ],
    recordedAt: RECORDED_AT,
    destination: {
      kind: "versioned-object-storage" as const,
      namespace: "accounting-evidence/v1" as const,
      format: "canonical-json-bundle/v1" as const,
    },
    initialState: "pending" as const,
  };
  const unsigned = {
    ...body,
    integrity: {
      canonicalization: "site-logbook-cjson/v1" as const,
      hashAlgorithm: "sha256" as const,
      hashDomain: "site-logbook.accounting-export-intent/v1" as const,
      intentSha256: null,
    },
  };
  const intent = verifyCanonicalAccountingExportIntentJsonBytes(
    canonicalEvidenceJson({
      ...body,
      integrity: {
        ...unsigned.integrity,
        intentSha256: sha256Hex(
          `site-logbook.accounting-export-intent/v1\0${canonicalEvidenceJson(unsigned)}`,
        ),
      },
    }),
  );
  return {
    canonicalIntentJson: canonicalEvidenceJson(intent),
    entry: {
      kind: "lifecycle-event" as const,
      id: event.eventId,
      canonicalJson: canonicalAccountingLifecycleEntryJson(event),
    },
  };
}

function priceFixture() {
  const observation = createAccountingWarehousePriceObservation({
    schemaVersion: "site-logbook.warehouse-price-observation/v1",
    observationId: PRICE_OBSERVATION_ID,
    warehouseItemId: "17",
    sequence: "0",
    previousObservationSha256: null,
    supersedesObservationId: null,
    transition: "observed",
    source: {
      aggregateId: "42",
      accountingVersionId: "11111111-1111-4111-8111-111111111111",
      accountingVersionSha256: "a".repeat(64),
      lifecycleEventId: EVENT_ID,
      lifecycleEventSha256: "b".repeat(64),
      sourceLineId: "501",
    },
    purchasePrice: "10",
    currency: "CZK",
    warehouseMatch: { mode: "code", evidenceSha256: "c".repeat(64) },
    actor: { kind: "user", id: "7", authentication: "step-up" },
    reasonCode: "document_approved",
    reasonDetailSha256: null,
    effectiveAt: "2042-03-04T10:00:00.000Z",
    recordedAt: RECORDED_AT,
  });
  const intent = createAccountingWarehousePriceExportIntent(observation);
  return {
    canonicalIntentJson: canonicalAccountingExportIntentJson(intent),
    entry: {
      kind: "warehouse-price-observation" as const,
      id: observation.observationId,
      canonicalJson:
        canonicalAccountingWarehousePriceObservationJson(observation),
    },
  };
}

function reasonFixture() {
  const reasonText = "Doklad patří k jiné zakázce";
  const reasonDomain =
    "site-logbook.cost-document-review-reopen-reason/v1" as const;
  const event = createAccountingLifecycleEvent({
    schemaVersion: "site-logbook.accounting-lifecycle-event/v1",
    eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    aggregate: {
      kind: "incoming-cost-document",
      id: "42",
      versionId: "11111111-1111-4111-8111-111111111111",
    },
    sequence: "1",
    previousEventSha256: "a".repeat(64),
    eventType: "review_reopened",
    actor: { kind: "user", id: "7", authentication: "session" },
    reasonCode: "review_reopened",
    reasonDetailSha256: sha256Hex(
      `${reasonDomain}\0${canonicalEvidenceJson({ reason: reasonText })}`,
    ),
    effectiveAt: RECORDED_AT,
    recordedAt: RECORDED_AT,
    evidenceSha256: "d".repeat(64),
  });
  const artifact = createAccountingReasonArtifact({
    artifactId: REASON_ARTIFACT_ID,
    lifecycleEvent: event,
    reasonText,
    digestDomain: reasonDomain,
  });
  const intent = createAccountingReasonArtifactExportIntent(artifact);
  return {
    canonicalIntentJson: canonicalAccountingExportIntentJson(intent),
    entry: {
      kind: "reason-artifact" as const,
      id: artifact.artifactId,
      canonicalJson: canonicalAccountingReasonArtifactJson(artifact),
    },
  };
}

function rehashExportIntent(value: AccountingExportIntentV1): string {
  const unsigned = {
    ...value,
    integrity: { ...value.integrity, intentSha256: null },
  };
  return canonicalEvidenceJson({
    ...value,
    integrity: {
      ...value.integrity,
      intentSha256: sha256Hex(
        `site-logbook.accounting-export-intent/v1\0${canonicalEvidenceJson(unsigned)}`,
      ),
    },
  });
}

function createArchive(
  source: {
    canonicalIntentJson: string;
    entry: AccountingArchiveEntryBytes;
  } = fixture(),
) {
  const payload = prepareAccountingArchivePayload({
    canonicalIntentJson: source.canonicalIntentJson,
    entries: [source.entry],
  });
  const manifest = createAccountingArchiveManifest({
    payload,
    bundleReceipt: {
      objectKey: payload.bundle.objectKey,
      versionId: "bundle-version-1",
    },
    checksumReceipt: {
      objectKey: payload.checksum.objectKey,
      versionId: "checksum-version-1",
    },
  });
  return { source, payload, manifest };
}

class FakeRepository implements AccountingArchiveRepositoryPort {
  readonly source = fixture();
  state: "pending" | "exported" | "dead_letter" = "pending";
  attemptCount = 0;
  loseNextExportLease = false;
  missingEntry = false;
  receipt: AccountingArchiveReceiptV1 | null = null;
  failures: AccountingArchiveFailure[] = [];
  leaseExpiresAt: Date | null = null;

  async claimNext(input: {
    leaseExpiresAt: Date;
  }): Promise<ClaimedAccountingArchiveIntent | null> {
    if (this.state !== "pending") return null;
    this.leaseExpiresAt = input.leaseExpiresAt;
    this.attemptCount += 1;
    return {
      intentId: INTENT_ID,
      leaseToken: `44444444-4444-4444-8444-${String(this.attemptCount).padStart(12, "0")}`,
      attemptCount: this.attemptCount,
      canonicalIntentJson: this.source.canonicalIntentJson,
    };
  }

  async loadEntry(): Promise<AccountingArchiveEntryBytes | null> {
    return this.missingEntry ? null : this.source.entry;
  }

  async markExported(input: {
    receipt: AccountingArchiveReceiptV1;
    exportedAt: Date;
  }): Promise<boolean> {
    if (this.loseNextExportLease) {
      this.loseNextExportLease = false;
      return false;
    }
    if (
      !this.leaseExpiresAt ||
      input.exportedAt.valueOf() >= this.leaseExpiresAt.valueOf()
    ) {
      return false;
    }
    this.receipt = input.receipt;
    this.state = "exported";
    return true;
  }

  async markFailed(input: {
    failure: AccountingArchiveFailure;
  }): Promise<"pending" | "dead_letter" | "lost_lease"> {
    this.failures.push(input.failure);
    if (
      !this.leaseExpiresAt ||
      input.failure.occurredAt.valueOf() >= this.leaseExpiresAt.valueOf()
    ) {
      return "lost_lease";
    }
    this.state = input.failure.retryable ? "pending" : "dead_letter";
    return this.state;
  }
}

class FakeStorage implements AccountingArchiveStoragePort {
  readonly objects = new Map<
    string,
    { body: Buffer; sha256: string; versionId: string }
  >();
  putCalls = 0;
  createdVersions = 0;
  failPutCall: number | null = null;
  tamperReadKey: string | null = null;

  async putImmutable(input: {
    objectKey: string;
    body: Buffer;
    sha256: string;
  }) {
    this.putCalls += 1;
    if (this.failPutCall === this.putCalls) {
      throw new AccountingArchiveStorageError({
        message: "simulated timeout",
        category: "storage_timeout",
        retryable: true,
      });
    }
    const existing = this.objects.get(input.objectKey);
    if (existing) {
      if (
        existing.sha256 !== input.sha256 ||
        !existing.body.equals(input.body)
      ) {
        throw new AccountingArchiveStorageError({
          message: "immutable key collision",
          category: "immutable_key_collision",
          retryable: false,
        });
      }
      return {
        objectKey: input.objectKey,
        versionId: existing.versionId,
        alreadyExisted: true,
      };
    }
    this.createdVersions += 1;
    const stored = {
      body: Buffer.from(input.body),
      sha256: input.sha256,
      versionId: `version-${this.createdVersions}`,
    };
    this.objects.set(input.objectKey, stored);
    return {
      objectKey: input.objectKey,
      versionId: stored.versionId,
      alreadyExisted: false,
    };
  }

  async readImmutable(input: { objectKey: string; versionId: string }) {
    const stored = this.objects.get(input.objectKey);
    if (!stored || stored.versionId !== input.versionId) {
      throw new AccountingArchiveStorageError({
        message: "exact version not found",
        category: "version_not_found",
        retryable: true,
      });
    }
    if (input.objectKey === this.tamperReadKey) {
      return Buffer.from(`${stored.body.toString("utf8")} `, "utf8");
    }
    return Buffer.from(stored.body);
  }
}

describe("accounting archive contract", () => {
  it("builds and independently verifies canonical bundle, checksum and manifest bytes", () => {
    const { payload, manifest } = createArchive();
    const verified = verifyAccountingArchive({
      bundleBytes: payload.bundle.body,
      checksumBytes: payload.checksum.body,
      manifestBytes: manifest.body,
      observedManifestVersionId: "manifest-version-1",
      expectedReceipt: {
        manifestObjectKey: manifest.objectKey,
        manifestVersionId: "manifest-version-1",
        manifestSha256: manifest.sha256,
        bundleSha256: payload.bundle.sha256,
        checksumSha256: payload.checksum.sha256,
      },
    });
    expect(verified.intent.intentId).toBe(INTENT_ID);
    expect(verified.manifest.storage).toEqual({
      namespace: "accounting-evidence/v1",
      writeMode: "immutable-versioned-create-only",
      providerVersionIdsRequired: true,
      manifestIsCommitMarker: true,
    });
    expect(verified.receipt.bundleSha256).toBe(payload.bundle.sha256);
  });

  it("archives a warehouse-price observation as one independently bound entry", () => {
    const source = priceFixture();
    const { payload, manifest } = createArchive(source);
    const verified = verifyAccountingArchive({
      bundleBytes: payload.bundle.body,
      checksumBytes: payload.checksum.body,
      manifestBytes: manifest.body,
      observedManifestVersionId: "price-manifest-version-1",
    });
    expect(verified.intent).toMatchObject({
      intentId: PRICE_OBSERVATION_ID,
      operation: "warehouse-price-observation",
      entries: [
        {
          kind: "warehouse-price-observation",
          id: PRICE_OBSERVATION_ID,
        },
      ],
    });

    const parsedBundle = JSON.parse(payload.bundle.body.toString("utf8"));
    parsedBundle.entries[0].evidence.purchasePrice = "11";
    expect(() =>
      verifyCanonicalAccountingArchiveBundleBytes(
        canonicalEvidenceJson(parsedBundle),
      ),
    ).toThrow(/integrity|verification/i);

    const wrongAggregateIntent = JSON.parse(
      source.canonicalIntentJson,
    ) as AccountingExportIntentV1;
    wrongAggregateIntent.affectedAggregates[0].id = "99";
    expect(() =>
      prepareAccountingArchivePayload({
        canonicalIntentJson: rehashExportIntent(wrongAggregateIntent),
        entries: [source.entry],
      }),
    ).toThrow(/aggregate.*source evidence/i);
  });

  it("archives readable reasons only below the restricted immutable prefix", () => {
    const source = reasonFixture();
    const { payload, manifest } = createArchive(source);
    const verified = verifyAccountingArchive({
      bundleBytes: payload.bundle.body,
      checksumBytes: payload.checksum.body,
      manifestBytes: manifest.body,
      observedManifestVersionId: "reason-manifest-version-1",
    });
    expect(verified.intent).toMatchObject({
      intentId: REASON_ARTIFACT_ID,
      operation: "reason-artifact",
      destination: { namespace: "accounting-evidence-restricted/v1" },
    });
    expect(payload.bundle.objectKey).toMatch(
      /^accounting-evidence-restricted\/v1\//,
    );
    expect(manifest.objectKey).toMatch(/^accounting-evidence-restricted\/v1\//);
    expect(verified.manifest.storage.namespace).toBe(
      "accounting-evidence-restricted/v1",
    );

    const normalNamespaceIntent = JSON.parse(
      source.canonicalIntentJson,
    ) as AccountingExportIntentV1;
    normalNamespaceIntent.destination.namespace = "accounting-evidence/v1";
    expect(() =>
      prepareAccountingArchivePayload({
        canonicalIntentJson: rehashExportIntent(normalNamespaceIntent),
        entries: [source.entry],
      }),
    ).toThrow(/namespace/i);
  });

  it("rejects missing, extra, mismatched and non-canonical entry evidence", () => {
    const source = fixture();
    expect(() =>
      prepareAccountingArchivePayload({
        canonicalIntentJson: source.canonicalIntentJson,
        entries: [],
      }),
    ).toThrow(/count/i);
    expect(() =>
      prepareAccountingArchivePayload({
        canonicalIntentJson: source.canonicalIntentJson,
        entries: [source.entry, source.entry],
      }),
    ).toThrow(/count|duplicate/i);
    expect(() =>
      prepareAccountingArchivePayload({
        canonicalIntentJson: source.canonicalIntentJson,
        entries: [
          { ...source.entry, canonicalJson: `${source.entry.canonicalJson}\n` },
        ],
      }),
    ).toThrow(/canonical/i);
  });

  it("detects tampering in each offline artifact and in receipt metadata", () => {
    const { payload, manifest } = createArchive();
    expect(() =>
      verifyAccountingArchive({
        bundleBytes: payload.bundle.body,
        checksumBytes: Buffer.from(`${"0".repeat(64)}  bundle.json\n`),
        manifestBytes: manifest.body,
        observedManifestVersionId: "manifest-version-1",
      }),
    ).toThrow(/checksum/i);
    const parsedBundle = JSON.parse(payload.bundle.body.toString("utf8"));
    parsedBundle.entries[0].id = "55555555-5555-4555-8555-555555555555";
    expect(() =>
      verifyCanonicalAccountingArchiveBundleBytes(
        canonicalEvidenceJson(parsedBundle),
      ),
    ).toThrow(/intent|mismatch/i);
    expect(() =>
      verifyAccountingArchive({
        bundleBytes: payload.bundle.body,
        checksumBytes: payload.checksum.body,
        manifestBytes: manifest.body,
        observedManifestVersionId: "manifest-version-1",
        expectedReceipt: {
          manifestObjectKey: manifest.objectKey,
          manifestVersionId: "manifest-version-1",
          manifestSha256: "0".repeat(64),
          bundleSha256: payload.bundle.sha256,
          checksumSha256: payload.checksum.sha256,
        },
      }),
    ).toThrow(/receipt/i);
    expect(() =>
      verifyAccountingArchive({
        bundleBytes: payload.bundle.body,
        checksumBytes: payload.checksum.body,
        manifestBytes: manifest.body,
        observedManifestVersionId: "downloaded-version-2",
        expectedReceipt: {
          manifestObjectKey: manifest.objectKey,
          manifestVersionId: "manifest-version-1",
          manifestSha256: manifest.sha256,
          bundleSha256: payload.bundle.sha256,
          checksumSha256: payload.checksum.sha256,
        },
      }),
    ).toThrow(/receipt/i);
  });

  it("runs the bounded offline CLI for lifecycle and warehouse-price archives", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "site-logbook-accounting-archive-"),
    );
    try {
      const bundlePath = join(directory, "bundle.json");
      const checksumPath = join(directory, "bundle.sha256");
      const manifestPath = join(directory, "manifest.json");
      for (const [archive, expectedOperation] of [
        [createArchive(), "lifecycle-event"],
        [createArchive(priceFixture()), "warehouse-price-observation"],
      ] as const) {
        const { payload, manifest } = archive;
        await Promise.all([
          writeFile(bundlePath, payload.bundle.body),
          writeFile(checksumPath, payload.checksum.body),
          writeFile(manifestPath, manifest.body),
        ]);
        const result = spawnSync(
          process.execPath,
          [
            resolve(ROOT, "scripts/node_modules/tsx/dist/cli.mjs"),
            resolve(
              ROOT,
              "artifacts/api-server/src/scripts/verify-accounting-archive.ts",
            ),
            "--bundle",
            bundlePath,
            "--checksum",
            checksumPath,
            "--manifest",
            manifestPath,
            "--expected-intent-id",
            payload.intent.intentId,
            "--expected-manifest-object-key",
            manifest.objectKey,
            "--expected-manifest-version-id",
            "manifest-version-1",
            "--observed-manifest-version-id",
            "manifest-version-1",
            "--expected-manifest-sha256",
            manifest.sha256,
            "--expected-bundle-sha256",
            payload.bundle.sha256,
            "--expected-checksum-sha256",
            payload.checksum.sha256,
          ],
          { cwd: ROOT, encoding: "utf8" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          verified: true,
          intentId: payload.intent.intentId,
          operation: expectedOperation,
          entryCount: 1,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("accounting archive worker", () => {
  it("claims, writes in commit-marker order, reads exact versions and CAS-marks exported", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const result = await runAccountingArchiveWorkerOnce({
      repository,
      storage,
      now: new Date("2042-03-04T11:00:00.000Z"),
    });
    expect(result.state).toBe("exported");
    expect(storage.createdVersions).toBe(3);
    expect(
      [...storage.objects.keys()].map((key) => key.split("/").at(-1)),
    ).toEqual(["bundle.json", "bundle.sha256", "manifest.json"]);
    expect(repository.receipt?.manifestVersionId).toBe("version-3");
  });

  it("reuses exact versions after a partial storage failure", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    storage.failPutCall = 2;
    const first = await runAccountingArchiveWorkerOnce({ repository, storage });
    expect(first.state).toBe("pending");
    expect(storage.createdVersions).toBe(1);
    storage.failPutCall = null;
    const second = await runAccountingArchiveWorkerOnce({
      repository,
      storage,
    });
    expect(second.state).toBe("exported");
    expect(storage.createdVersions).toBe(3);
    expect(repository.attemptCount).toBe(2);
  });

  it("does not create new versions when the export CAS loses its lease and is reclaimed", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    repository.loseNextExportLease = true;
    const first = await runAccountingArchiveWorkerOnce({ repository, storage });
    expect(first.state).toBe("lost_lease");
    expect(storage.createdVersions).toBe(3);
    const second = await runAccountingArchiveWorkerOnce({
      repository,
      storage,
    });
    expect(second.state).toBe("exported");
    expect(storage.createdVersions).toBe(3);
    expect(storage.putCalls).toBe(6);
  });

  it("uses completion time and refuses a receipt after the lease expires", async () => {
    const repository = new FakeRepository();
    const storage = new FakeStorage();
    const instants = [
      new Date("2042-03-04T10:00:00.000Z"),
      new Date("2042-03-04T10:06:00.000Z"),
    ];
    const result = await runAccountingArchiveWorkerOnce({
      repository,
      storage,
      leaseMs: 5 * 60_000,
      clock: () => instants.shift() ?? new Date("2042-03-04T10:06:00.000Z"),
    });
    expect(result.state).toBe("lost_lease");
    expect(repository.receipt).toBeNull();
    expect(storage.createdVersions).toBe(3);
  });

  it("dead-letters missing evidence and read-back tampering", async () => {
    const missingRepository = new FakeRepository();
    missingRepository.missingEntry = true;
    const missing = await runAccountingArchiveWorkerOnce({
      repository: missingRepository,
      storage: new FakeStorage(),
    });
    expect(missing.state).toBe("dead_letter");
    expect(missingRepository.failures[0]).toMatchObject({
      category: "invalid_evidence",
      retryable: false,
    });

    const tamperedRepository = new FakeRepository();
    const tamperedStorage = new FakeStorage();
    const source = fixture();
    const intent = verifyCanonicalAccountingExportIntentJsonBytes(
      source.canonicalIntentJson,
    );
    tamperedStorage.tamperReadKey = `accounting-evidence/v1/${intent.intentId}/${intent.integrity.intentSha256}/bundle.json`;
    const tampered = await runAccountingArchiveWorkerOnce({
      repository: tamperedRepository,
      storage: tamperedStorage,
    });
    expect(tampered.state).toBe("dead_letter");
    expect(tamperedRepository.failures[0]?.category).toBe("invalid_evidence");
  });

  it("caps retryable failures and returns idle without a claim", async () => {
    const repository = new FakeRepository();
    repository.attemptCount = 7;
    const storage = new FakeStorage();
    storage.failPutCall = 1;
    const exhausted = await runAccountingArchiveWorkerOnce({
      repository,
      storage,
      maxAttempts: 8,
    });
    expect(exhausted.state).toBe("dead_letter");
    expect(repository.failures[0]).toMatchObject({
      category: "storage_timeout",
      retryable: false,
    });
    repository.state = "exported";
    const idle = await runAccountingArchiveWorkerOnce({ repository, storage });
    expect(idle).toEqual({ state: "idle" });
  });
});
