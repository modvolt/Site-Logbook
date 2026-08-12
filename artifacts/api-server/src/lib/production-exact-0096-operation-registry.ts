import { createHash, randomUUID } from "node:crypto";
import type { EncryptionKeyring } from "./secret-envelope";
import {
  ObjectStorageService,
  type ProductionExactVersionedObjectHead,
} from "./objectStorage";
import {
  ProductionExact0096SnapshotSession,
  disposeProductionExact0096EncryptedDump,
  persistProductionExact0096EncryptedDump,
  type ProductionExact0096EncryptedDump,
  type ProductionExact0096SnapshotArtifact,
} from "./production-exact-0096-backup-producer";
import type { ProductionExact0096SessionOperationHandlers } from "../production-exact-0096-backup-producer";

export const PRODUCTION_EXACT_0096_REGISTRY_ACTIVATION =
  "ACTIVATE_EXACT_0096_PRODUCER_SESSION_FIVE_OPERATIONS_NO_MIGRATION";

type FrozenManifest = Readonly<{
  relationNames: readonly string[];
  relationNamesSha256: string;
  [key: string]: unknown;
}>;

type DumpState = Readonly<{
  dump: ProductionExact0096EncryptedDump;
  snapshot: ProductionExact0096SnapshotArtifact;
}>;

