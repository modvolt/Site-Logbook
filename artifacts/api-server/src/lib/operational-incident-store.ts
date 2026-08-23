import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  operationalAlertOutboxTable,
  operationalIncidentEventsTable,
  operationalIncidentsTable,
} from "@workspace/db";
import type {
  OperationalAlert,
  OperationalAlertTransition,
} from "./operational-alert-policy";
import type { DeliveryFailure } from "./operational-alert-transport";
import { SCHEDULER_LOCK_KEYS } from "./scheduler-lock";

const OUTBOX_LEASE_MS = 45_000;
const MAX_DELIVERY_CYCLES = 8;
const DEAD_LETTER_LIST_LIMIT = 50;

function eventKey(
  fingerprint: string,
  sequence: number,
  kind: OperationalAlertTransition["kind"],
): string {
  return createHash("sha256")
    .update(fingerprint)
    .update("\0")
    .update(String(sequence))
    .update("\0")
    .update(kind)
    .digest("hex");
}

function asDate(iso: string): Date {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Operational snapshot timestamp is invalid");
  }
  return parsed;
}

function toIso(value: unknown, field: string): string {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new Error(`${field} timestamp is invalid`);
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${field} timestamp is invalid`);
  }
  return parsed.toISOString();
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function appendTransition(
  tx: Transaction,
  incidentId: number,
  sequence: number,
  transition: OperationalAlertTransition,
): Promise<void> {
  const [event] = await tx
    .insert(operationalIncidentEventsTable)
    .values({
      incidentId,
      eventKey: eventKey(
        transition.alert.fingerprint,
        sequence,
        transition.kind,
      ),
      sequence,
      kind: transition.kind,
      code: transition.alert.code,
      severity: transition.alert.severity,
      owner: transition.alert.owner,
      runbook: transition.alert.runbook,
      metric: transition.alert.metric,
      observed: transition.alert.observed,
      threshold: transition.alert.threshold,
      observedAt: asDate(transition.observedAt),
    })
    .returning({ id: operationalIncidentEventsTable.id });
  if (!event) throw new Error("Operational incident event was not inserted");
  await tx.insert(operationalAlertOutboxTable).values({
    incidentEventId: event.id,
  });
}

/**
 * Reconciles a complete alert snapshot under one database-wide transaction lock.
 * The database, not a process-local Map, is the transition authority.
 */
export async function reconcileOperationalIncidents(
  alerts: OperationalAlert[],
  observedAt: string,
): Promise<OperationalAlertTransition[]> {
  const observedDate = asDate(observedAt);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${SCHEDULER_LOCK_KEYS.operationalIncidentReconcile})`,
    );
    const existing = await tx.select().from(operationalIncidentsTable);
    const byFingerprint = new Map(
      existing.map((incident) => [incident.fingerprint, incident]),
    );
    const activeFingerprints = new Set(
      alerts.map((alert) => alert.fingerprint),
    );
    const transitions: OperationalAlertTransition[] = [];

    for (const alert of alerts) {
      const incident = byFingerprint.get(alert.fingerprint);
      if (!incident) {
        const transition: OperationalAlertTransition = {
          kind: "triggered",
          observedAt,
          alert,
        };
        const [created] = await tx
          .insert(operationalIncidentsTable)
          .values({
            fingerprint: alert.fingerprint,
            code: alert.code,
            severity: alert.severity,
            owner: alert.owner,
            runbook: alert.runbook,
            metric: alert.metric,
            observed: alert.observed,
            threshold: alert.threshold,
            firstObservedAt: observedDate,
            lastObservedAt: observedDate,
          })
          .returning({ id: operationalIncidentsTable.id });
        if (!created) throw new Error("Operational incident was not inserted");
        await appendTransition(tx, created.id, 1, transition);
        transitions.push(transition);
        continue;
      }

      const reopened = incident.status === "resolved";
      const severityChanged = incident.severity !== alert.severity;
      const nextSequence =
        incident.sequence + (reopened || severityChanged ? 1 : 0);
      await tx
        .update(operationalIncidentsTable)
        .set({
          code: alert.code,
          status: "open",
          severity: alert.severity,
          owner: alert.owner,
          runbook: alert.runbook,
          metric: alert.metric,
          observed: alert.observed,
          threshold: alert.threshold,
          sequence: nextSequence,
          firstObservedAt: reopened ? observedDate : incident.firstObservedAt,
          lastObservedAt: observedDate,
          resolvedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(operationalIncidentsTable.id, incident.id));

      if (reopened || severityChanged) {
        const transition: OperationalAlertTransition = {
          kind: reopened
            ? "triggered"
            : alert.severity === "critical"
              ? "escalated"
              : "deescalated",
          observedAt,
          alert,
        };
        await appendTransition(tx, incident.id, nextSequence, transition);
        transitions.push(transition);
      }
    }

    for (const incident of existing) {
      if (
        incident.status !== "open" ||
        activeFingerprints.has(incident.fingerprint)
      ) {
        continue;
      }
      const nextSequence = incident.sequence + 1;
      const alert: OperationalAlert = {
        fingerprint: incident.fingerprint,
        code: incident.code,
        severity: incident.severity as OperationalAlert["severity"],
        owner: incident.owner,
        runbook: incident.runbook,
        summary: "Operational incident recovered",
        metric: incident.metric,
        observed: incident.observed,
        threshold: incident.threshold,
      };
      const transition: OperationalAlertTransition = {
        kind: "recovered",
        observedAt,
        alert,
      };
      await tx
        .update(operationalIncidentsTable)
        .set({
          status: "resolved",
          sequence: nextSequence,
          lastObservedAt: observedDate,
          resolvedAt: observedDate,
          updatedAt: new Date(),
        })
        .where(eq(operationalIncidentsTable.id, incident.id));
      await appendTransition(tx, incident.id, nextSequence, transition);
      transitions.push(transition);
    }

    return transitions;
  });
}

