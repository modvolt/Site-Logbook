import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");

const workers = [
  {
    path: "artifacts/api-server/src/lib/backup.ts",
    starts: ["startBackupScheduler", "startRestoreTestScheduler"],
    clears: ["clearTimeout(warmup)", "clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/lib/invoice-reminders.ts",
    starts: ["startReminderScheduler"],
    clears: ["clearTimeout(initial)", "clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/lib/extraction-worker.ts",
    starts: ["startExtractionWorker"],
    clears: ["clearTimeout(initialBackfill)", "clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/lib/email-import.ts",
    starts: ["startEmailImportWorker"],
    clears: ["clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/routes/client-errors.ts",
    starts: ["startClientErrorPurgeScheduler"],
    clears: ["clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/lib/ppe-overdue-notifier.ts",
    starts: ["startPpeOverdueScheduler"],
    clears: ["clearTimeout(initial)", "clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/lib/health-watchdog.ts",
    starts: ["startHealthWatchdog"],
    clears: [
      "clearTimeout(initial)",
      "clearInterval(checkTimer)",
      "clearInterval(purgeTimer)",
    ],
  },
  {
    path: "artifacts/api-server/src/lib/recurring-templates.ts",
    starts: ["startRecurringInvoiceScheduler"],
    clears: ["clearTimeout(initial)", "clearInterval(timer)"],
  },
  {
    path: "artifacts/api-server/src/lib/switchboard-worker.ts",
    starts: ["startSwitchboardWorker"],
    clears: ["clearTimeout(initial)", "clearInterval(timer)"],
  },
] as const;

function readSource(path: string): string {
  return readFileSync(resolve(root, path), "utf8").replace(/\r\n/g, "\n");
}

describe("background worker stop-handle contract", () => {
  for (const worker of workers) {
    it(`${worker.path} exposes a synchronous idempotent stop handle`, () => {
      const source = readSource(worker.path);
      expect(source).toContain(
        "export type SchedulerStopHandle = Readonly<{\n  stop(): void;\n}>;",
      );

      for (const start of worker.starts) {
        expect(source).toContain(
          `export function ${start}(): SchedulerStopHandle`,
        );
      }

      expect(source).toContain("if (stopped) return;");
      expect(source).toContain("stopped = true;");
      for (const clear of worker.clears) expect(source).toContain(clear);
    });
  }

  it("returns the active handle and releases it only from its own stop", () => {
    for (const worker of workers) {
      const source = readSource(worker.path);
      expect(source).toMatch(
        /if \([^\n]*[Ss]chedulerHandle\) return [^\n]*[Ss]chedulerHandle;/,
      );
      expect(source).toMatch(
        /if \([^\n]*[Ss]chedulerHandle === handle\)[\s\S]{0,80}[Ss]chedulerHandle = undefined;/,
      );
    }
  });

  it("aborts extraction work and fences queue and backfill items", () => {
    const source = readSource(
      "artifacts/api-server/src/lib/extraction-worker.ts",
    );
    expect(source).toContain("const abortController = new AbortController()");
    expect(source).toContain("drainQueue(signal)");
    expect(source).toContain("if (isStopped(signal)) break;");
    expect(source).toContain("await processOne(row.id, signal)");
    expect(source).toContain("if (signal.aborted) break;");
    expect(source).toContain(
      "reconcileDocumentRelationshipsUntilStopped(signal)",
    );

    const stop = source.slice(
      source.indexOf("const handle: SchedulerStopHandle"),
    );
    expect(stop.indexOf("abortController.abort()")).toBeLessThan(
      stop.indexOf("clearInterval(timer)"),
    );
  });

  it("resumes an aborted relationship backfill on the next worker start", () => {
    const source = readSource(
      "artifacts/api-server/src/lib/extraction-worker.ts",
    );
    expect(source).toContain("let relationshipBackfillCompleted = false;");
    expect(source).toContain(
      "let relationshipBackfillRun: Promise<void> | undefined;",
    );
    expect(source).toContain("relationshipBackfillCompleted = true;");
    expect(source).toContain("const previousRun = relationshipBackfillRun;");
    expect(source).toContain("if (previousRun) await previousRun;");
    expect(source).toContain("if (relationshipBackfillRun === run)");
    expect(source).toContain("relationshipBackfillRun = undefined;");

    const completionIndex = source.indexOf(
      "relationshipBackfillCompleted = true;",
    );
    expect(
      source.lastIndexOf("if (signal.aborted) return;", completionIndex),
    ).toBeGreaterThan(
      source.indexOf("const run = reconcileDocumentRelationshipsUntilStopped"),
    );
  });

  it("requeues only the exact extraction claim abandoned by stop", () => {
    const source = readSource(
      "artifacts/api-server/src/lib/extraction-worker.ts",
    );
    const start = source.indexOf(
      "async function requeueAbortedExtractionClaim",
    );
    const end = source.indexOf(
      "async function reconcileDocumentRelationshipsUntilStopped",
      start,
    );
    const requeue = source.slice(start, end);
    expect(requeue).toContain('status: "queued"');
    expect(requeue).toContain("attempts: sql`greatest(");
    expect(requeue).toContain("startedAt: null");
    expect(requeue).toContain("finishedAt: null");
    expect(requeue).toContain("eq(extractionJobsTable.id, job.id)");
    expect(requeue).toContain('eq(extractionJobsTable.status, "running")');
    expect(requeue).toContain("eq(extractionJobsTable.attempts, job.attempts)");
    expect(requeue).toContain(
      "eq(extractionJobsTable.startedAt, job.startedAt)",
    );
    expect(requeue).toContain("return requeued.length === 1;");

    expect(source).toContain(
      "if (isStopped(signal)) {\n    await requeueAbortedExtractionClaim(job);\n    return;\n  }",
    );
    expect(source).toMatch(
      /claimCanBeSafelyRequeued\s*&&\s*\(err instanceof ExtractionWorkerStoppedError \|\| isStopped\(signal\)\)/,
    );
    expect(source).toContain("claimCanBeSafelyRequeued &&");
    expect(source).toContain("claimCanBeSafelyRequeued = false;");
    expect(source.indexOf("claimCanBeSafelyRequeued = false;")).toBeLessThan(
      source.indexOf("await applyAiSuggestion("),
    );
  });

  it("fences every next switchboard, reminder and template unit", () => {
    const switchboard = readSource(
      "artifacts/api-server/src/lib/switchboard-worker.ts",
    );
    expect(switchboard).toContain(
      "export async function drainSwitchboardQueue(signal?: AbortSignal)",
    );
    expect(switchboard).toMatch(
      /for \(const job of jobs\) \{\s*if \(signal\?\.aborted\) break;\s*await processOne\(job\.id\);/,
    );
    expect(switchboard).toContain(
      "drainSwitchboardQueue(abortController.signal)",
    );

    const reminders = readSource(
      "artifacts/api-server/src/lib/invoice-reminders.ts",
    );
    expect(reminders).toContain("runAutomaticReminders(signal?: AbortSignal)");
    expect(reminders).toMatch(
      /for \(const invoice of overdue\) \{\s*if \(signal\?\.aborted\) break;/,
    );
    expect(reminders).toContain(
      "runAutomaticReminders(abortController.signal)",
    );

    const recurring = readSource(
      "artifacts/api-server/src/lib/recurring-templates.ts",
    );
    expect(recurring).toMatch(
      /runRecurringGeneration\(\s*today: string,\s*signal\?: AbortSignal,/,
    );
    expect(recurring).toMatch(
      /for \(const template of dueTemplates\) \{\s*if \(signal\?\.aborted\) break;/,
    );
    expect(recurring).toMatch(
      /runRecurringGeneration\(\s*today,\s*abortController\.signal,?\s*\)/,
    );
  });

  it("fences every next email folder, message and attachment", () => {
    const source = readSource("artifacts/api-server/src/lib/email-import.ts");
    expect(source).toContain(
      "export async function pollOnce(signal?: AbortSignal)",
    );
    expect(source).toMatch(
      /for \(const folder of cfg\.folders\) \{\s*if \(signal\?\.aborted\) break;/,
    );
    expect(source).toContain(
      "await pollFolder(client, folder, cfg, result, signal)",
    );
    expect(source).toMatch(
      /messageLoop: for \(const msg of messages\) \{\s*if \(signal\?\.aborted\) break;/,
    );
    expect(source).toMatch(
      /const existing = await findExistingLog\(messageId\);\s*if \(signal\?\.aborted\) break;/,
    );
    expect(source).toMatch(
      /for \(const att of attachments\) \{\s*if \(signal\?\.aborted\) break;[\s\S]*?await client\.download/,
    );
    expect(source).toMatch(
      /for \(const d of downloaded\) \{\s*if \(signal\?\.aborted\) break;[\s\S]*?await inspectImportedFile/,
    );
    expect(source).toMatch(
      /await inspectImportedFile\([\s\S]*?if \(signal\?\.aborted\) break messageLoop;[\s\S]*?await ingestFile\(/,
    );
    const ingestIndex = source.indexOf("const ingest = await ingestFile(");
    const createdIndex = source.indexOf(
      'if (ingest.status === "created")',
      ingestIndex,
    );
    const logIndex = source.indexOf("await writeLog(existingId", createdIndex);
    expect(ingestIndex).toBeGreaterThanOrEqual(0);
    expect(createdIndex).toBeGreaterThan(ingestIndex);
    expect(logIndex).toBeGreaterThan(createdIndex);
    expect(source.slice(ingestIndex, logIndex)).not.toContain(
      "break messageLoop",
    );
    expect(
      source.match(/if \(signal\?\.aborted\) break messageLoop;/g),
    ).toHaveLength(3);
    expect(source).toMatch(
      /catch \(err\) \{\s*if \(signal\?\.aborted\) break messageLoop;/,
    );
    const pollAndRecord = source.slice(
      source.indexOf("export async function pollAndRecord"),
      source.indexOf("export async function retryLogEntry"),
    );
    expect(pollAndRecord).toMatch(
      /catch \(err\) \{\s*if \(signal\?\.aborted\) throw err;/,
    );
    expect(source).toContain("if (!signal?.aborted && seenUids.length)");
    expect(source).toContain("await pollAndRecord(signal)");
  });

  it("blocks the next outbox unit while completing an already claimed unit", () => {
    const source = readSource(
      "artifacts/api-server/src/lib/operational-alert-outbox-worker.ts",
    );
    expect(source).toContain("signal?: AbortSignal");
    expect(source).toMatch(
      /for \(let index = 0; index < MAX_PER_TICK; index \+= 1\) \{\s*if \(signal\?\.aborted\) return;\s*const claim = await claimOperationalAlert\(\);/,
    );
    const claimIndex = source.indexOf(
      "const claim = await claimOperationalAlert()",
    );
    const loopEnd = source.indexOf("\n  }\n}", claimIndex);
    expect(source.slice(claimIndex, loopEnd)).not.toContain(
      "if (signal?.aborted)",
    );
    expect(source).toContain("abortController?.abort()");
    expect(source).toContain("clearTimeout(warmupTimer)");
    expect(source).toContain(
      "if (!started || signal.aborted || running) return;",
    );
  });

  it("closes a live-events client that resolves after shutdown", () => {
    const source = readSource(
      "artifacts/api-server/src/lib/live-events-service.ts",
    );
    const connectIndex = source.indexOf(
      "client = await createListenerClient()",
    );
    const connectFence = source.indexOf("if (shuttingDown)", connectIndex);
    const installIndex = source.indexOf(
      "listenerClient = client",
      connectIndex,
    );
    const listenIndex = source.indexOf("await client.query", installIndex);
    const listenFence = source.indexOf("if (shuttingDown)", listenIndex);
    expect(connectIndex).toBeGreaterThanOrEqual(0);
    expect(connectFence).toBeGreaterThan(connectIndex);
    expect(installIndex).toBeGreaterThan(connectFence);
    expect(listenFence).toBeGreaterThan(listenIndex);
    expect(source.slice(connectFence, installIndex)).toContain(
      "await client.end().catch(() => {})",
    );
  });

  it("cancels a reserved detached auto-backup before execution", () => {
    const source = readSource("artifacts/api-server/src/lib/backup.ts");
    const reserveStart = source.indexOf(
      "async function reserveAutoBackupIfDue",
    );
    const triggerStart = source.indexOf(
      "export async function triggerAutoBackupIfDue",
      reserveStart,
    );
    const reserve = source.slice(reserveStart, triggerStart);
    const reservationIndex = reserve.indexOf(
      'await reserveBackupAttempt({ trigger: "auto" })',
    );
    const immediateIndex = reserve.indexOf("setImmediate(", reservationIndex);
    const stoppedIndex = reserve.indexOf(
      "if (signal?.aborted)",
      immediateIndex,
    );
    const failureIndex = reserve.indexOf(
      "await resolveBackupCreationFailure({",
      stoppedIndex,
    );
    const executionIndex = reserve.indexOf(
      "await executeReservedBackup(attempt, lease)",
      stoppedIndex,
    );

    expect(reserve).toContain("signal?: AbortSignal");
    expect(reservationIndex).toBeGreaterThanOrEqual(0);
    expect(immediateIndex).toBeGreaterThan(reservationIndex);
    expect(stoppedIndex).toBeGreaterThan(immediateIndex);
    expect(failureIndex).toBeGreaterThan(stoppedIndex);
    expect(executionIndex).toBeGreaterThan(failureIndex);
    expect(reserve).toContain("backupId: attempt.row.id");
    expect(source).toContain(
      "triggerAutoBackupIfDue(abortController.signal).catch",
    );
  });
});
