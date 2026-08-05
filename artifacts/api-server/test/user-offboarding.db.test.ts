import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, or, sql } from "drizzle-orm";
import {
  activitiesTable,
  activityVisitsTable,
  auditLogTable,
  db,
  jobAssigneesTable,
  jobsTable,
  jobVisitsTable,
  machinesTable,
  peopleTable,
  pool,
  ppeAssignmentsTable,
  ppeItemsTable,
  publicAccessTokensTable,
  securityQuestionsTable,
  switchboardAssigneesTable,
  switchboardDefectsTable,
  switchboardsTable,
  userPermissionOverridesTable,
  usersTable,
  userSessionsTable,
  webauthnCredentialsTable,
  workSessionsTable,
} from "@workspace/db";
import app from "../src/app";
import {
  getUserOffboardingPreview,
  offboardUserAccess,
} from "../src/lib/user-offboarding-service";
import { bindAuthenticatedAgent } from "./scoped-test-agent";

if (process.env.AUTH_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing to run user offboarding DB tests outside the isolated DB runner.",
  );
}

const PASSWORD = "R16-A-Initial-Password-42";

function sessionIdFrom(response: { headers: Record<string, unknown> }): string {
  const rawHeader = response.headers["set-cookie"];
  const cookies = Array.isArray(rawHeader)
    ? rawHeader
    : [String(rawHeader ?? "")];
  const cookie = cookies.find((value) => value.startsWith("stavba.sid="));
  if (!cookie) throw new Error("Expected stavba.sid response cookie.");
  const value = decodeURIComponent(
    cookie.split(";", 1)[0].slice("stavba.sid=".length),
  );
  if (!value.startsWith("s:"))
    throw new Error("Expected a signed session cookie.");
  return value.slice(2).split(".", 1)[0];
}

async function login(username: string) {
  const agent = request.agent(app);
  const response = await agent
    .post("/api/auth/login")
    .send({ username, password: PASSWORD });
  expect(response.status).toBe(200);
  await bindAuthenticatedAgent(agent);
  return { agent, sid: sessionIdFrom(response) };
}

async function sessionsForUser(userId: number) {
  return db
    .select()
    .from(userSessionsTable)
    .where(
      or(
        eq(userSessionsTable.userId, userId),
        sql`${userSessionsTable.sess}->>'userId' = ${String(userId)}`,
      ),
    );
}

afterAll(async () => {
  await pool.end();
});

