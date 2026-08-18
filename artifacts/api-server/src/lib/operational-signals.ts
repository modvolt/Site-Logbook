import {
  auditLogTable,
  backupLogTable,
  db,
  emailImportLogTable,
  extractionJobsTable,
  switchboardProcessingJobsTable,
} from "@workspace/db";
import { and, desc, eq, gte, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { backupsEnabled } from "./backup";
import { SECURITY_OPERATIONAL_ALERT_ACTIONS } from "./security-audit";
import { getOperationalAlertTransportMode } from "./operational-alert-transport";
import {
  evaluateOperationalMetrics,
  loadOperationalThresholds,
  type OperationalMetrics,
  type OperationalProviderMetric,
  type OperationalSnapshot,
  type OperationalThresholds,
} from "./operational-alert-policy";

const SECURITY_WINDOW_SECONDS = 15 * 60;

interface CollectOperationalSnapshotOptions {
  now?: Date;
  providers?: OperationalProviderMetric[];
  thresholds?: OperationalThresholds;
}

function ageSeconds(now: Date, value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1_000));
}

function defaultProviders(): OperationalProviderMetric[] {
  return [
    { id: "database", state: "unknown", required: true },
    { id: "storage", state: "unknown", required: true },
  ];
}

export function unavailableOperationalSnapshot(
  options: CollectOperationalSnapshotOptions = {},
): OperationalSnapshot {
  const now = options.now ?? new Date();
  const metrics: OperationalMetrics = {
    generatedAt: now.toISOString(),
    providers: options.providers ?? defaultProviders(),
    queues: (["extraction", "switchboard", "email_import"] as const).map((id) => ({
      id,
      available: false,
      readyDepth: 0,
      runningDepth: 0,
      failedDepth: 0,
      oldestReadyAgeSeconds: null,
    })),
    backup: {
      available: false,
      enabled: false,
      lastSuccessAt: null,
      lastSuccessAgeSeconds: null,
      lastAttemptStatus: null,
      lastRestoreTestAt: null,
      lastRestoreTestAgeSeconds: null,
      lastRestoreStatus: null,
    },
    security: {
      available: false,
      windowSeconds: SECURITY_WINDOW_SECONDS,
      sensitiveEventCount: 0,
    },
  };
  return evaluateOperationalMetrics(
    metrics,
    options.thresholds ?? loadOperationalThresholds(),
    getOperationalAlertTransportMode(),
  );
}

