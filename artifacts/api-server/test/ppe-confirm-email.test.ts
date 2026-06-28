import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request, { type Agent } from "supertest";
import { db, usersTable, ppeItemsTable, ppeAssignmentsTable, peopleTable } from "@workspace/db";

/**
 * Integration tests for POST /ppe/assignments/:id/request-confirm
 *
 * Verifies that:
 * - When the assigned person has an email address, the endpoint sends a
 *   confirmation email and sets confirmEmailSentAt in the DB (emailSent=true).
 * - When the assigned person has no email, the endpoint skips sending and
 *   leaves confirmEmailSentAt null (emailSent=false).
 *
 * The email module is mocked so no real SMTP connection is required.
 */

const sendPlainEmailMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/lib/email", () => ({
  sendPlainEmail: sendPlainEmailMock,
  sendEmailWithPdf: vi.fn().mockResolvedValue(undefined),
  sendTestEmail: vi.fn().mockResolvedValue(undefined),
  resolveEmailConfig: vi.fn().mockResolvedValue({
    host: "smtp.test",
    port: 587,
    secure: false,
    from: "test@example.com",
  }),
}));

const { default: app } = await import("../src/app");

const TAG = `test-ppe-email-${Date.now()}`;
const PASSWORD = "ppe-email-test-pw";

let adminAgent: Agent;
let adminUserId: number;

const userIds: number[] = [];
const personIds: number[] = [];
const itemIds: number[] = [];
const assignmentIds: number[] = [];

beforeAll(async () => {
  const [admin] = await db
    .insert(usersTable)
    .values({
      username: `${TAG}-admin`,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      name: `PPE Email Admin ${TAG}`,
      role: "admin",
      isActive: true,
    })
    .returning();
  adminUserId = admin.id;
  userIds.push(adminUserId);

  adminAgent = request.agent(app);
  const res = await adminAgent.post("/api/auth/login").send({
    username: `${TAG}-admin`,
    password: PASSWORD,
  });
  expect(res.status).toBe(200);
});

afterAll(async () => {
  if (assignmentIds.length > 0)
    await db.delete(ppeAssignmentsTable).where(inArray(ppeAssignmentsTable.id, assignmentIds));
  if (itemIds.length > 0)
    await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, itemIds));
  if (personIds.length > 0)
    await db.delete(peopleTable).where(inArray(peopleTable.id, personIds));
  if (userIds.length > 0)
    await db.delete(usersTable).where(inArray(usersTable.id, userIds));
});

describe("request-confirm: person WITH email", () => {
  let assignmentId: number;

  beforeAll(async () => {
    const [person] = await db
      .insert(peopleTable)
      .values({ name: `Worker With Email ${TAG}`, email: "worker@example.com" })
      .returning();
    personIds.push(person.id);

    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `Helmet ${TAG}`, category: "hlava", active: true })
      .returning();
    itemIds.push(item.id);

    const todayStr = new Date().toISOString().slice(0, 10);
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: item.id,
        personId: person.id,
        ppeNameSnapshot: item.name,
        personNameSnapshot: person.name,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
      })
      .returning();
    assignmentId = assignment.id;
    assignmentIds.push(assignmentId);

    sendPlainEmailMock.mockClear();
  });

  it("returns 200 with emailSent=true", async () => {
    const res = await adminAgent.post(`/api/ppe/assignments/${assignmentId}/request-confirm`);
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(true);
    expect(typeof res.body.confirmUrl).toBe("string");
    expect(res.body.confirmUrl.length).toBeGreaterThan(0);
  });

  it("calls sendPlainEmail once with the person's email address", async () => {
    expect(sendPlainEmailMock).toHaveBeenCalledTimes(1);
    const call = sendPlainEmailMock.mock.calls[0][0] as { to: string; subject: string; text: string };
    expect(call.to).toBe("worker@example.com");
    expect(call.subject).toMatch(/OOPP/i);
    expect(call.text).toMatch(/http/);
  });

  it("sets confirmEmailSentAt in the DB", async () => {
    const [row] = await db
      .select({ confirmEmailSentAt: ppeAssignmentsTable.confirmEmailSentAt })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, assignmentId));
    expect(row.confirmEmailSentAt).not.toBeNull();
  });
});

describe("request-confirm: person WITHOUT email", () => {
  let assignmentId: number;

  beforeAll(async () => {
    const [person] = await db
      .insert(peopleTable)
      .values({ name: `Worker No Email ${TAG}` })
      .returning();
    personIds.push(person.id);

    const [item] = await db
      .insert(ppeItemsTable)
      .values({ name: `Gloves ${TAG}`, category: "ruky", active: true })
      .returning();
    itemIds.push(item.id);

    const todayStr = new Date().toISOString().slice(0, 10);
    const [assignment] = await db
      .insert(ppeAssignmentsTable)
      .values({
        ppeItemId: item.id,
        personId: person.id,
        ppeNameSnapshot: item.name,
        personNameSnapshot: person.name,
        quantity: 1,
        issuedAt: todayStr,
        status: "issued",
      })
      .returning();
    assignmentId = assignment.id;
    assignmentIds.push(assignmentId);

    sendPlainEmailMock.mockClear();
  });

  it("returns 200 with emailSent=false", async () => {
    const res = await adminAgent.post(`/api/ppe/assignments/${assignmentId}/request-confirm`);
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(typeof res.body.confirmUrl).toBe("string");
  });

  it("does NOT call sendPlainEmail", async () => {
    expect(sendPlainEmailMock).not.toHaveBeenCalled();
  });

  it("leaves confirmEmailSentAt null in the DB", async () => {
    const [row] = await db
      .select({ confirmEmailSentAt: ppeAssignmentsTable.confirmEmailSentAt })
      .from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, assignmentId));
    expect(row.confirmEmailSentAt).toBeNull();
  });
});
