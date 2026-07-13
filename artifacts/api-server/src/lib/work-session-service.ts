import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  timeEntriesTable,
  workSessionsTable,
  workSessionBreaksTable,
  workSessionEventsTable,
  peopleTable,
  jobsTable,
  activitiesTable,
  personHourlyRatesTable,
} from "@workspace/db";
import {
  calculateSessionDurationSeconds,
  hoursToSeconds,
  secondsToRoundedHours,
  reviewThresholdSeconds,
} from "./work-session-math";

export type WorkKind = "job" | "activity";
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ActiveWorkSessionConflict extends Error {
  statusCode = 409;
  constructor(
    public readonly active: {
      id: number;
      jobId: number | null;
      activityId: number | null;
      startedAt: Date;
    },
  ) {
    super("Pracovník už má spuštěný časovač na jiné zakázce nebo akci.");
  }
}

export class WorkSessionOverlapError extends Error {
  statusCode = 409;
  constructor() {
    super("Ruční interval se překrývá s jiným pracovním intervalem této osoby.");
  }
}

export class WorkSessionIdempotencyConflict extends Error {
  statusCode = 409;
  constructor() {
    super("Idempotency-Key už byl použit pro jiný pracovní interval.");
  }
}

function parentValues(kind: WorkKind, parentId: number) {
  return kind === "job"
    ? { parentType: "job", parentIdSnapshot: parentId, jobId: parentId }
    : { parentType: "activity", parentIdSnapshot: parentId, activityId: parentId };
}

function parentCondition(kind: WorkKind, parentId: number) {
  return kind === "job"
    ? eq(workSessionsTable.jobId, parentId)
    : eq(workSessionsTable.activityId, parentId);
}

function aggregateParentCondition(kind: WorkKind, parentId: number) {
  return kind === "job"
    ? eq(timeEntriesTable.jobId, parentId)
    : eq(timeEntriesTable.activityId, parentId);
}

function sameParent(
  session: { jobId: number | null; activityId: number | null },
  kind: WorkKind,
  parentId: number,
) {
  return kind === "job" ? session.jobId === parentId : session.activityId === parentId;
}