export interface ClaimedOperationalAlert {
  outboxId: number;
  leaseToken: string;
  attemptCount: number;
  eventKey: string;
  transition: OperationalAlertTransition;
}

/** Atomically claims one due row; expired leases are recoverable after a crash. */
export async function claimOperationalAlert(): Promise<ClaimedOperationalAlert | null> {
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + OUTBOX_LEASE_MS);
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql<{
      id: number;
      incident_event_id: number;
      attempt_count: number;
    }>`
      with candidate as (
        select id
        from operational_alert_outbox
        where (
          state = 'pending' and available_at <= now()
        ) or (
          state = 'delivering' and lease_expires_at <= now()
        )
        order by id
        for update skip locked
        limit 1
      )
      update operational_alert_outbox as outbox
      set state = 'delivering',
          attempt_count = outbox.attempt_count + 1,
          lease_token = ${leaseToken},
          lease_expires_at = ${leaseExpiresAt},
          updated_at = now()
      from candidate
      where outbox.id = candidate.id
      returning outbox.id, outbox.incident_event_id, outbox.attempt_count
    `);
    const rawClaimed = result.rows[0];
    if (!rawClaimed) return null;
    const claimed = {
      id: Number(rawClaimed.id),
      incident_event_id: Number(rawClaimed.incident_event_id),
      attempt_count: Number(rawClaimed.attempt_count),
    };
    if (
      !Number.isInteger(claimed.id) ||
      !Number.isInteger(claimed.incident_event_id) ||
      !Number.isInteger(claimed.attempt_count)
    ) {
      throw new Error("Claimed operational outbox row is invalid");
    }
    const [event] = await tx
      .select()
      .from(operationalIncidentEventsTable)
      .where(eq(operationalIncidentEventsTable.id, claimed.incident_event_id))
      .limit(1);
    if (!event) throw new Error("Claimed operational alert event is missing");
    const [incident] = await tx
      .select({ fingerprint: operationalIncidentsTable.fingerprint })
      .from(operationalIncidentsTable)
      .where(eq(operationalIncidentsTable.id, event.incidentId))
      .limit(1);
    if (!incident) throw new Error("Claimed operational incident is missing");
    return {
      outboxId: claimed.id,
      leaseToken,
      attemptCount: claimed.attempt_count,
      eventKey: event.eventKey,
      transition: {
        kind: event.kind as OperationalAlertTransition["kind"],
        observedAt: event.observedAt.toISOString(),
        alert: {
          fingerprint: incident.fingerprint,
          code: event.code,
          severity: event.severity as OperationalAlert["severity"],
          owner: event.owner,
          runbook: event.runbook,
          summary: "Durable operational incident transition",
          metric: event.metric,
          observed: event.observed,
          threshold: event.threshold,
        },
      },
    };
  });
}

export async function markOperationalAlertDelivered(
  claim: ClaimedOperationalAlert,
): Promise<boolean> {
  const rows = await db
    .update(operationalAlertOutboxTable)
    .set({
      state: "delivered",
      leaseToken: null,
      leaseExpiresAt: null,
      deliveredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(operationalAlertOutboxTable.id, claim.outboxId),
        eq(operationalAlertOutboxTable.state, "delivering"),
        eq(operationalAlertOutboxTable.leaseToken, claim.leaseToken),
      ),
    )
    .returning({ id: operationalAlertOutboxTable.id });
  return rows.length === 1;
}

