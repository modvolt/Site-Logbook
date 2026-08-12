import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalizeProductionExact0096JsonText,
  createProductionExact0096EncryptedPgDump,
  disposeProductionExact0096EncryptedDump,
  measureProductionExact0096Relations,
  streamDecryptProductionExact0096Mve1,
} from "../src/lib/production-exact-0096-backup-producer";
import { decryptBackupArtifactPayload } from "../src/lib/secret-envelope";
import type { EncryptionKeyring } from "../src/lib/secret-envelope";

function keyring(): EncryptionKeyring {
  return {
    activeKeyId: "backup-key-version-2026-08",
    keys: new Map([["backup-key-version-2026-08", Buffer.alloc(32, 7)]]),
  };
}

function fakePgDump(payload: Buffer) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      child.stdout.end(payload);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  });
}

describe("production exact-0096 producer", () => {
  it("canonicalizes nested JSON without losing decimal text", () => {
    expect(
      canonicalizeProductionExact0096JsonText(
        '[9007199254740993.125, {"z": 2, "a": [true, null, "x"]}]',
      ),
    ).toBe('[9007199254740993.125,{"a":[true,null,"x"],"z":2}]');
    expect(() =>
      canonicalizeProductionExact0096JsonText('{"a":1,"a":2}'),
    ).toThrow(/Duplicate/);
  });

  it("measures canonical content by fixed cursor pages and exact relation names", async () => {
    let fetch = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM pg_catalog.pg_class c")) {
        return {
          rows: [
            {
              schema_name: "public",
              relation_name: "jobs",
              relation_kind: "r",
              persistence: "p",
              is_partition: false,
            },
          ],
        };
      }
      if (sql.includes("pg_catalog.pg_attribute")) {
        return {
          rows: [
            {
              column_name: "id",
              ordinal_position: 1,
              primary_key_ordinal: 1,
            },
            {
              column_name: "amount",
              ordinal_position: 2,
              primary_key_ordinal: null,
            },
          ],
        };
      }
      if (sql.includes("max(pg_catalog.octet_length")) {
        return {
          rows: [{ row_count: "1", max_row_bytes: "12", total_bytes: "12" }],
        };
      }
      if (sql.startsWith("FETCH")) {
        fetch += 1;
        return fetch === 1
          ? { rows: [{ canonical_row: '["a", 10.50]' }] }
          : { rows: [] };
      }
      return { rows: [] };
    });
    const result = await measureProductionExact0096Relations(
      { query } as never,
      ["public.jobs"],
      { signal: new AbortController().signal, fetchRows: 1 },
    );
    expect(result["public.jobs"].rowCount).toBe(1);
    expect(result["public.jobs"].contentSha256).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes('to_jsonb("id")::text COLLATE "C" ASC'),
      ),
    ).toBe(true);
    await expect(
      measureProductionExact0096Relations({ query } as never, ["Public.jobs"], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/RELATION_INVALID/);
  });

  it("rejects extra and unsupported live catalog relations before row reads", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM pg_catalog.pg_class c")) {
        return {
          rows: [
            {
              schema_name: "public",
              relation_name: "jobs",
              relation_kind: "r",
              persistence: "p",
              is_partition: false,
            },
            {
              schema_name: "public",
              relation_name: "surprise",
              relation_kind: "r",
              persistence: "u",
              is_partition: false,
            },
          ],
        };
      }
      return { rows: [] };
    });
    await expect(
      measureProductionExact0096Relations({ query } as never, ["public.jobs"], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/UNSUPPORTED_RELATION/);
  });

  it("streams pg_dump through a compatible authenticated MVE1 envelope", async () => {
    const plaintext = Buffer.from("PGDMP\0deterministic production dump bytes");
    const controller = new AbortController();
    const spawnProcess = fakePgDump(plaintext);
    const dump = await createProductionExact0096EncryptedPgDump(
      {
        databaseUrl: "postgres://backup:unused@db:5432/site_logbook",
        exportedSnapshotId: "00000003-0000001B-1",
        dumpId: "prod-dump-test-0001",
        ceilingBytes: 64 * 1024,
        signal: controller.signal,
        now: () => new Date("2026-08-12T10:00:00.000Z"),
      },
      { spawnProcess: spawnProcess as never, keyring: keyring() },
    );
    const destination = new PassThrough();
    const chunks: Buffer[] = [];
    destination.on("data", (chunk: Buffer) => chunks.push(chunk));
    const encrypted = (await import("node:fs")).createReadStream(
      dump.encryptedPath,
    );
    const restored = await streamDecryptProductionExact0096Mve1(
      {
        encrypted,
        destination,
        dumpId: dump.dumpId,
        encryptedPayloadBytes: dump.encryptedPayloadBytes,
        encryptedPayloadSha256: dump.encryptedPayloadSha256,
        plaintextCeilingBytes: 64 * 1024,
        signal: controller.signal,
      },
      { keyring: keyring() },
    );
    expect(Buffer.concat(chunks)).toEqual(plaintext);
    expect(restored.plaintextBytes).toBe(plaintext.length);
    expect(restored.plaintextSha256).toBe(dump.plaintextSha256);
    const encryptedBytes = await (
      await import("node:fs/promises")
    ).readFile(dump.encryptedPath);
    expect(
      decryptBackupArtifactPayload(
        encryptedBytes,
        `production-exact-0096:${dump.dumpId}:pg_dump`,
        keyring(),
      ),
    ).toEqual(plaintext);
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      "--no-owner",
      "--no-acl",
      "--snapshot=00000003-0000001B-1",
      "--format=custom",
    ]);
    expect(spawnProcess.mock.calls[0][2].env.PGDATABASE).toBe("site_logbook");
    expect(JSON.stringify(spawnProcess.mock.calls[0][1])).not.toContain(
      "unused",
    );
    await disposeProductionExact0096EncryptedDump(dump);
  });

  it("emits no plaintext when GCM authentication fails at final", async () => {
    const controller = new AbortController();
    const dump = await createProductionExact0096EncryptedPgDump(
      {
        databaseUrl: "postgres://backup:unused@db:5432/site_logbook",
        exportedSnapshotId: "00000003-0000001B-1",
        dumpId: "prod-dump-test-auth-failure",
        ceilingBytes: 64 * 1024,
        signal: controller.signal,
      },
      {
        spawnProcess: fakePgDump(
          Buffer.from("PGDMP authenticated bytes"),
        ) as never,
        keyring: keyring(),
      },
    );
    try {
      const bytes = await (
        await import("node:fs/promises")
      ).readFile(dump.encryptedPath);
      bytes[bytes.length - 1] ^= 1;
      const destination = new PassThrough();
      const emitted: Buffer[] = [];
      destination.on("data", (chunk: Buffer) => emitted.push(chunk));
      await expect(
        streamDecryptProductionExact0096Mve1(
          {
            encrypted: Readable.from(bytes),
            destination,
            dumpId: dump.dumpId,
            encryptedPayloadBytes: bytes.length,
            encryptedPayloadSha256: `sha256:${(await import("node:crypto"))
              .createHash("sha256")
              .update(bytes)
              .digest("hex")}`,
            plaintextCeilingBytes: 64 * 1024,
            signal: controller.signal,
          },
          { keyring: keyring() },
        ),
      ).rejects.toThrow();
      expect(emitted).toEqual([]);
    } finally {
      await disposeProductionExact0096EncryptedDump(dump);
    }
  });

  it("terminates the producer and leaves no result on the first overflow byte", async () => {
    const directory = await mkdtemp(join(tmpdir(), "producer-test-parent-"));
    const spawnProcess = fakePgDump(Buffer.alloc(5000, 1));
    try {
      await expect(
        createProductionExact0096EncryptedPgDump(
          {
            databaseUrl: "postgres://backup:unused@db:5432/site_logbook",
            exportedSnapshotId: "00000003-0000001B-1",
            dumpId: "prod-dump-test-overflow",
            ceilingBytes: 4096,
            signal: new AbortController().signal,
          },
          { spawnProcess: spawnProcess as never, keyring: keyring() },
        ),
      ).rejects.toThrow(/STREAMING_OVERFLOW_REJECTED/);
      const child = spawnProcess.mock.results[0].value;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