async function lockPerson(tx: Tx, personId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(83421, ${personId})`);
}

async function rateSnapshot(tx: Tx, personId: number, at: Date) {
  const date = at.toISOString().slice(0, 10);
  const [rate] = await tx
    .select()
    .from(personHourlyRatesTable)
    .where(and(
      eq(personHourlyRatesTable.personId, personId),
      isNull(personHourlyRatesTable.voidedAt),
      lte(personHourlyRatesTable.validFrom, date),
      or(isNull(personHourlyRatesTable.validTo), sql`${personHourlyRatesTable.validTo} >= ${date}`),
    ));
  return rate ? {
    hourlyRateId: rate.id,
    costRateSnapshot: rate.costRate,
    saleRateSnapshot: rate.saleRate,
  } : {};
}

async function ensureAggregate(tx: Tx, kind: WorkKind, parentId: number, personId: number) {
  await tx
    .insert(timeEntriesTable)
    .values({ personId, ...parentValues(kind, parentId), hours: "0" })
    .onConflictDoNothing();
  const [entry] = await tx
    .select()
    .from(timeEntriesTable)
    .where(and(aggregateParentCondition(kind, parentId), eq(timeEntriesTable.personId, personId)));
  if (!entry) throw new Error("Souhrnný záznam času se nepodařilo vytvořit.");
  return entry;
}

async function recomputeParentProjection(tx: Tx, kind: WorkKind, parentId: number) {
  const [total] = await tx
    .select({ hours: sql<number>`coalesce(sum(${timeEntriesTable.hours}), 0)`.mapWith(Number) })
    .from(timeEntriesTable)
    .where(aggregateParentCondition(kind, parentId));
  const hours = String(Math.round(Number(total?.hours ?? 0) * 100) / 100);
  if (kind === "job") {
    await tx
      .update(jobsTable)
      .set({ hoursSpent: hours, hoursFromPlan: false, hoursBeforePlan: null })
      .where(eq(jobsTable.id, parentId));
  } else {
    await tx
      .update(activitiesTable)
      .set({ hoursSpent: hours, updatedAt: new Date() })
      .where(eq(activitiesTable.id, parentId));
  }
}

async function recomputeAggregate(tx: Tx, kind: WorkKind, parentId: number, personId: number) {
  const [totals] = await tx
    .select({ seconds: sql<number>`coalesce(sum(${workSessionsTable.durationSeconds}), 0)::int` })
    .from(workSessionsTable)
    .where(
      and(
        eq(workSessionsTable.personId, personId),
        parentCondition(kind, parentId),
        eq(workSessionsTable.status, "completed"),
      ),
    );
  const [active] = await tx
    .select({ startedAt: workSessionsTable.startedAt })
    .from(workSessionsTable)
    .where(
      and(
        eq(workSessionsTable.personId, personId),
        parentCondition(kind, parentId),
        eq(workSessionsTable.status, "active"),
      ),
    );
  const hours = secondsToRoundedHours(Number(totals?.seconds ?? 0));
  const [entry] = await tx
    .update(timeEntriesTable)
    .set({
      hours: String(hours),
      timerStartedAt: active?.startedAt ?? null,
      updatedAt: new Date(),
    })
    .where(and(aggregateParentCondition(kind, parentId), eq(timeEntriesTable.personId, personId)))
    .returning();
  await recomputeParentProjection(tx, kind, parentId);
  return entry ?? null;
}

async function addEvent(
  tx: Tx,
  sessionId: number,
  eventType: typeof workSessionEventsTable.$inferInsert.eventType,
  actorUserId: number | null,
  data?: Record<string, unknown>,
) {
  await tx.insert(workSessionEventsTable).values({
    sessionId,
    eventType,
    actorUserId,
    data: data ?? null,
  });
}

async function breakSeconds(tx: Tx, sessionId: number, endedAt: Date) {
  const activeBreaks = await tx
    .select()
    .from(workSessionBreaksTable)
    .where(and(eq(workSessionBreaksTable.sessionId, sessionId), sql`${workSessionBreaksTable.endedAt} is null`))
    .for("update");
  for (const item of activeBreaks) {
    const seconds = Math.max(0, Math.floor((endedAt.getTime() - item.startedAt.getTime()) / 1000));
    await tx
      .update(workSessionBreaksTable)
      .set({ endedAt, durationSeconds: seconds })
      .where(eq(workSessionBreaksTable.id, item.id));
  }
  const [row] = await tx
    .select({ seconds: sql<number>`coalesce(sum(${workSessionBreaksTable.durationSeconds}), 0)::int` })
    .from(workSessionBreaksTable)
    .where(eq(workSessionBreaksTable.sessionId, sessionId));
  return Number(row?.seconds ?? 0);
}

async function closeSession(
  tx: Tx,
  session: typeof workSessionsTable.$inferSelect,
  actorUserId: number,
  endedAt: Date,
  stopIdempotencyKey?: string,
) {
  const pauses = await breakSeconds(tx, session.id, endedAt);
  const durationSeconds = calculateSessionDurationSeconds(session.startedAt, endedAt, pauses);
  const needsReview = durationSeconds > reviewThresholdSeconds();
  await tx
    .update(workSessionsTable)
    .set({
      endedAt,
      durationSeconds,
      status: "completed",
      endedByUserId: actorUserId,
      stopIdempotencyKey: stopIdempotencyKey ?? null,
      reviewStatus: needsReview ? "needs_review" : session.reviewStatus,
      reviewReason: needsReview ? "Délka session překročila limit pro kontrolu" : session.reviewReason,
      reviewFlaggedAt: needsReview ? endedAt : session.reviewFlaggedAt,
      updatedAt: endedAt,
    })
    .where(eq(workSessionsTable.id, session.id));
  await addEvent(tx, session.id, "stopped", actorUserId, { durationSeconds, breakSeconds: pauses });
  if (needsReview) {
    await addEvent(tx, session.id, "review_flagged", null, {
      reason: "duration_limit",
      thresholdSeconds: reviewThresholdSeconds(),
    });
  }
  return durationSeconds;
}

export async function startWorkSession(
  kind: WorkKind,
  parentId: number,
  personId: number,
  actorUserId: number,
  idempotencyKey?: string,
) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, personId);
    if (idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(workSessionsTable)
        .where(eq(workSessionsTable.idempotencyKey, idempotencyKey));
      if (existing) {
        if (existing.personId !== personId || !sameParent(existing, kind, parentId)) {
          throw new WorkSessionIdempotencyConflict();
        }
        await ensureAggregate(tx, kind, parentId, personId);
        return (await recomputeAggregate(tx, kind, parentId, personId))!;
      }
    }
    const [active] = await tx
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.personId, personId), eq(workSessionsTable.status, "active")))
      .for("update");
    await ensureAggregate(tx, kind, parentId, personId);
    if (active) {
      if (!sameParent(active, kind, parentId)) {
        throw new ActiveWorkSessionConflict(active);
      }
      return (await recomputeAggregate(tx, kind, parentId, personId))!;
    }

    const startedAt = new Date();
    const [session] = await tx
      .insert(workSessionsTable)
      .values({
        personId,
        ...parentValues(kind, parentId),
        ...(await rateSnapshot(tx, personId, startedAt)),
        startedAt,
        source: "timer",
        status: "active",
        idempotencyKey: idempotencyKey ?? null,
        createdByUserId: actorUserId,
      })
      .returning();
    await addEvent(tx, session.id, "started", actorUserId);
    return (await recomputeAggregate(tx, kind, parentId, personId))!;
  });
}

export async function ensureWorkTracking(kind: WorkKind, parentId: number, personId: number) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, personId);
    return ensureAggregate(tx, kind, parentId, personId);
  });
}

export async function activeWorkSessionStarts(
  kind: WorkKind,
  parentIds: number[],
  personId: number | null | undefined,
): Promise<Map<number, Date>> {
  if (!personId || parentIds.length === 0) return new Map();
  const parentColumn = kind === "job" ? workSessionsTable.jobId : workSessionsTable.activityId;
  const rows = await db
    .select({ parentId: parentColumn, startedAt: workSessionsTable.startedAt })
    .from(workSessionsTable)
    .where(and(
      eq(workSessionsTable.personId, personId),
      eq(workSessionsTable.status, "active"),
      inArray(parentColumn, parentIds),
    ));
  return new Map(rows.flatMap((row) => row.parentId == null ? [] : [[row.parentId, row.startedAt] as const]));
}

export async function stopWorkSession(
  kind: WorkKind,
  parentId: number,
  personId: number,
  actorUserId: number,
  idempotencyKey?: string,
) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, personId);
    if (idempotencyKey) {
      const [alreadyStopped] = await tx
        .select()
        .from(workSessionsTable)
        .where(eq(workSessionsTable.stopIdempotencyKey, idempotencyKey));
      if (alreadyStopped) {
        if (alreadyStopped.personId !== personId || !sameParent(alreadyStopped, kind, parentId)) {
          throw new WorkSessionIdempotencyConflict();
        }
        return ensureAggregate(tx, kind, parentId, personId);
      }
    }
    const [active] = await tx
      .select()
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.personId, personId),
          parentCondition(kind, parentId),
          eq(workSessionsTable.status, "active"),
        ),
      )
      .for("update");
    const aggregate = await ensureAggregate(tx, kind, parentId, personId);
    if (!active) return aggregate;
    await closeSession(tx, active, actorUserId, new Date(), idempotencyKey);
    return (await recomputeAggregate(tx, kind, parentId, personId))!;
  });
}

export async function setManualWorkTotal(
  kind: WorkKind,
  parentId: number,
  personId: number,
  hours: number,
  actorUserId: number,
  reason = "Ruční nastavení celkového času",
) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, personId);
    await ensureAggregate(tx, kind, parentId, personId);
    const [active] = await tx
      .select()
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.personId, personId),
          parentCondition(kind, parentId),
          eq(workSessionsTable.status, "active"),
        ),
      )
      .for("update");
    const now = new Date();
    if (active) await closeSession(tx, active, actorUserId, now);

    const [totals] = await tx
      .select({ seconds: sql<number>`coalesce(sum(${workSessionsTable.durationSeconds}), 0)::int` })
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.personId, personId),
          parentCondition(kind, parentId),
          eq(workSessionsTable.status, "completed"),
        ),
      );
    const previousSeconds = Number(totals?.seconds ?? 0);
    const requestedSeconds = hoursToSeconds(hours);
    const adjustmentSeconds = requestedSeconds - previousSeconds;
    if (adjustmentSeconds !== 0) {
      const [adjustment] = await tx
        .insert(workSessionsTable)
        .values({
          personId,
          ...parentValues(kind, parentId),
          ...(await rateSnapshot(tx, personId, now)),
          startedAt: now,
          endedAt: now,
          durationSeconds: adjustmentSeconds,
          status: "completed",
          source: "correction",
          note: reason,
          createdByUserId: actorUserId,
          endedByUserId: actorUserId,
        })
        .returning();
      await addEvent(tx, adjustment.id, "manual_adjusted", actorUserId, {
        previousSeconds,
        requestedSeconds,
        adjustmentSeconds,
        reason,
      });
    }

    if (active) {
      const [restarted] = await tx
        .insert(workSessionsTable)
        .values({
          personId,
          ...parentValues(kind, parentId),
          ...(await rateSnapshot(tx, personId, now)),
          startedAt: now,
          source: "timer",
          status: "active",
          createdByUserId: actorUserId,
        })
        .returning();
      await addEvent(tx, restarted.id, "started", actorUserId, { reason: "continued_after_manual_adjustment" });
    }
    return (await recomputeAggregate(tx, kind, parentId, personId))!;
  });
}

export async function addManualWorkSession(input: {
  kind: WorkKind;
  parentId: number;
  personId: number;
  startedAt: Date;
  endedAt: Date;
  note?: string | null;
  actorUserId: number;
  idempotencyKey?: string;
}) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, input.personId);
    await ensureAggregate(tx, input.kind, input.parentId, input.personId);
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(workSessionsTable)
        .where(eq(workSessionsTable.idempotencyKey, input.idempotencyKey));
      if (existing) {
        if (
          existing.personId !== input.personId ||
          !sameParent(existing, input.kind, input.parentId) ||
          existing.startedAt.getTime() !== input.startedAt.getTime() ||
          existing.endedAt?.getTime() !== input.endedAt.getTime()
        ) {
          throw new WorkSessionIdempotencyConflict();
        }
        return existing;
      }
    }
    const [overlap] = await tx
      .select({ id: workSessionsTable.id })
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.personId, input.personId),
          ne(workSessionsTable.status, "voided"),
          ne(workSessionsTable.source, "correction"),
          lt(workSessionsTable.startedAt, input.endedAt),
          sql`coalesce(${workSessionsTable.endedAt}, 'infinity'::timestamp) > ${input.startedAt}`,
        ),
      );
    if (overlap) throw new WorkSessionOverlapError();

    const durationSeconds = Math.floor((input.endedAt.getTime() - input.startedAt.getTime()) / 1000);
    const needsReview = durationSeconds > reviewThresholdSeconds();
    const [session] = await tx
      .insert(workSessionsTable)
      .values({
        personId: input.personId,
        ...parentValues(input.kind, input.parentId),
        ...(await rateSnapshot(tx, input.personId, input.startedAt)),
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationSeconds,
        status: "completed",
        source: "manual",
        reviewStatus: needsReview ? "needs_review" : "not_required",
        reviewReason: needsReview ? "Délka session překročila limit pro kontrolu" : null,
        reviewFlaggedAt: needsReview ? new Date() : null,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdByUserId: input.actorUserId,
        endedByUserId: input.actorUserId,
      })
      .returning();
    await addEvent(tx, session.id, "manual_created", input.actorUserId, { durationSeconds });
    if (needsReview) {
      await addEvent(tx, session.id, "review_flagged", null, {
        reason: "duration_limit",
        thresholdSeconds: reviewThresholdSeconds(),
      });
    }
    await recomputeAggregate(tx, input.kind, input.parentId, input.personId);
    return session;
  });
}

export async function removeTimeTracking(
  kind: WorkKind,
  parentId: number,
  personId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    await lockPerson(tx, personId);
    const sessions = await tx
      .select()
      .from(workSessionsTable)
      .where(
        and(
          eq(workSessionsTable.personId, personId),
          parentCondition(kind, parentId),
          ne(workSessionsTable.status, "voided"),
        ),
      );
    const now = new Date();
    for (const session of sessions) {
      if (session.status === "active") await breakSeconds(tx, session.id, now);
      await tx
        .update(workSessionsTable)
        .set({ status: "voided", voidedAt: now, voidedByUserId: actorUserId, updatedAt: now })
        .where(eq(workSessionsTable.id, session.id));
      await addEvent(tx, session.id, "voided", actorUserId, { reason: "time_tracking_removed" });
    }
    const [entry] = await tx
      .delete(timeEntriesTable)
      .where(and(aggregateParentCondition(kind, parentId), eq(timeEntriesTable.personId, personId)))
      .returning();
    await recomputeParentProjection(tx, kind, parentId);
    return !!entry;
  });
}

export async function getWorkSummary(kind: WorkKind, parentId: number) {
  const now = new Date();
  const rows = await db
    .select({ session: workSessionsTable, personName: peopleTable.name })
    .from(workSessionsTable)
    .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
    .where(and(parentCondition(kind, parentId), ne(workSessionsTable.status, "voided")))
    .orderBy(peopleTable.name, workSessionsTable.startedAt);
  const sessionIds = rows.map(({ session }) => session.id);
  const breaks = sessionIds.length
    ? await db
        .select()
        .from(workSessionBreaksTable)
        .where(inArray(workSessionBreaksTable.sessionId, sessionIds))
    : [];
  const breakSecondsBySession = new Map<number, number>();
  for (const item of breaks) {
    const endedAt = item.endedAt ?? now;
    const seconds = item.durationSeconds ?? Math.max(0, Math.floor((endedAt.getTime() - item.startedAt.getTime()) / 1000));
    breakSecondsBySession.set(item.sessionId, (breakSecondsBySession.get(item.sessionId) ?? 0) + seconds);
  }

  const people = new Map<number, {
    personId: number;
    personName: string;
    completedSeconds: number;
    activeSeconds: number;
    needsReviewCount: number;
    activeSessionId: number | null;
    activeStartedAt: string | null;
  }>();
  for (const { session, personName } of rows) {
    const item = people.get(session.personId) ?? {
      personId: session.personId,
      personName,
      completedSeconds: 0,
      activeSeconds: 0,
      needsReviewCount: 0,
      activeSessionId: null,
      activeStartedAt: null,
    };
    if (session.status === "completed") {
      item.completedSeconds += session.durationSeconds ?? 0;
    } else if (session.status === "active") {
      item.activeSeconds += calculateSessionDurationSeconds(
        session.startedAt,
        now,
        breakSecondsBySession.get(session.id) ?? 0,
      );
      item.activeSessionId = session.id;
      item.activeStartedAt = session.startedAt.toISOString();
    }
    if (session.reviewStatus === "needs_review") item.needsReviewCount += 1;
    people.set(session.personId, item);
  }

  const workers = [...people.values()].map((item) => ({
    ...item,
    totalSeconds: item.completedSeconds + item.activeSeconds,
    completedHours: item.completedSeconds / 3600,
    activeHours: item.activeSeconds / 3600,
    totalHours: (item.completedSeconds + item.activeSeconds) / 3600,
  }));
  const completedSeconds = workers.reduce((sum, item) => sum + item.completedSeconds, 0);
  const activeSeconds = workers.reduce((sum, item) => sum + item.activeSeconds, 0);
  return {
    completedSeconds,
    activeSeconds,
    totalSeconds: completedSeconds + activeSeconds,
    completedHours: completedSeconds / 3600,
    activeHours: activeSeconds / 3600,
    totalHours: (completedSeconds + activeSeconds) / 3600,
    workerCount: workers.length,
    activeWorkerCount: workers.filter((item) => item.activeSessionId !== null).length,
    needsReviewCount: workers.reduce((sum, item) => sum + item.needsReviewCount, 0),
    workers,
    calculatedAt: now.toISOString(),
  };
}

export async function voidWorkSession(
  kind: WorkKind,
  parentId: number,
  sessionId: number,
  actorUserId: number,
) {
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ personId: workSessionsTable.personId })
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, sessionId), parentCondition(kind, parentId)));
    if (!candidate) return false;
    await lockPerson(tx, candidate.personId);
    const [session] = await tx
      .select()
      .from(workSessionsTable)
      .where(and(eq(workSessionsTable.id, sessionId), parentCondition(kind, parentId)))
      .for("update");
    if (!session || session.status === "voided") return false;
    const now = new Date();
    if (session.status === "active") await breakSeconds(tx, session.id, now);
    await tx
      .update(workSessionsTable)
      .set({ status: "voided", voidedAt: now, voidedByUserId: actorUserId, updatedAt: now })
      .where(eq(workSessionsTable.id, session.id));
    await addEvent(tx, session.id, "voided", actorUserId, { reason: "manual_void" });
    await recomputeAggregate(tx, kind, parentId, session.personId);
    return true;
  });
}

export async function listWorkSessions(kind: WorkKind, parentId: number, personId?: number) {
  return db.transaction(async (tx) => {
    const thresholdSeconds = reviewThresholdSeconds();
    const threshold = new Date(Date.now() - thresholdSeconds * 1000);
    const newlyFlagged = await tx
      .update(workSessionsTable)
      .set({
        reviewStatus: "needs_review",
        reviewReason: "Aktivní časovač překročil limit pro kontrolu",
        reviewFlaggedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          parentCondition(kind, parentId),
          eq(workSessionsTable.status, "active"),
          eq(workSessionsTable.reviewStatus, "not_required"),
          lt(workSessionsTable.startedAt, threshold),
        ),
      )
      .returning({ id: workSessionsTable.id });
    if (newlyFlagged.length) {
      await tx.insert(workSessionEventsTable).values(
        newlyFlagged.map((session) => ({
          sessionId: session.id,
          eventType: "review_flagged",
          data: { reason: "active_duration_limit", thresholdSeconds },
        })),
      );
    }
    const conditions = [parentCondition(kind, parentId)];
    if (personId != null) conditions.push(eq(workSessionsTable.personId, personId));
    const rows = await tx
      .select({ session: workSessionsTable, personName: peopleTable.name })
      .from(workSessionsTable)
      .innerJoin(peopleTable, eq(workSessionsTable.personId, peopleTable.id))
      .where(and(...conditions))
      .orderBy(desc(workSessionsTable.startedAt), desc(workSessionsTable.id));
    return rows.map(({ session, personName }) => ({
      id: session.id,
      personId: session.personId,
      personName,
      jobId: session.jobId,
      activityId: session.activityId,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      durationSeconds: session.durationSeconds,
      status: session.status,
      source: session.source,
      reviewStatus: session.reviewStatus,
      reviewReason: session.reviewReason,
      reviewFlaggedAt: session.reviewFlaggedAt?.toISOString() ?? null,
      note: session.note,
      createdByUserId: session.createdByUserId,
      endedByUserId: session.endedByUserId,
      voidedAt: session.voidedAt?.toISOString() ?? null,
      voidedByUserId: session.voidedByUserId,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    }));
  });
}
