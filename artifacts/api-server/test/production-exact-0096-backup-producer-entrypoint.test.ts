import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readCanonicalProductionBackupProducerRequest,
  runProductionExact0096BackupProducerCli,
} from "../src/production-exact-0096-backup-producer";

describe("production exact-0096 producer CLI boundary", () => {
  it("accepts only one bounded canonical request file and remains default-dark", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-entrypoint-"));
    const request = join(directory, "request.json");
    try {
      await writeFile(request, '{"invocationId":"abc12345"}\n');
      const pathPolicy = {
        isReviewedContainerPath: (value: string) => value === request,
      };
      await expect(
        readCanonicalProductionBackupProducerRequest(request, pathPolicy),
      ).resolves.toEqual({
        invocationId: "abc12345",
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