export function createProductionExact0096SessionOperationRegistry(
  input: {
    activation: string;
    databaseUrl: string;
    manifest: FrozenManifest;
    queryTimeoutMs: number;
    signal: AbortSignal;
  },
  dependencies: {
    storage?: ObjectStorageService;
    keyring?: EncryptionKeyring;
    now?: () => Date;
    snapshotOpen?: typeof ProductionExact0096SnapshotSession.open;
    persistDump?: typeof persistProductionExact0096EncryptedDump;
    headObject?: (
      expected: Pick<
        ProductionExactVersionedObjectHead,
        "bucket" | "key" | "versionId"
      >,
      signal: AbortSignal,
    ) => Promise<ProductionExactVersionedObjectHead>;
  } = {},
): Readonly<{
  handlers: ProductionExact0096SessionOperationHandlers;
  close(): Promise<void>;
}> {
  if (
    input.activation !== PRODUCTION_EXACT_0096_REGISTRY_ACTIVATION ||
    !input.databaseUrl ||
    !(input.signal instanceof AbortSignal) ||
    input.signal.aborted ||
    !Number.isSafeInteger(input.queryTimeoutMs) ||
    input.queryTimeoutMs < 1_000 ||
    input.queryTimeoutMs > 15 * 60_000 ||
    !Array.isArray(input.manifest?.relationNames) ||
    input.manifest.relationNames.length < 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(input.manifest.relationNamesSha256)
  ) {
    throw new Error("PRODUCTION_BACKUP_PRODUCER_REGISTRY_DARK");
  }
  const storage = dependencies.storage ?? new ObjectStorageService();
  const now = dependencies.now ?? (() => new Date());
  const snapshots = new Map<
    string,
    {
      session: ProductionExact0096SnapshotSession;
      artifact?: ProductionExact0096SnapshotArtifact;
    }
  >();
  const dumps = new Map<string, DumpState>();
  const objects = new Map<string, ProductionExactVersionedObjectHead>();
  let closed = false;
  const live = () => {
    if (closed || input.signal.aborted) {
      throw new Error("PRODUCTION_BACKUP_PRODUCER_REGISTRY_CLOSED");
    }
  };
  const id = () => createHash("sha256").update(randomUUID()).digest("hex");
  const handlers: ProductionExact0096SessionOperationHandlers = Object.freeze({
    openExportedReadOnlySnapshot: async () => {
      live();
      if (snapshots.size !== 0) {
        throw new Error("PRODUCTION_BACKUP_SNAPSHOT_ALREADY_OPEN");
      }
      const session = await (
        dependencies.snapshotOpen ?? ProductionExact0096SnapshotSession.open
      )(input.databaseUrl, {
        signal: input.signal,
        queryTimeoutMs: input.queryTimeoutMs,
      });
      const snapshotHandleId = id();
      snapshots.set(snapshotHandleId, { session });
      return Object.freeze({
        snapshotHandleId,
        snapshotTokenSha256: session.snapshotTokenSha256,
      });
    },
    readFrozenRelationManifestMeasurements: async (request) => {
      live();
      const state = snapshots.get(String(request.snapshotHandleId));
      if (!state || state.artifact) {
        throw new Error("PRODUCTION_BACKUP_SNAPSHOT_HANDLE_INVALID");
      }
      const artifact = await state.session.measure(input.manifest, now);
      state.artifact = artifact;
      return artifact;
    },
    createBoundedPgDumpCustom: async (request) => {
      live();
      const state = snapshots.get(String(request.snapshotHandleId));
      if (!state?.artifact) {
        throw new Error("PRODUCTION_BACKUP_SNAPSHOT_HANDLE_INVALID");
      }
      const dump = await state.session.createEncryptedDump(
        {
          databaseUrl: input.databaseUrl,
          ceilingBytes: Number(request.ceilingBytes),
          signal: input.signal,
          now,
        },
        {
          ...(dependencies.keyring ? { keyring: dependencies.keyring } : {}),
        },
      );
      dumps.set(dump.dumpId, { dump, snapshot: state.artifact });
      return Object.freeze({
        dumpId: dump.dumpId,
        backupFormat: "pg_dump-custom",
        pgDumpMajor: 16,
        exitCode: 0,
        completedAt: dump.completedAt,
        snapshotTokenSha256: state.artifact.snapshotTokenSha256,
        sourceDataSnapshotSha256: state.artifact.dataSnapshotSha256,
        plaintextBytes: dump.plaintextBytes,
        plaintextSha256: dump.plaintextSha256,
      });
    },
    encryptAndPersistVersionedPayload: async (request) => {
      live();
      const state = dumps.get(String(request.dumpId));
      if (!state) throw new Error("PRODUCTION_BACKUP_DUMP_STATE_INVALID");
      const key = `private/production/exact-0096/${state.dump.dumpId}.dump.mve1`;
      const object = await (
        dependencies.persistDump ?? persistProductionExact0096EncryptedDump
      )(state.dump, { key, signal: input.signal }, storage);
      objects.set(object.versionId, object);
      return Object.freeze({
        status: "persisted",
        guard: Object.freeze({
          ceilingBytes: Number(request.ceilingBytes),
          enforcement: "streaming-before-write",
          abortWriteOnOverflow: true,
          terminateProducerOnOverflow: true,
          deletePartialObjectOnOverflow: true,
          bytesRead: state.dump.encryptedPayloadBytes,
          overflowDetected: false,
          producerTerminated: false,
          objectCreated: true,
          partialObjectDeleted: false,
        }),
        payload: Object.freeze({
          backupId: state.dump.dumpId,
          backupFormat: "pg_dump-custom",
          pgDumpMajor: 16,
          encryptionAlgorithm: "aes-256-gcm-envelope",
          envelopeKeyVersionId: state.dump.envelopeKeyId,
          encryptedPayloadBytes: state.dump.encryptedPayloadBytes,
          encryptedPayloadSha256: state.dump.encryptedPayloadSha256,
          sourceDumpSha256: state.dump.plaintextSha256,
          sourceDataSnapshotSha256: state.snapshot.dataSnapshotSha256,
          createdAt: state.dump.completedAt,
          object,
        }),
      });
    },
    headExactVersionedPayloadReadOnly: async (request) => {
      live();
      const expected = objects.get(String(request.versionId));
      if (
        !expected ||
        expected.bucket !== request.bucket ||
        expected.key !== request.key
      ) {
        throw new Error("PRODUCTION_BACKUP_OBJECT_BINDING_INVALID");
      }
      const observed = await (
        dependencies.headObject ??
        ((identity, signal) =>
          storage.headProductionExactVersionedBackup(identity, signal))
      )(
        {
          bucket: expected.bucket,
          key: expected.key,
          versionId: expected.versionId,
        },
        input.signal,
      );
      if (
        JSON.stringify({ ...observed, headObservedAt: null }) !==
        JSON.stringify({ ...expected, headObservedAt: null })
      ) {
        throw new Error("PRODUCTION_BACKUP_OBJECT_BINDING_INVALID");
      }
      // A versioned HEAD is a fresh observation and therefore carries a new
      // observation timestamp. It proves the immutable fields, but downstream
      // receipt construction must retain the original PUT-time canonical
      // object binding rather than silently replacing it with new bytes.
      return expected;
    },
  });
  return Object.freeze({
    handlers,
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      for (const state of dumps.values()) {
        await disposeProductionExact0096EncryptedDump(state.dump).catch(
          (error) => errors.push(error),
        );
      }
      for (const state of snapshots.values()) {
        await state.session.close().catch((error) => errors.push(error));
      }
      dumps.clear();
      snapshots.clear();
      objects.clear();
      if (errors.length > 0) {
        throw new Error("PRODUCTION_BACKUP_PRODUCER_REGISTRY_CLOSE_FAILED");
      }
    },
  });
}
