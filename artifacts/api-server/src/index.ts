import { existsSync } from "node:fs";
import {
  requireEmbeddedProductionBuildSha,
  requiresReleaseStartupGuard,
} from "./lib/build-provenance";
import { requireObservedProductionHostRunner } from "./lib/production-evidence-runner";
import { verifyLiveProductionAuditReadiness } from "./lib/production-audit-readiness";
import { installProductionRuntimeBinding } from "./lib/production-runtime-state";
import {
  PRODUCTION_RUNTIME_SHUTDOWN_DRAIN_MS,
  startProductionRuntimeFailStop,
  type ProductionRuntimeFailStopController,
} from "./lib/production-runtime-fail-stop";
import { runProductionStartupPreflight } from "./lib/production-startup";

const CONTROL_PLANE_IMAGE_MARKER = "/app/.site-logbook-control-plane-image";

function requiredRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
): "production" | "staging" {
  const value = env.SITE_LOGBOOK_RUNTIME_ENVIRONMENT;
  if (value !== "production" && value !== "staging") {
    throw new Error(
      "PRODUCTION_RUNTIME_ENVIRONMENT_INVALID: SITE_LOGBOOK_RUNTIME_ENVIRONMENT must explicitly be production or staging.",
    );
  }
  return value;
}

async function main(): Promise<void> {
  let productionRuntimeGuarded = false;
  // Release identity is embedded by esbuild. Runtime NODE_ENV is mutable and
  // therefore cannot disable the evidence/attestation/database startup guard.
  if (requiresReleaseStartupGuard()) {
    const embeddedBuildSha = requireEmbeddedProductionBuildSha();
    const runtimeEnvironment = requiredRuntimeEnvironment(process.env);
    if (runtimeEnvironment === "production") {
      const result = await runProductionStartupPreflight(
        process.env,
        embeddedBuildSha,
        {
          verifyObservedHostRunner: requireObservedProductionHostRunner,
          verifyDatabase: verifyLiveProductionAuditReadiness,
        },
      );
      installProductionRuntimeBinding(
        result.binding,
        result.refreshLiveReadiness,
      );
      productionRuntimeGuarded = true;
    } else if (!existsSync(CONTROL_PLANE_IMAGE_MARKER)) {
      throw new Error(
        "STAGING_CONTROL_PLANE_IMAGE_REQUIRED: staging runtime is allowed only in the explicit control-plane image target.",
      );
    }
  }

  // Application, listen and every background worker remain unreachable until
  // the production evidence and live read-only database checks above pass.
  const [
    { default: app },
    { logger },
    backup,
    reminders,
    extraction,
    emailImport,
    clientErrors,
    objectStorage,
    ppe,
    watchdog,
    recurring,
    liveEvents,
    switchboard,
    alertTransport,
    alertOutbox,
  ] = await Promise.all([
    import("./app"),
    import("./lib/logger"),
    import("./lib/backup"),
    import("./lib/invoice-reminders"),
    import("./lib/extraction-worker"),
    import("./lib/email-import"),
    import("./routes/client-errors"),
    import("./lib/objectStorage"),
    import("./lib/ppe-overdue-notifier"),
    import("./lib/health-watchdog"),
    import("./lib/recurring-templates"),
    import("./lib/live-events-service"),
    import("./lib/switchboard-worker"),
    import("./lib/operational-alert-transport"),
    import("./lib/operational-alert-outbox-worker"),
  ]);

  const rawPort = process.env.PORT;
  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }
  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  alertTransport.validateOperationalAlertTransportConfiguration();

  type WorkerStopHandle = Readonly<{ stop(): void }>;
  const workerHandles: WorkerStopHandle[] = [];
  let runtimeFailStop: ProductionRuntimeFailStopController | null = null;
  let shutdownStarted = false;
  let shutdownExitCode = 0;

  const stopWorkers = (): void => {
    runtimeFailStop?.stop();
    for (const handle of workerHandles.splice(0).reverse()) {
      try {
        handle.stop();
      } catch (error) {
        logger.error({ err: error }, "Failed to stop background worker");
      }
    }
  };
  const startWorker = (start: () => WorkerStopHandle): void => {
    workerHandles.push(start());
  };

  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
    logger.info(
      objectStorage.describeObjectStorageConfig(),
      "Object storage configuration",
    );
    try {
      // Arm parity fail-stop before any worker can claim or mutate work.
      if (productionRuntimeGuarded) {
        runtimeFailStop = startProductionRuntimeFailStop({
          onTrip: (reason) => requestShutdown(1, reason),
          onTripError: (error) =>
            logger.error({ err: error }, "Runtime fail-stop shutdown failed"),
        });
      }
      backup
        .checkPgDumpAvailability()
        .catch((error) =>
          logger.warn({ err: error }, "pg_dump availability check failed"),
        );
      startWorker(backup.startBackupScheduler);
      startWorker(backup.startRestoreTestScheduler);
      startWorker(reminders.startReminderScheduler);
      startWorker(extraction.startExtractionWorker);
      startWorker(switchboard.startSwitchboardWorker);
      startWorker(emailImport.startEmailImportWorker);
      startWorker(clientErrors.startClientErrorPurgeScheduler);
      startWorker(ppe.startPpeOverdueScheduler);
      startWorker(watchdog.startHealthWatchdog);
      alertOutbox.startOperationalAlertOutboxWorker();
      startWorker(recurring.startRecurringInvoiceScheduler);
      liveEvents
        .startLiveEventsService()
        .catch((error) =>
          logger.warn(
            { err: error },
            "Failed to start live-events PG LISTEN service",
          ),
        );
    } catch (error) {
      logger.error({ err: error }, "Background service startup failed");
      requestShutdown(1, "BACKGROUND_SERVICE_STARTUP_FAILED");
    }
  });

  const requestShutdown = (exitCode: number, reason: string): void => {
    shutdownExitCode = Math.max(shutdownExitCode, exitCode);
    if (shutdownStarted) return;
    shutdownStarted = true;
    const parityVerdict =
      runtimeFailStop?.stopAndWaitForVerdict(
        PRODUCTION_RUNTIME_SHUTDOWN_DRAIN_MS,
      ) ?? Promise.resolve("stopped" as const);
    stopWorkers();
    logger.info(
      { reason, exitCode: shutdownExitCode },
      "Shutting down gracefully",
    );
    const serviceShutdown = Promise.allSettled([
      liveEvents.shutdownLiveEventsService(),
      alertOutbox.stopOperationalAlertOutboxWorker(),
    ]);
    server.close(async () => {
      const [runtimeState] = await Promise.all([
        parityVerdict,
        serviceShutdown,
      ]);
      if (runtimeState === "tripped") shutdownExitCode = 1;
      logger.info("HTTP server closed");
      process.exit(shutdownExitCode);
    });
    setTimeout(() => {
      logger.warn("Forced shutdown after timeout");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => requestShutdown(0, "SIGTERM"));
  process.on("SIGINT", () => requestShutdown(0, "SIGINT"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[api-startup] FAIL ${message}\n`);
  process.exitCode = 1;
});