export async function markOperationalAlertFailed(
  claim: ClaimedOperationalAlert,
  failure: DeliveryFailure,
): Promise<"pending" | "dead_letter" | "lost_lease"> {
  const deadLetter =
    !failure.retryable || claim.attemptCount >= MAX_DELIVERY_CYCLES;
  const backoffSeconds = Math.min(
    900,
    5 * 2 ** Math.max(0, claim.attemptCount - 1),
  );
  const rows = await db
    .update(operationalAlertOutboxTable)
    .set({
      state: deadLetter ? "dead_letter" : "pending",
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: deadLetter
        ? new Date()
        : new Date(Date.now() + backoffSeconds * 1_000),
      lastFailureCategory: failure.category,
      lastHttpStatus: failure.status,
      deadLetteredAt: deadLetter ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(operationalAlertOutboxTable.id, claim.outboxId),
        eq(operationalAlertOutboxTable.state, "delivering"),
        eq(operationalAlertOutboxTable.leaseToken, claim.leaseToken),
      ),
    )
    .returning({ id: operationalAlertOutboxTable.id });
  if (rows.length !== 1) return "lost_lease";
  return deadLetter ? "dead_letter" : "pending";
}

export interface OperationalAlertDeadLetterListItem {
  outboxId: number;
  code: string;
  severity: "warning" | "critical";
  transitionKind: OperationalAlertTransition["kind"];
  attemptCount: number;
  lastFailureCategory: string | null;
  lastHttpStatus: number | null;
  deadLetteredAt: string;
  createdAt: string;
}

/** Redacted operator view; incident payloads, identities and delivery targets stay private. */
export async function listOperationalAlertDeadLetters(): Promise<
  OperationalAlertDeadLetterListItem[]
> {
  const rows = await db
    .select({
      outboxId: operationalAlertOutboxTable.id,
      code: operationalIncidentEventsTable.code,
      severity: operationalIncidentEventsTable.severity,
      transitionKind: operationalIncidentEventsTable.kind,
      attemptCount: operationalAlertOutboxTable.attemptCount,
      lastFailureCategory: operationalAlertOutboxTable.lastFailureCategory,
      lastHttpStatus: operationalAlertOutboxTable.lastHttpStatus,
      deadLetteredAt: operationalAlertOutboxTable.deadLetteredAt,
      createdAt: operationalAlertOutboxTable.createdAt,
    })
    .from(operationalAlertOutboxTable)
    .innerJoin(
      operationalIncidentEventsTable,
      eq(
        operationalIncidentEventsTable.id,
        operationalAlertOutboxTable.incidentEventId,
      ),
    )
    .where(eq(operationalAlertOutboxTable.state, "dead_letter"))
    .orderBy(
      desc(operationalAlertOutboxTable.deadLetteredAt),
      desc(operationalAlertOutboxTable.id),
    )
    .limit(DEAD_LETTER_LIST_LIMIT);

  return rows.map((row) => {
    if (row.deadLetteredAt === null) {
      throw new Error("Dead-letter row is missing its terminal timestamp");
    }
    if (row.severity !== "warning" && row.severity !== "critical") {
      throw new Error("Dead-letter severity is invalid");
    }
    if (
      row.transitionKind !== "triggered" &&
      row.transitionKind !== "escalated" &&
      row.transitionKind !== "deescalated" &&
      row.transitionKind !== "recovered"
    ) {
      throw new Error("Dead-letter transition kind is invalid");
    }
    return {
      ...row,
      severity: row.severity,
      transitionKind: row.transitionKind,
      deadLetteredAt: toIso(row.deadLetteredAt, "Dead-letter"),
      createdAt: toIso(row.createdAt, "Dead-letter creation"),
    };
  });
}

export type OperationalAlertDeadLetterRequeueReason =
  | "receiver_configuration_corrected"
  | "receiver_recovered"
  | "transient_provider_outage_resolved"
  | "operator_verified_safe_retry";

export interface OperationalAlertDeadLetterRequeueInput {
  outboxId: number;
  expectedAttemptCount: number;
  expectedDeadLetteredAt: string;
  reason: OperationalAlertDeadLetterRequeueReason;
  actor: {
    userId: number;
    name: string;
  };
}

export type OperationalAlertDeadLetterRequeueResult =
  | {
      status: "requeued";
      value: {
        outboxId: number;
        state: "pending";
        attemptCount: 0;
        availableAt: string;
        requeued: true;
      };
    }
  | { status: "not_found" }
  | { status: "conflict"; reason: "not_dead_letter" | "precondition_failed" };

/**
 * Requeues one row and writes its operator audit entry atomically. The worker
 * remains the only component allowed to claim or deliver the row.
 */
