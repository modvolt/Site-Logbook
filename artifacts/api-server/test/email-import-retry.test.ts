import {
  describe,
  it,
  expect,
  beforeAll,
  afterEach,
  afterAll,
  vi,
} from "vitest";
import { eq, like } from "drizzle-orm";
import { Readable } from "node:stream";
import { db, emailImportLogTable } from "@workspace/db";

/**
 * Automated cover for the incoming-mail importer's retry state machine
 * (email-import.ts). The recently added attempt cap turns a message that keeps
 * failing into a terminal `failed_permanent` row so it stops being re-attempted
 * on every poll, while a transient failure that later succeeds self-heals below
 * the cap. None of that was verified by a test, so a future change could
 * silently reintroduce the infinite-retry loop (or break the self-heal path).
 *
 * Strategy: the IMAP layer (imapflow) and the slow ingest (`ingestFile`) are
 * mocked so no network/storage is touched, but the REAL DB (DATABASE_URL) is
 * used so the actual Drizzle queries that drive the dedupe / attempt-counting
 * (findExistingLog → writeLog) are exercised. Each poll re-presents the SAME
 * unseen message (failures never get marked \Seen), exactly as a real mailbox
 * would on the next poll. Requires the email_import_log table incl. the
 * `attempts` column — see .agents/memory/test-db-schema-drift.md.
 */

const mocks = vi.hoisted(() => ({
  ingestFile: vi.fn(),
  state: { messageId: "", uid: 1 } as { messageId: string; uid: number },
}));

// Control the per-message ingest outcome (success vs. throw) without any S3/DB
// work. email-import.ts imports only `ingestFile` from this module.
vi.mock("../src/lib/cost-document-service", () => ({
  ingestFile: mocks.ingestFile,
}));

// A minimal in-memory IMAP client. It always presents exactly ONE unseen
// message (the current test's message id) carrying a single PDF attachment.
vi.mock("imapflow", () => {
  class FakeImapFlow {
    constructor(_opts: unknown) {}
    on(): this {
      return this;
    }
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
    async mailboxOpen(): Promise<{ exists: number }> {
      return { exists: 1 };
    }
    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release() {} };
    }
    async search(): Promise<number[]> {
      return [mocks.state.uid];
    }
    fetch(): AsyncGenerator<unknown> {
      const msg = {
        uid: mocks.state.uid,
        envelope: {
          messageId: mocks.state.messageId,
          subject: "Faktura",
          from: [{ address: "dod@example.test", name: "Dodavatel" }],
        },
        internalDate: new Date(),
        bodyStructure: {
          childNodes: [
            { part: "1", type: "text/plain" },
            {
              part: "2",
              type: "application/pdf",
              disposition: "attachment",
              dispositionParameters: { filename: "faktura.pdf" },
            },
          ],
        },
      };
      return (async function* () {
        yield msg;
      })();
    }
    async download(): Promise<{ content: Readable }> {
      return { content: Readable.from([Buffer.from("pdf-bytes")]) };
    }
    async messageFlagsAdd(): Promise<void> {}
  }
  return { ImapFlow: FakeImapFlow };
});

// Make resolveImapConfig() return a (single-folder) config via the env fallback;
// the mocked ImapFlow never actually connects, so the values are irrelevant
// beyond being present. Set before importing the module under test.
process.env.IMAP_HOST = "imap.example.test";
process.env.IMAP_USER = "user@example.test";
process.env.IMAP_PASSWORD = "secret";
process.env.IMAP_FOLDER = "INBOX";

const { pollOnce, retryLogEntry } = await import("../src/lib/email-import");

const MAX_IMPORT_ATTEMPTS = 5;
const TAG = `test-retry-${Date.now()}`;
let seq = 0;

// A fresh, unique message id per test so rows never collide across tests.
function nextMessageId(): string {
  seq += 1;
  const id = `<${TAG}-${seq}@example.test>`;
  mocks.state.messageId = id;
  return id;
}

async function getLog(messageId: string) {
  const [row] = await db
    .select()
    .from(emailImportLogTable)
    .where(eq(emailImportLogTable.messageId, messageId))
    .limit(1);
  return row;
}

afterEach(() => {
  mocks.ingestFile.mockReset();
});

afterAll(async () => {
  await db
    .delete(emailImportLogTable)
    .where(like(emailImportLogTable.messageId, `<${TAG}-%`));
});