export async function collectOperationalSnapshot(
  options: CollectOperationalSnapshotOptions = {},
): Promise<OperationalSnapshot> {
  const now = options.now ?? new Date();
  const securitySince = new Date(now.getTime() - SECURITY_WINDOW_SECONDS * 1_000);

  const [
    extractionRows,
    switchboardRows,
    emailRows,
    latestAttempts,
    latestSuccesses,
    latestRestores,
    securityRows,
  ] = await Promise.all([
    db
      .select({
        readyDepth: sql<number>`count(*) filter (where ${extractionJobsTable.status} = 'queued')::int`.mapWith(Number),
        runningDepth: sql<number>`count(*) filter (where ${extractionJobsTable.status} = 'running')::int`.mapWith(Number),
        failedDepth: sql<number>`count(*) filter (where ${extractionJobsTable.status} = 'failed')::int`.mapWith(Number),
        oldestReadyAt: sql<Date | null>`min(${extractionJobsTable.createdAt}) filter (where ${extractionJobsTable.status} = 'queued')`,
      })
      .from(extractionJobsTable),
    db
      .select({
        readyDepth: sql<number>`count(*) filter (where ${switchboardProcessingJobsTable.status} = 'queued' and ${switchboardProcessingJobsTable.availableAt} <= ${now})::int`.mapWith(Number),
        runningDepth: sql<number>`count(*) filter (where ${switchboardProcessingJobsTable.status} = 'running')::int`.mapWith(Number),
        failedDepth: sql<number>`count(*) filter (where ${switchboardProcessingJobsTable.status} = 'failed')::int`.mapWith(Number),
        oldestReadyAt: sql<Date | null>`min(${switchboardProcessingJobsTable.createdAt}) filter (where ${switchboardProcessingJobsTable.status} = 'queued' and ${switchboardProcessingJobsTable.availableAt} <= ${now})`,
      })
      .from(switchboardProcessingJobsTable),
    db
      .select({
        readyDepth: sql<number>`count(*) filter (where ${emailImportLogTable.status} = 'failed')::int`.mapWith(Number),
        failedDepth: sql<number>`count(*) filter (where ${emailImportLogTable.status} = 'failed_permanent')::int`.mapWith(Number),
        oldestReadyAt: sql<Date | null>`min(${emailImportLogTable.createdAt}) filter (where ${emailImportLogTable.status} = 'failed')`,
      })
      .from(emailImportLogTable),
    db
      .select({
        status: backupLogTable.status,
        createdAt: backupLogTable.createdAt,
      })
      .from(backupLogTable)
      .orderBy(desc(backupLogTable.createdAt))
      .limit(1),
    db
      .select({ createdAt: backupLogTable.createdAt })
      .from(backupLogTable)
      .where(eq(backupLogTable.status, "success"))
      .orderBy(desc(backupLogTable.createdAt))
      .limit(1),
    db
      .select({
        restoreTestedAt: backupLogTable.restoreTestedAt,
        restoreStatus: backupLogTable.restoreStatus,
      })
      .from(backupLogTable)
      .where(isNotNull(backupLogTable.restoreTestedAt))
      .orderBy(desc(backupLogTable.restoreTestedAt))
      .limit(1),
    db
      .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
      .from(auditLogTable)
      .where(
        and(
          gte(auditLogTable.createdAt, securitySince),
          or(
            eq(auditLogTable.path, "/users"),
            like(auditLogTable.path, "/users/%"),
            eq(auditLogTable.path, "/sessions"),
            like(auditLogTable.path, "/sessions/%"),
            eq(auditLogTable.path, "/admin/sessions"),
            like(auditLogTable.path, "/admin/sessions/%"),
            inArray(auditLogTable.entityType, [
              "sessions",
              "webauthn-credentials",
            ]),
            inArray(auditLogTable.action, [...SECURITY_OPERATIONAL_ALERT_ACTIONS]),
          ),
        ),
      ),
  ]);

  const extraction = extractionRows[0];
  const switchboard = switchboardRows[0];
  const email = emailRows[0];
  const latestAttempt = latestAttempts[0];
  const latestSuccess = latestSuccesses[0];
  const latestRestore = latestRestores[0];

  const metrics: OperationalMetrics = {
    generatedAt: now.toISOString(),
    providers: options.providers ?? defaultProviders(),
    queues: [
      {
        id: "extraction",
        available: true,
        readyDepth: extraction?.readyDepth ?? 0,
        runningDepth: extraction?.runningDepth ?? 0,
        failedDepth: extraction?.failedDepth ?? 0,
        oldestReadyAgeSeconds: ageSeconds(now, extraction?.oldestReadyAt),
      },
      {
        id: "switchboard",
        available: true,
        readyDepth: switchboard?.readyDepth ?? 0,
        runningDepth: switchboard?.runningDepth ?? 0,
        failedDepth: switchboard?.failedDepth ?? 0,
        oldestReadyAgeSeconds: ageSeconds(now, switchboard?.oldestReadyAt),
      },
      {
        id: "email_import",
        available: true,
        readyDepth: email?.readyDepth ?? 0,
        runningDepth: 0,
        failedDepth: email?.failedDepth ?? 0,
        oldestReadyAgeSeconds: ageSeconds(now, email?.oldestReadyAt),
      },
    ],
    backup: {
      available: true,
      enabled: backupsEnabled(),
      lastSuccessAt: latestSuccess?.createdAt.toISOString() ?? null,
      lastSuccessAgeSeconds: ageSeconds(now, latestSuccess?.createdAt),
      lastAttemptStatus: latestAttempt?.status ?? null,
      lastRestoreTestAt: latestRestore?.restoreTestedAt?.toISOString() ?? null,
      lastRestoreTestAgeSeconds: ageSeconds(now, latestRestore?.restoreTestedAt),
      lastRestoreStatus: latestRestore?.restoreStatus ?? null,
    },
    security: {
      available: true,
      windowSeconds: SECURITY_WINDOW_SECONDS,
      sensitiveEventCount: securityRows[0]?.count ?? 0,
    },
  };

  return evaluateOperationalMetrics(
    metrics,
    options.thresholds ?? loadOperationalThresholds(),
    getOperationalAlertTransportMode(),
  );
}
