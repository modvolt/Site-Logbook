import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogTable,
  db,
  pool,
  operationalAlertOutboxTable,
  operationalIncidentEventsTable,
  operationalIncidentsTable,
  usersTable,
} from "@workspace/db";
import {
  claimOperationalAlert,
  listOperationalAlertDeadLetters,
  markOperationalAlertDelivered,
  markOperationalAlertFailed,
  reconcileOperationalIncidents,
  requeueOperationalAlertDeadLetter,
} from "../src/lib/operational-incident-store";
import type { OperationalAlert } from "../src/lib/operational-alert-policy";

if (process.env.AUTH_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing to run incident DB tests outside the isolated DB runner.",
  );
}

function alert(
  severity: "warning" | "critical" = "warning",
  fingerprint = "queue.extraction.stale",
): OperationalAlert {
  return {
    fingerprint,
    code: fingerprint,
    severity,
    owner: "Backend / documents",
    runbook: "docs/runbooks/operational-alerts.md#queues",
    summary: "sensitive summary must not persist",
    metric: "oldest_ready_age_seconds",
    observed: severity === "critical" ? 3_600 : 1_000,
    threshold: severity === "critical" ? 3_600 : 900,
  };
}

afterAll(async () => {
  await pool.end();
});

describe("durable operational incident registry and outbox", () => {
  it("records one transition per state change across repeat and concurrent reconciles", async () => {
    const firstAt = "2026-08-04T08:00:00.000Z";
    const [first, concurrent] = await Promise.all([
      reconcileOperationalIncidents([alert()], firstAt),
      reconcileOperationalIncidents([alert()], firstAt),
    ]);
    expect([...first, ...concurrent]).toHaveLength(1);
    expect([...first, ...concurrent][0]?.kind).toBe("triggered");

    await expect(
      reconcileOperationalIncidents([alert()], "2026-08-04T08:05:00.000Z"),
    ).resolves.toEqual([]);
    await expect(
      reconcileOperationalIncidents([alert("critical")], "2026-08-04T08:10:00.000Z"),
    ).resolves.toMatchObject([{ kind: "escalated" }]);
    await expect(
      reconcileOperationalIncidents([], "2026-08-04T08:15:00.000Z"),
    ).resolves.toMatchObject([{ kind: "recovered" }]);
    await expect(
      reconcileOperationalIncidents([alert()], "2026-08-04T08:20:00.000Z"),
    ).resolves.toMatchObject([{ kind: "triggered" }]);

    const incidents = await db.select().from(operationalIncidentsTable);
    const events = await db.select().from(operationalIncidentEventsTable);
    const outbox = await db.select().from(operationalAlertOutboxTable);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ status: "open", sequence: 4 });
    expect(events.map((event) => event.kind)).toEqual([
      "triggered",
      "escalated",
      "recovered",
      "triggered",
    ]);
    expect(new Set(events.map((event) => event.eventKey)).size).toBe(4);
    expect(outbox).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("sensitive summary");
    await reconcileOperationalIncidents([], "2026-08-04T08:25:00.000Z");
    await db.execute(sql`
      update operational_alert_outbox
      set state = 'delivered', delivered_at = now(), updated_at = now()
      where state = 'pending'
    `);
  });

  it("claims each row once, acknowledges by lease token and recovers an expired lease", async () => {
    await reconcileOperationalIncidents(
      [alert("warning", "queue.email_import.failed")],
      "2026-08-04T09:00:00.000Z",
    );
    const claims = await Promise.all([
      claimOperationalAlert(),
      claimOperationalAlert(),
      claimOperationalAlert(),
    ]);
    const claim = claims.find(Boolean);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claim).toBeTruthy();

    await db.execute(sql`
      update operational_alert_outbox
      set lease_expires_at = now() - interval '1 second'
      where id = ${claim!.outboxId}
    `);
    const reclaimed = await claimOperationalAlert();
    expect(reclaimed).toMatchObject({
      outboxId: claim!.outboxId,
      attemptCount: 2,
      eventKey: claim!.eventKey,
    });
    await expect(markOperationalAlertDelivered(claim!)).resolves.toBe(false);
    await expect(markOperationalAlertDelivered(reclaimed!)).resolves.toBe(true);
    const [row] = await db
      .select()
      .from(operationalAlertOutboxTable)
      .where(eq(operationalAlertOutboxTable.id, claim!.outboxId));
    expect(row).toMatchObject({ state: "delivered", attemptCount: 2 });
    await reconcileOperationalIncidents([], "2026-08-04T09:05:00.000Z");
    await db.execute(sql`
      update operational_alert_outbox
      set state = 'delivered', delivered_at = now(), updated_at = now()
      where state = 'pending'
    `);
  });

  it("dead-letters permanent failures and enforces append-only evidence", async () => {
    await reconcileOperationalIncidents(
      [alert("warning", "queue.switchboard.failed")],
      "2026-08-04T10:00:00.000Z",
    );
    const claim = await claimOperationalAlert();
    expect(claim).toBeTruthy();
    await expect(
      markOperationalAlertFailed(claim!, {
        category: "http_permanent",
        retryable: false,
        status: 401,
        attemptCount: 1,
        pendingCount: 0,
      }),
    ).resolves.toBe("dead_letter");
    const [row] = await db
      .select()
      .from(operationalAlertOutboxTable)
      .where(eq(operationalAlertOutboxTable.id, claim!.outboxId));
    expect(row).toMatchObject({
      state: "dead_letter",
      lastFailureCategory: "http_permanent",
      lastHttpStatus: 401,
    });

    const [event] = await db
      .select()
      .from(operationalIncidentEventsTable)
      .where(eq(operationalIncidentEventsTable.eventKey, claim!.eventKey));
    await expect(
      db
        .update(operationalIncidentEventsTable)
        .set({ code: "tampered" })
        .where(eq(operationalIncidentEventsTable.id, event.id)),
    ).rejects.toThrow();
    await expect(
      db
        .delete(operationalIncidentEventsTable)
        .where(eq(operationalIncidentEventsTable.id, event.id)),
    ).rejects.toThrow();
  });

  it("requeues one dead letter with concurrency fencing and atomic redacted audit", async () => {
    const fingerprint = "queue.r15d-requeue.sensitive-fingerprint";
    await reconcileOperationalIncidents(
      [alert("critical", fingerprint)],
      "2026-08-05T01:00:00.000Z",
    );
    const originalClaim = await claimOperationalAlert();
    expect(originalClaim).toBeTruthy();
    await expect(
      markOperationalAlertFailed(originalClaim!, {
        category: "http_permanent",
        retryable: false,
        status: 403,
        attemptCount: 1,
        pendingCount: 0,
      }),
    ).resolves.toBe("dead_letter");

    const [deadLetter] = await db
      .select()
      .from(operationalAlertOutboxTable)
      .where(eq(operationalAlertOutboxTable.id, originalClaim!.outboxId));
    expect(deadLetter.deadLetteredAt).toBeInstanceOf(Date);

    const listed = await listOperationalAlertDeadLetters();
    const listedRow = listed.find(
      (row) => row.outboxId === originalClaim!.outboxId,
    );
    expect(listedRow).toEqual({
      outboxId: originalClaim!.outboxId,
      code: fingerprint,
      severity: "critical",
      transitionKind: "triggered",
      attemptCount: 1,
      lastFailureCategory: "http_permanent",
      lastHttpStatus: 403,
      deadLetteredAt: deadLetter.deadLetteredAt!.toISOString(),
      createdAt: deadLetter.createdAt.toISOString(),
    });
    expect(Object.keys(listedRow!).sort()).toEqual(
      [
        "attemptCount",
        "code",
        "createdAt",
        "deadLetteredAt",
        "lastFailureCategory",
        "lastHttpStatus",
        "outboxId",
        "severity",
        "transitionKind",
      ].sort(),
    );

    const actorName = "R15-D isolated operator";
    const [actor] = await db
      .insert(usersTable)
      .values({
        username: `r15d-operator-${Date.now()}`,
        passwordHash: "isolated-test-only",
        name: actorName,
        role: "master",
      })
      .returning({ id: usersTable.id });
    const [eventBefore] = await db
      .select()
      .from(operationalIncidentEventsTable)
      .where(
        eq(operationalIncidentEventsTable.eventKey, originalClaim!.eventKey),
      );
    const input = {
      outboxId: originalClaim!.outboxId,
      expectedAttemptCount: deadLetter.attemptCount,
      expectedDeadLetteredAt: deadLetter.deadLetteredAt!.toISOString(),
      reason: "receiver_configuration_corrected" as const,
      actor: { userId: actor.id, name: actorName },
    };
    await expect(
      requeueOperationalAlertDeadLetter({
        ...input,
        outboxId: 2_147_483_647,
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      requeueOperationalAlertDeadLetter({
        ...input,
        expectedAttemptCount: input.expectedAttemptCount + 1,
      }),
    ).resolves.toEqual({
      status: "conflict",
      reason: "precondition_failed",
    });
    await expect(
      requeueOperationalAlertDeadLetter({
        ...input,
        expectedDeadLetteredAt: "2026-08-05T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      status: "conflict",
      reason: "precondition_failed",
    });
    expect(
      await db
        .select()
        .from(auditLogTable)
        .where(
          and(
            eq(auditLogTable.action, "operational_alert.dead_letter.requeued"),
            eq(auditLogTable.entityId, originalClaim!.outboxId),
          ),
        ),
    ).toHaveLength(0);

    const concurrent = await Promise.all([
      requeueOperationalAlertDeadLetter(input),
      requeueOperationalAlertDeadLetter(input),
    ]);
    expect(
      concurrent.filter((result) => result.status === "requeued"),
    ).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === "conflict")).toEqual(
      [{ status: "conflict", reason: "not_dead_letter" }],
    );

    const [requeued] = await db
      .select()
      .from(operationalAlertOutboxTable)
      .where(eq(operationalAlertOutboxTable.id, originalClaim!.outboxId));
    expect(requeued).toMatchObject({
      state: "pending",
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      deliveredAt: null,
      deadLetteredAt: null,
      lastFailureCategory: "http_permanent",
      lastHttpStatus: 403,
    });
    expect(
      (await listOperationalAlertDeadLetters()).some(
        (row) => row.outboxId === originalClaim!.outboxId,
      ),
    ).toBe(false);

    const audits = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.action, "operational_alert.dead_letter.requeued"),
          eq(auditLogTable.entityId, originalClaim!.outboxId),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: actor.id,
      actorName,
      entityType: "operational_alert_outbox",
      method: "POST",
      path: `/admin/health/operational-alert-outbox/${originalClaim!.outboxId}/requeue`,
    });
    expect(JSON.parse(audits[0]!.summary!)).toEqual({
      reason: "receiver_configuration_corrected",
      previousAttemptCount: 1,
      previousDeadLetteredAt: deadLetter.deadLetteredAt!.toISOString(),
    });
    expect(audits[0]!.summary).not.toMatch(
      /fingerprint|payload|recipient|owner|runbook|metric|secret/i,
    );

    const reclaimed = await claimOperationalAlert();
    expect(reclaimed).toMatchObject({
      outboxId: originalClaim!.outboxId,
      attemptCount: 1,
    });
    await expect(markOperationalAlertDelivered(originalClaim!)).resolves.toBe(
      false,
    );
    await expect(markOperationalAlertDelivered(reclaimed!)).resolves.toBe(true);
    const [eventAfter] = await db
      .select()
      .from(operationalIncidentEventsTable)
      .where(
        eq(operationalIncidentEventsTable.eventKey, originalClaim!.eventKey),
      );
    expect(eventAfter).toEqual(eventBefore);

    await db
      .delete(auditLogTable)
      .where(
        and(
          eq(auditLogTable.action, "operational_alert.dead_letter.requeued"),
          eq(auditLogTable.entityId, originalClaim!.outboxId),
        ),
      );
    await db.delete(usersTable).where(eq(usersTable.id, actor.id));
  });
});
