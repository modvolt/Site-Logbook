import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS,
  readCanonicalProductionBackupProducerRequest,
  runProductionExact0096BackupProducerCli,
  type ProductionExact0096ProducerOperationHandlers,
} from "../src/production-exact-0096-backup-producer";

function handlers(
  handler: ProductionExact0096ProducerOperationHandlers["observeExecutorIdentity"],
): ProductionExact0096ProducerOperationHandlers {
  return Object.fromEntries(
    PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS.map((operation) => [
      operation,
      operation === "observeExecutorIdentity"
        ? handler
        : async () => {
            throw new Error("unexpected operation");
          },
    ]),
  ) as unknown as ProductionExact0096ProducerOperationHandlers;
}

describe("production exact-0096 producer CLI boundary", () => {
  it("accepts only one bounded canonical request file and remains default-dark", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-entrypoint-"));
    const request = join(directory, "request.json");
    try {
      await writeFile(request, `{"planSha256":"sha256:${"a".repeat(64)}"}\n`);
      const pathPolicy = {
        isReviewedContainerPath: (value: string) => value === request,
      };
      await expect(
        readCanonicalProductionBackupProducerRequest(request, pathPolicy),
      ).resolves.toEqual({
        planSha256: `sha256:${"a".repeat(64)}`,
      });
      const stderr: string[] = [];
      const status = await runProductionExact0096BackupProducerCli(
        ["observeExecutorIdentity", "--request-file", request],
        { stdout: () => undefined, stderr: (value) => stderr.push(value) },
        pathPolicy,
      );
      expect(status).toBe(1);
      expect(stderr).toEqual([
        "PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED\n",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dispatches one exact reviewed operation and emits bounded canonical output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-entrypoint-"));
    const request = join(directory, "request.json");
    try {
      await writeFile(request, `{"planSha256":"sha256:${"a".repeat(64)}"}\n`);
      const stdout: string[] = [];
      const status = await runProductionExact0096BackupProducerCli(
        ["observeExecutorIdentity", "--request-file", request],
        { stdout: (value) => stdout.push(value), stderr: () => undefined },
        {
          isReviewedContainerPath: (value) => value === request,
          operationHandlers: handlers(async (value) => ({
            invocationId: "b".repeat(64),
            planSha256: value.planSha256,
          })),
        },
      );
      expect(status).toBe(0);
      expect(stdout).toEqual([
        `{"invocationId":"${"b".repeat(64)}","planSha256":"sha256:${"a".repeat(64)}"}\n`,
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects partial handler registries, confused-deputy requests and secret output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-entrypoint-"));
    const request = join(directory, "request.json");
    const pathPolicy = {
      isReviewedContainerPath: (value: string) => value === request,
    };
    try {
      await writeFile(
        request,
        '{"transactionMode":"repeatable-read-read-only"}\n',
      );
      const errors: string[] = [];
      expect(
        await runProductionExact0096BackupProducerCli(
          ["observeExecutorIdentity", "--request-file", request],
          { stdout: () => undefined, stderr: (value) => errors.push(value) },
          {
            ...pathPolicy,
            operationHandlers: handlers(async () => ({ safe: true })),
          },
        ),
      ).toBe(1);
      expect(errors.pop()).toBe("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID\n");

      await writeFile(request, `{"planSha256":"sha256:${"a".repeat(64)}"}\n`);
      expect(
        await runProductionExact0096BackupProducerCli(
          ["observeExecutorIdentity", "--request-file", request],
          { stdout: () => undefined, stderr: (value) => errors.push(value) },
          {
            ...pathPolicy,
            operationHandlers: {
              observeExecutorIdentity: async () => ({ safe: true }),
            } as unknown as ProductionExact0096ProducerOperationHandlers,
          },
        ),
      ).toBe(1);
      expect(errors.pop()).toBe(
        "PRODUCTION_BACKUP_PRODUCER_HANDLERS_INVALID\n",
      );

      expect(
        await runProductionExact0096BackupProducerCli(
          ["observeExecutorIdentity", "--request-file", request],
          { stdout: () => undefined, stderr: (value) => errors.push(value) },
          {
            ...pathPolicy,
            operationHandlers: handlers(async () => ({
              secretKey: "do-not-emit",
            })),
          },
        ),
      ).toBe(1);
      expect(errors.pop()).toBe("PRODUCTION_BACKUP_PRODUCER_SECRET_REJECTED\n");

      expect(
        await runProductionExact0096BackupProducerCli(
          ["observeExecutorIdentity", "--request-file", request],
          { stdout: () => undefined, stderr: (value) => errors.push(value) },
          {
            ...pathPolicy,
            operationHandlers: handlers(async () => ({
              location: "https://safe.invalid/?api_key=do-not-emit",
            })),
          },
        ),
      ).toBe(1);
      expect(errors.pop()).toBe("PRODUCTION_BACKUP_PRODUCER_SECRET_REJECTED\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects key-correct but semantically invalid requests before dispatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-entrypoint-"));
    const request = join(directory, "request.json");
    const calls: unknown[] = [];
    try {
      await writeFile(request, '{"planSha256":"sha256:not-a-digest"}\n');
      const errors: string[] = [];
      const status = await runProductionExact0096BackupProducerCli(
        ["observeExecutorIdentity", "--request-file", request],
        { stdout: () => undefined, stderr: (value) => errors.push(value) },
        {
          isReviewedContainerPath: (value) => value === request,
          operationHandlers: handlers(async (value) => {
            calls.push(value);
            return { safe: true };
          }),
        },
      );
      expect(status).toBe(1);
      expect(errors).toEqual(["PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID\n"]);
      expect(calls).toEqual([]);

      for (const invalid of [
        {
          bucket: "staging-backups",
          key: "production/exact-0096/a-good-name",
          versionId: "version-123",
        },
        {
          bucket: "modvoltdata",
          key: "production/exact-0096/../escape",
          versionId: "version-123",
        },
      ]) {
        await writeFile(request, `${JSON.stringify(invalid)}\n`);
        const headStatus = await runProductionExact0096BackupProducerCli(
          ["headExactVersionedPayloadReadOnly", "--request-file", request],
          { stdout: () => undefined, stderr: (value) => errors.push(value) },
          {
            isReviewedContainerPath: (value) => value === request,
            operationHandlers: handlers(async (value) => {
              calls.push(value);
              return { safe: true };
            }),
          },
        );
        expect(headStatus).toBe(1);
        expect(errors.pop()).toBe(
          "PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID\n",
        );
      }
      expect(calls).toEqual([]);

      const dump = {
        backupFormat: "pg_dump-custom",
        completedAt: "2026-08-12T20:00:00.000Z",
        dumpId: "prod-dump-aaaaaaaa",
        exitCode: 0,
        pgDumpMajor: 16,
        plaintextBytes: 4096,
        plaintextSha256: `sha256:${"b".repeat(64)}`,
        snapshotTokenSha256: `sha256:${"c".repeat(64)}`,
        sourceDataSnapshotSha256: `sha256:${"d".repeat(64)}`,
      };
      const mismatchedDumpRequest = {
        abortWriteOnOverflow: true,
        ceilingBytes: 256 * 1024 * 1024,
        deletePartialObjectOnOverflow: true,
        dumpCanonical: `${JSON.stringify(dump)}\n`,
        dumpId: "prod-dump-bbbbbbbb",
        enforcement: "streaming-before-write",
        terminateProducerOnOverflow: true,
      };
      await writeFile(request, `${JSON.stringify(mismatchedDumpRequest)}\n`);
      const encryptStatus = await runProductionExact0096BackupProducerCli(
        ["encryptAndPersistVersionedPayload", "--request-file", request],
        { stdout: () => undefined, stderr: (value) => errors.push(value) },
        {
          isReviewedContainerPath: (value) => value === request,
          operationHandlers: handlers(async (value) => {
            calls.push(value);
            return { safe: true };
          }),
        },
      );
      expect(encryptStatus).toBe(1);
      expect(errors.pop()).toBe("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID\n");
      expect(calls).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects noncanonical and credential-bearing request bytes without echoing them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-entrypoint-"));
    const request = join(directory, "request.json");
    try {
      await writeFile(request, '{"databaseUrl":"postgres://u:secret@db/x"}\n');
      const pathPolicy = {
        isReviewedContainerPath: (value: string) => value === request,
      };
      await expect(
        readCanonicalProductionBackupProducerRequest(request, pathPolicy),
      ).rejects.toThrow(/SECRET_REJECTED/);
      await writeFile(request, '{ "value": 1 }\n');
      await expect(
        readCanonicalProductionBackupProducerRequest(request, pathPolicy),
      ).rejects.toThrow(/REQUEST_INVALID/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