describe("email-import retry cap (failed → failed_permanent)", () => {
  it("increments attempts on each failing poll and flips to failed_permanent exactly at the cap", async () => {
    const messageId = nextMessageId();
    // Every ingest attempt throws → the message can never succeed.
    mocks.ingestFile.mockRejectedValue(new Error("corrupt attachment"));

    // Polls 1..(cap-1) keep the row in the non-terminal `failed` state with a
    // rising attempt count.
    for (let attempt = 1; attempt < MAX_IMPORT_ATTEMPTS; attempt++) {
      const result = await pollOnce();
      expect(result.failed).toBe(1);
      const row = await getLog(messageId);
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(attempt);
    }

    // The cap-th poll settles the message into the terminal state.
    const capResult = await pollOnce();
    expect(capResult.failed).toBe(1);
    const capped = await getLog(messageId);
    expect(capped.status).toBe("failed_permanent");
    expect(capped.attempts).toBe(MAX_IMPORT_ATTEMPTS);
    expect(capped.error).toMatch(/zastaveny/); // "další automatické pokusy zastaveny"

    // ingestFile was invoked once per poll up to and including the cap.
    expect(mocks.ingestFile).toHaveBeenCalledTimes(MAX_IMPORT_ATTEMPTS);

    // A subsequent poll must NOT re-attempt the now-terminal message: the
    // dedupe skips it, so nothing is processed and ingestFile is not called.
    const afterCap = await pollOnce();
    expect(afterCap.processed).toBe(0);
    expect(afterCap.failed).toBe(0);
    expect(mocks.ingestFile).toHaveBeenCalledTimes(MAX_IMPORT_ATTEMPTS);
    const unchanged = await getLog(messageId);
    expect(unchanged.status).toBe("failed_permanent");
    expect(unchanged.attempts).toBe(MAX_IMPORT_ATTEMPTS);
  });

  it("self-heals: a message that fails once then succeeds never becomes terminal", async () => {
    const messageId = nextMessageId();

    // First poll fails (transient error) → non-terminal `failed`, attempts = 1.
    mocks.ingestFile.mockRejectedValueOnce(new Error("Connection not available"));
    // Next poll succeeds → a cost document is created.
    mocks.ingestFile.mockResolvedValue({
      status: "created",
      document: { id: 12345 },
    });

    const first = await pollOnce();
    expect(first.failed).toBe(1);
    const afterFail = await getLog(messageId);
    expect(afterFail.status).toBe("failed");
    expect(afterFail.attempts).toBe(1);

    const second = await pollOnce();
    expect(second.imported).toBe(1);
    const healed = await getLog(messageId);
    expect(healed.status).toBe("imported");
    expect(healed.status).not.toBe("failed_permanent");
    // The success path clears the leftover error from the failed attempt.
    expect(healed.error).toBeNull();

    // The now-terminal `imported` row is deduped on the next poll.
    const third = await pollOnce();
    expect(third.processed).toBe(0);
    expect(mocks.ingestFile).toHaveBeenCalledTimes(2);
  });
});

describe("retryLogEntry re-arms a terminal failure", () => {
  it("flips a failed_permanent row back to failed with attempts reset to 0", async () => {
    const messageId = `<${TAG}-retry-perm@example.test>`;
    const [row] = await db
      .insert(emailImportLogTable)
      .values({
        messageId,
        status: "failed_permanent",
        attempts: MAX_IMPORT_ATTEMPTS,
        error: "broken (po 5 pokusech, další automatické pokusy zastaveny)",
      })
      .returning();

    const ok = await retryLogEntry(row.id);
    expect(ok).toBe(true);

    const rearmed = await getLog(messageId);
    expect(rearmed.status).toBe("failed");
    expect(rearmed.attempts).toBe(0);
  });

  it("returns false for a non-terminal (failed) row and leaves it untouched", async () => {
    const messageId = `<${TAG}-retry-failed@example.test>`;
    const [row] = await db
      .insert(emailImportLogTable)
      .values({ messageId, status: "failed", attempts: 2 })
      .returning();

    const ok = await retryLogEntry(row.id);
    expect(ok).toBe(false);

    const unchanged = await getLog(messageId);
    expect(unchanged.status).toBe("failed");
    expect(unchanged.attempts).toBe(2);
  });

  it("returns false for a missing row", async () => {
    const ok = await retryLogEntry(2_000_000_000);
    expect(ok).toBe(false);
  });
});

describe("terminal rows are skipped by the next poll's dedupe", () => {
  const TERMINAL_STATUSES = [
    "imported",
    "skipped",
    "no_attachments",
    "failed_permanent",
  ];

  for (const status of TERMINAL_STATUSES) {
    it(`does not re-process a "${status}" message`, async () => {
      const messageId = nextMessageId();
      const [row] = await db
        .insert(emailImportLogTable)
        .values({ messageId, status, attempts: status === "failed_permanent" ? MAX_IMPORT_ATTEMPTS : 0 })
        .returning();

      // ingestFile would throw if ever called — proving it is not.
      mocks.ingestFile.mockRejectedValue(new Error("must not be called"));

      const result = await pollOnce();
      expect(result.processed).toBe(0);
      expect(mocks.ingestFile).not.toHaveBeenCalled();

      const after = await getLog(messageId);
      expect(after.status).toBe(status);
      expect(after.id).toBe(row.id); // same row, untouched (no second insert)
    });
  }
});
