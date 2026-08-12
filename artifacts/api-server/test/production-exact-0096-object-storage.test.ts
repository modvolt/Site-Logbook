import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetBucketVersioningCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import {
  ObjectStorageService,
  type ProductionExactVersionedObjectHead,
} from "../src/lib/objectStorage";

const digest = `sha256:${"a".repeat(64)}`;
const endpoint = "https://fsn1.your-objectstorage.com";
const region = "fsn1";
const endpointOriginSha256 = `sha256:${createHash("sha256")
  .update(endpoint)
  .digest("hex")}`;

function input() {
  return {
    key: "private/production/exact-0096/prod-backup-0001.dump.enc",
    body: Readable.from(Buffer.alloc(32)),
    contentLength: 32,
    encryptedPayloadSha256: digest,
    signal: new AbortController().signal,
  };
}

function head(versionId = "version-0001") {
  return {
    VersionId: versionId,
    ContentLength: 32,
    ETag: `"${"b".repeat(32)}"`,
    Metadata: {
      sha256: "a".repeat(64),
      "client-side-encryption": "mve1",
      "encryption-boundary": "client-envelope-only",
      "storage-provider": "hetzner-object-storage",
    },
  };
}

const dependencies = {
  bucket: "site-logbook-production-backups",
  endpoint,
  region,
};