export async function requeueOperationalAlertDeadLetter(
  input: OperationalAlertDeadLetterRequeueInput,
): Promise<OperationalAlertDeadLetterRequeueResult> {
  return db.transaction(async (tx) => {
    // Keep timestamp decoding on the schema-aware Drizzle path. A raw pg query
    // interprets `timestamp without time zone` in the host timezone and can
    // shift the optimistic-lock value away from the UTC value returned by the
    // normal application queries.
    const [raw] = await tx
      .select({
        id: operationalAlertOutboxTable.id,
        state: operationalAlertOutboxTable.state,
        attemptCount: operationalAlertOutboxTable.attemptCount,
        deadLetteredAt: operationalAlertOutboxTable.deadLetteredAt,
      })
      .from(operationalAlertOutboxTable)
      .where(eq(operationalAlertOutboxTable.id, input.outboxId))
      .for("update");
    if (!raw) return { status: "not_found" } as const;

    const current = {
      id: Number(raw.id),
      state: String(raw.state),
      attemptCount: Number(raw.attemptCount),
      deadLetteredAt:
        raw.deadLetteredAt === null
          ? null
          : toIso(raw.deadLetteredAt, "Dead-letter"),
    };
    if (
      !Number.isInteger(current.id) ||
      !Number.isInteger(current.attemptCount)
    ) {
      throw new Error("Dead-letter row is invalid");
    }
    if (current.state !== "dead_letter" || current.deadLetteredAt === null) {
      return { status: "conflict", reason: "not_dead_letter" } as const;
    }
    if (
      current.attemptCount !== input.expectedAttemptCount ||
      current.deadLetteredAt !== input.expectedDeadLetteredAt
    ) {
      return { status: "conflict", reason: "precondition_failed" } as const;
    }

    const availableAt = new Date();
    const updated = await tx
      .update(operationalAlertOutboxTable)
      .set({
        state: "pending",
        attemptCount: 0,
        availableAt,
        leaseToken: null,
        leaseExpiresAt: null,
        deliveredAt: null,
        deadLetteredAt: null,
        updatedAt: availableAt,
      })
      .where(
        and(
          eq(operationalAlertOutboxTable.id, current.id),
          eq(operationalAlertOutboxTable.state, "dead_letter"),
        ),
      )
      .returning({ id: operationalAlertOutboxTable.id });
    if (updated.length !== 1) {
      throw new Error("Dead-letter row was not requeued");
    }

    await tx.insert(auditLogTable).values({
      actorUserId: input.actor.userId,
      actorName: input.actor.name,
      action: "operational_alert.dead_letter.requeued",
      entityType: "operational_alert_outbox",
      entityId: current.id,
      summary: JSON.stringify({
        reason: input.reason,
        previousAttemptCount: current.attemptCount,
        previousDeadLetteredAt: current.deadLetteredAt,
      }),
      method: "POST",
      path: `/admin/health/operational-alert-outbox/${current.id}/requeue`,
    });

    return {
      status: "requeued",
      value: {
        outboxId: current.id,
        state: "pending",
        attemptCount: 0,
        availableAt: availableAt.toISOString(),
        requeued: true,
      },
    } as const;
  });
}

export interface OperationalAlertDeliverySummary {
  status: "available" | "unavailable";
  pending: number | null;
  delivering: number | null;
  deadLetter: number | null;
  oldestPendingAt: string | null;
  lastDeliveredAt: string | null;
}

/** Aggregate-only operator telemetry; never returns alert payloads or secrets. */
export async function getOperationalAlertDeliverySummary(): Promise<OperationalAlertDeliverySummary> {
  try {
    const result = await db.execute(sql<{
      pending: number;
      delivering: number;
      dead_letter: number;
      oldest_pending_at: Date | string | null;
      last_delivered_at: Date | string | null;
    }>`
      select
        count(*) filter (where state = 'pending')::int as pending,
        count(*) filter (where state = 'delivering')::int as delivering,
        count(*) filter (where state = 'dead_letter')::int as dead_letter,
        min(created_at) filter (where state = 'pending') as oldest_pending_at,
        max(delivered_at) as last_delivered_at
      from operational_alert_outbox
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Operational delivery summary is missing");
    const toNullableIso = (value: unknown): string | null => {
      if (value === null) return null;
      if (!(value instanceof Date) && typeof value !== "string") {
        throw new Error("Operational delivery timestamp is invalid");
      }
      return toIso(value, "Operational delivery");
    };
    return {
      status: "available",
      pending: Number(row.pending),
      delivering: Number(row.delivering),
      deadLetter: Number(row.dead_letter),
      oldestPendingAt: toNullableIso(row.oldest_pending_at),
      lastDeliveredAt: toNullableIso(row.last_delivered_at),
    };
  } catch {
    return {
      status: "unavailable",
      pending: null,
      delivering: null,
      deadLetter: null,
      oldestPendingAt: null,
      lastDeliveredAt: null,
    };
  }
}