describe("isolated atomic user offboarding", () => {
  it("has one concurrency winner, revokes every access carrier and preserves handover history", async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const [person] = await db
      .insert(peopleTable)
      .values({ name: "R16-A target person", email: "target@example.invalid" })
      .returning();
    const [actor] = await db
      .insert(usersTable)
      .values({
        username: `r16a-actor-${Date.now()}`,
        passwordHash,
        name: "R16-A actor",
        role: "admin",
        isActive: true,
      })
      .returning();
    const [target] = await db
      .insert(usersTable)
      .values({
        username: `r16a-target-${Date.now()}`,
        passwordHash,
        name: "R16-A target",
        personId: person.id,
        role: "guest",
        isActive: true,
      })
      .returning();

    const targetLogin = await login(target.username);
    const [staleSession] = await db
      .select()
      .from(userSessionsTable)
      .where(eq(userSessionsTable.sid, targetLogin.sid));
    expect(staleSession).toBeDefined();
    await db.insert(userSessionsTable).values({
      sid: `r16a-legacy-${Date.now()}`,
      sess: {
        userId: String(target.id),
        sessionGeneration: target.sessionGeneration,
      },
      expire: new Date(Date.now() + 3_600_000),
      userId: null,
    });
    await db.insert(webauthnCredentialsTable).values({
      userId: target.id,
      credentialId: `r16a-credential-${Date.now()}`,
      publicKey: "r16a-public-key",
      counter: 0,
      deviceName: "R16-A device",
    });
    await db.insert(userPermissionOverridesTable).values({
      userId: target.id,
      permission: "users.manage",
      effect: "allow",
      updatedByUserId: actor.id,
    });
    await db.insert(securityQuestionsTable).values({
      userId: target.id,
      position: 1,
      question: "retired question",
      answerHash: "retired-answer-hash",
    });
    await db.insert(publicAccessTokensTable).values({
      purpose: "ppe_confirmation",
      resourceType: "ppe_assignment",
      resourceId: 16_001,
      artifactBindingStatus: "not_applicable",
      tokenHash: "a".repeat(64),
      tokenPrefix: "R16Atok1",
      expiresAt: new Date(Date.now() + 3_600_000),
      createdByUserId: target.id,
    });

    const [primaryJob] = await db
      .insert(jobsTable)
      .values({
        title: "R16-A primary job",
        date: "2026-08-06",
        status: "planned",
        assignedPersonId: person.id,
      })
      .returning();
    const [additionalJob] = await db
      .insert(jobsTable)
      .values({
        title: "R16-A additional job",
        date: "2026-08-07",
        status: "in_progress",
      })
      .returning();
    const [jobAssignee] = await db
      .insert(jobAssigneesTable)
      .values({ jobId: additionalJob.id, personId: person.id })
      .returning();
    const [jobVisit] = await db
      .insert(jobVisitsTable)
      .values({
        jobId: primaryJob.id,
        personId: person.id,
        date: "2026-08-06",
        status: "planned",
      })
      .returning();
    const [activity] = await db
      .insert(activitiesTable)
      .values({ name: "R16-A activity", createdByUserId: actor.id })
      .returning();
    const [activityVisit] = await db
      .insert(activityVisitsTable)
      .values({
        activityId: activity.id,
        personId: person.id,
        date: "2026-08-08",
        status: "planned",
      })
      .returning();
    const [machine] = await db
      .insert(machinesTable)
      .values({ name: "R16-A machine", assignedPersonId: person.id })
      .returning();
    const [ppeItem] = await db
      .insert(ppeItemsTable)
      .values({ name: "R16-A PPE" })
      .returning();
    const [ppeAssignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: ppeItem.id,
        personId: person.id,
        ppeNameSnapshot: ppeItem.name,
        personNameSnapshot: person.name,
        issuedAt: "2026-08-01",
        status: "issued",
      })
      .returning();
    const [switchboard] = await db
      .insert(switchboardsTable)
      .values({
        jobId: primaryJob.id,
        internalName: "R16-A board",
        designation: "R16-A-BOARD",
      })
      .returning();
    const [switchboardAssignee] = await db
      .insert(switchboardAssigneesTable)
      .values({ switchboardId: switchboard.id, personId: person.id })
      .returning();
    const [switchboardDefect] = await db
      .insert(switchboardDefectsTable)
      .values({
        switchboardId: switchboard.id,
        title: "R16-A open defect",
        status: "open",
        responsiblePersonId: person.id,
      })
      .returning();
    const [workSession] = await db
      .insert(workSessionsTable)
      .values({
        personId: person.id,
        parentType: "job",
        parentIdSnapshot: primaryJob.id,
        jobId: primaryJob.id,
        startedAt: new Date("2026-08-05T08:00:00.000Z"),
        status: "active",
      })
      .returning();

    const preview = await getUserOffboardingPreview({
      actorUserId: actor.id,
      targetUserId: target.id,
    });
    expect(preview).toMatchObject({
      username: target.username,
      isActive: true,
      sessionGeneration: target.sessionGeneration,
      access: {
        sessions: 2,
        webauthnCredentials: 1,
        permissionOverrides: 1,
        securityQuestions: 1,
      },
      handover: {
        primaryJobs: 1,
        additionalJobs: 1,
        plannedJobVisits: 1,
        plannedActivityVisits: 1,
        machines: 1,
        issuedPpe: 1,
        switchboardAssignments: 1,
        openResponsibleSwitchboardDefects: 1,
        activeWorkSessions: 1,
      },
    });

    await expect(
      offboardUserAccess({
        actorUserId: actor.id,
        targetUserId: actor.id,
        expectedUsername: actor.username,
        expectedSessionGeneration: actor.sessionGeneration,
        reason: "employment_ended",
      }),
    ).rejects.toMatchObject({ status: 409 });

    const actorLogin = await login(actor.username);
    expect(
      (
        await actorLogin.agent
          .post("/api/auth/vault/verify-password")
          .send({ password: PASSWORD })
      ).status,
    ).toBe(200);
    const extraKey = await actorLogin.agent
      .post(`/api/users/${target.id}/offboard`)
      .send({
        expectedUsername: target.username,
        expectedSessionGeneration: target.sessionGeneration,
        reason: "employment_ended",
        confirmation: "offboard_user",
        unexpected: "must be rejected",
      });
    expect(extraKey.status).toBe(400);

    const input = {
      actorUserId: actor.id,
      targetUserId: target.id,
      expectedUsername: target.username,
      expectedSessionGeneration: target.sessionGeneration,
      reason: "employment_ended" as const,
    };
    const attempts = await Promise.allSettled([
      offboardUserAccess(input),
      offboardUserAccess(input),
    ]);
    const successes = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof offboardUserAccess>>
      > => result.status === "fulfilled",
    );
    const failures = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ status: 409 });
    expect(successes[0].value).toMatchObject({
      userId: target.id,
      isActive: false,
      newSessionGeneration: target.sessionGeneration + 1,
      revokedAccess: preview.access,
      handover: preview.handover,
    });

    const [offboarded] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, target.id));
    expect(offboarded).toMatchObject({
      id: target.id,
      personId: person.id,
      isActive: false,
      sessionGeneration: target.sessionGeneration + 1,
    });
    expect(offboarded.passwordHash).not.toBe(target.passwordHash);
    expect(await sessionsForUser(target.id)).toHaveLength(0);
    expect(
      await db
        .select()
        .from(webauthnCredentialsTable)
        .where(eq(webauthnCredentialsTable.userId, target.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(userPermissionOverridesTable)
        .where(eq(userPermissionOverridesTable.userId, target.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(securityQuestionsTable)
        .where(eq(securityQuestionsTable.userId, target.id)),
    ).toHaveLength(0);
    const [preservedToken] = await db
      .select()
      .from(publicAccessTokensTable)
      .where(eq(publicAccessTokensTable.createdByUserId, target.id));
    expect(preservedToken).toMatchObject({
      revokedAt: null,
      revokedByUserId: null,
      revokeReason: null,
    });

    const offboardingEvents = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.action, "user.access.offboarded"));
    expect(offboardingEvents).toHaveLength(1);
    expect(offboardingEvents[0]).toMatchObject({
      actorUserId: actor.id,
      entityType: "users",
      entityId: target.id,
    });
    expect(JSON.stringify(offboardingEvents)).not.toContain(target.username);
    expect(JSON.stringify(offboardingEvents)).not.toContain("R16Atok1");

    expect(
      await db.select().from(peopleTable).where(eq(peopleTable.id, person.id)),
    ).toHaveLength(1);
    expect(
      await db.select().from(jobsTable).where(eq(jobsTable.id, primaryJob.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(jobAssigneesTable)
        .where(eq(jobAssigneesTable.id, jobAssignee.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(jobVisitsTable)
        .where(eq(jobVisitsTable.id, jobVisit.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(activityVisitsTable)
        .where(eq(activityVisitsTable.id, activityVisit.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(machinesTable)
        .where(eq(machinesTable.id, machine.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(ppeAssignmentsTable)
        .where(eq(ppeAssignmentsTable.id, ppeAssignment.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(switchboardAssigneesTable)
        .where(eq(switchboardAssigneesTable.id, switchboardAssignee.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(switchboardDefectsTable)
        .where(eq(switchboardDefectsTable.id, switchboardDefect.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(workSessionsTable)
        .where(eq(workSessionsTable.id, workSession.id)),
    ).toHaveLength(1);

    await db.insert(userSessionsTable).values(staleSession);
    const staleRequest = await targetLogin.agent.get("/api/auth/me");
    expect(staleRequest.status).toBe(200);
    expect(staleRequest.body).toMatchObject({ authenticated: false });
    expect(
      await db
        .select()
        .from(userSessionsTable)
        .where(eq(userSessionsTable.sid, targetLogin.sid)),
    ).toHaveLength(0);
    expect(
      (
        await request(app)
          .post("/api/auth/login")
          .send({ username: target.username, password: PASSWORD })
      ).status,
    ).toBe(401);
  });
});