describe("production exact-0096 Hetzner Object Storage binding", () => {
  it("uses no-clobber PUT and independently HEADs the exact durable version", async () => {
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetBucketVersioningCommand)
          return { Status: "Enabled" };
        if (command instanceof PutObjectCommand)
          return { VersionId: "version-0001" };
        if (command instanceof HeadObjectCommand) return head();
        throw new Error("unexpected command");
      }),
    };
    const result =
      await new ObjectStorageService().putProductionExactVersionedBackup(
        input(),
        {
          ...dependencies,
          client: client as never,
          now: () => new Date("2026-08-12T10:00:00.000Z"),
        },
      );
    expect(commands[0]).toBeInstanceOf(GetBucketVersioningCommand);
    expect(commands[1]).toBeInstanceOf(PutObjectCommand);
    const put = (commands[1] as PutObjectCommand).input;
    expect(put.IfNoneMatch).toBe("*");
    expect(put.ServerSideEncryption).toBeUndefined();
    expect(put.SSEKMSKeyId).toBeUndefined();
    expect(put.Metadata).toEqual({
      sha256: "a".repeat(64),
      "client-side-encryption": "mve1",
      "encryption-boundary": "client-envelope-only",
      "storage-provider": "hetzner-object-storage",
    });
    expect(commands[2]).toBeInstanceOf(HeadObjectCommand);
    expect((commands[2] as HeadObjectCommand).input.VersionId).toBe(
      "version-0001",
    );
    expect(result.storageProvider).toEqual({
      kind: "hetzner-object-storage",
      endpointOriginSha256,
      region,
      encryptionBoundary: "client-envelope-only",
      transport: "https",
      versioning: "enabled",
    });
  });

  it("rejects MinIO, HTTP and non-Hetzner endpoints before object I/O", async () => {
    const client = { send: vi.fn() };
    for (const invalidEndpoint of [
      "http://fsn1.your-objectstorage.com",
      "https://s3.eu-central-1.amazonaws.com",
      "http://minio:9000",
    ]) {
      await expect(
        new ObjectStorageService().putProductionExactVersionedBackup(input(), {
          ...dependencies,
          client: client as never,
          endpoint: invalidEndpoint,
        }),
      ).rejects.toThrow(/canonical HTTPS Hetzner/);
    }
    expect(client.send).not.toHaveBeenCalled();
  });

  it("fails closed when PUT omits VersionId and cleanup cannot be proven", async () => {
    const client = {
      send: vi.fn(async (command: unknown) =>
        command instanceof GetBucketVersioningCommand
          ? { Status: "Enabled" }
          : { VersionId: undefined },
      ),
    };
    await expect(
      new ObjectStorageService().putProductionExactVersionedBackup(input(), {
        ...dependencies,
        client: client as never,
      }),
    ).rejects.toThrow(/no durable object version/);
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it("proves versioning before PUT and deletes only an exactly observed missing-id version", async () => {
    const disabledClient = {
      send: vi.fn(async () => ({ Status: "Suspended" })),
    };
    await expect(
      new ObjectStorageService().putProductionExactVersionedBackup(input(), {
        ...dependencies,
        client: disabledClient as never,
      }),
    ).rejects.toThrow(/versioning is Enabled/);
    expect(disabledClient.send).toHaveBeenCalledTimes(1);

    const commands: unknown[] = [];
    const cleanupClient = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetBucketVersioningCommand)
          return { Status: "Enabled" };
        if (command instanceof PutObjectCommand)
          return { VersionId: undefined, ETag: `"${"c".repeat(32)}"` };
        if (command instanceof HeadObjectCommand)
          return {
            VersionId: "recovered-version-0001",
            ETag: `"${"c".repeat(32)}"`,
          };
        if (command instanceof DeleteObjectCommand) return {};
        throw new Error("unexpected command");
      }),
    };
    await expect(
      new ObjectStorageService().putProductionExactVersionedBackup(input(), {
        ...dependencies,
        client: cleanupClient as never,
      }),
    ).rejects.toThrow(/exact observed version was deleted/);
    expect(commands[3]).toBeInstanceOf(DeleteObjectCommand);
    expect((commands[3] as DeleteObjectCommand).input.VersionId).toBe(
      "recovered-version-0001",
    );
  });

  it("deletes only the just-created exact version when independent HEAD differs", async () => {
    const commands: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetBucketVersioningCommand)
          return { Status: "Enabled" };
        if (command instanceof PutObjectCommand)
          return { VersionId: "version-0002" };
        if (command instanceof HeadObjectCommand)
          return { ...head("version-0002"), ContentLength: 31 };
        if (command instanceof DeleteObjectCommand) return {};
        throw new Error("unexpected command");
      }),
    };
    await expect(
      new ObjectStorageService().putProductionExactVersionedBackup(input(), {
        ...dependencies,
        client: client as never,
      }),
    ).rejects.toThrow(/HEAD did not reproduce/);
    expect(commands[3]).toBeInstanceOf(DeleteObjectCommand);
    expect((commands[3] as DeleteObjectCommand).input.VersionId).toBe(
      "version-0002",
    );
  });

  it("streams GET only when versioning and exact MVE1 metadata repeat", async () => {
    const expected: ProductionExactVersionedObjectHead = {
      bucket: dependencies.bucket,
      key: "private/production/exact-0096/prod-backup-0003.dump.enc",
      versionId: "version-0003",
      headObservedAt: "2026-08-12T10:00:00.000Z",
      headContentLength: 32,
      headEtag: `"${"b".repeat(32)}"`,
      headObjectSha256Metadata: digest,
      storageProvider: {
        kind: "hetzner-object-storage",
        endpointOriginSha256,
        region,
        encryptionBoundary: "client-envelope-only",
        transport: "https",
        versioning: "enabled",
      },
    };
    const body = new PassThrough();
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof GetBucketVersioningCommand)
          return { Status: "Enabled" };
        expect(command).toBeInstanceOf(GetObjectCommand);
        return { Body: body, ...head(expected.versionId) };
      }),
    };
    const opened =
      await new ObjectStorageService().openProductionExactVersionedBackup(
        expected,
        new AbortController().signal,
        { ...dependencies, client: client as never },
      );
    expect(opened).toBe(body);
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it("rejects provider-binding drift before reading the object", async () => {
    const expected: ProductionExactVersionedObjectHead = {
      bucket: dependencies.bucket,
      key: "private/production/exact-0096/prod-backup-0004.dump.enc",
      versionId: "version-0004",
      headObservedAt: "2026-08-12T10:00:00.000Z",
      headContentLength: 32,
      headEtag: `"${"b".repeat(32)}"`,
      headObjectSha256Metadata: digest,
      storageProvider: {
        kind: "hetzner-object-storage",
        endpointOriginSha256,
        region,
        encryptionBoundary: "client-envelope-only",
        transport: "https",
        versioning: "enabled",
      },
    };
    const client = { send: vi.fn() };
    await expect(
      new ObjectStorageService().openProductionExactVersionedBackup(
        expected,
        new AbortController().signal,
        {
          client: client as never,
          endpoint: "https://hel1.your-objectstorage.com",
          region: "hel1",
        },
      ),
    ).rejects.toThrow(/does not match the reviewed Hetzner binding/);
    expect(client.send).not.toHaveBeenCalled();
  });
});
