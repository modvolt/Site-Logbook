import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request, { type SuperAgentTest } from "supertest";
import bcrypt from "bcryptjs";
import { inArray } from "drizzle-orm";
import {
  activitiesTable,
  activityAttachmentsTable,
  attachmentsTable,
  billingDocumentsTable,
  customerSiteAttachmentsTable,
  customersTable,
  db,
  jobsTable,
  peopleTable,
  pool,
  ppeAssignmentsTable,
  ppeItemsTable,
  quotesTable,
  userPermissionOverridesTable,
  usersTable,
  userSessionsTable,
  type Permission,
} from "@workspace/db";
import {
  canAccessPrivateObject,
  resolvePrivateObjectPermissions,
} from "../src/lib/private-object-access";
import app from "../src/app";
import { bindAuthenticatedAgent } from "./scoped-test-agent";

if (process.env.AUTHORIZATION_DB_TEST_ENABLED !== "true") {
  throw new Error(
    "Refusing to run authorization DB tests without AUTHORIZATION_DB_TEST_ENABLED=true.",
  );
}

const paths = {
  costDocument: "/objects/cost-documents/authorization-cost",
  customerDocument: "/objects/customer-documents/authorization-customer",
  jobSheet: "/objects/job-sheets/authorization-sheet",
  jobSignature: "/objects/job-signatures/authorization-signature.png",
  ppeSignature: "/objects/ppe-signatures/authorization-signature.png",
  quote: "/objects/quotes/authorization-quote",
  jobUpload: "/objects/uploads/authorization-job",
  activityUpload: "/objects/uploads/authorization-activity",
  customerUpload: "/objects/uploads/authorization-customer",
  sharedUpload: "/objects/uploads/authorization-shared",
  wrongDomain: "/objects/customer-documents/authorization-wrong-domain",
} as const;

let customerId: number;
let jobId: number;
let activityId: number;
let personId: number;
let ppeItemId: number;
let deniedUserId: number;
let deniedAgent: SuperAgentTest;

beforeAll(async () => {
  const [customer] = await db
    .insert(customersTable)
    .values({ companyName: "Private object authorization customer" })
    .returning();
  customerId = customer.id;

  const [job] = await db
    .insert(jobsTable)
    .values({
      title: "Private object authorization job",
      date: "2042-01-01",
      customerId,
      signatureObjectPath: paths.jobSignature,
    })
    .returning();
  jobId = job.id;

  const [activity] = await db
    .insert(activitiesTable)
    .values({ name: "Private object authorization activity", customerId })
    .returning();
  activityId = activity.id;

  await db.insert(attachmentsTable).values([
    { jobId, type: "document", url: paths.jobSheet },
    { jobId, type: "document", url: paths.jobUpload },
    { jobId, type: "document", url: paths.sharedUpload },
    { jobId, type: "document", url: paths.wrongDomain },
  ]);
  await db.insert(activityAttachmentsTable).values([
    { activityId, type: "document", url: paths.activityUpload },
    { activityId, type: "document", url: paths.sharedUpload },
  ]);
  await db.insert(customerSiteAttachmentsTable).values([
    { customerId, type: "document", url: paths.customerDocument },
    { customerId, type: "document", url: paths.customerUpload },
  ]);
  await db.insert(quotesTable).values({
    title: "Private object authorization quote",
    customerId,
    pdfObjectPath: paths.quote,
  });
  await db.insert(billingDocumentsTable).values({
    objectPath: paths.costDocument,
    fileName: "authorization-cost.pdf",
  });

  const [person] = await db
    .insert(peopleTable)
    .values({ name: "Private object authorization person" })
    .returning();
  personId = person.id;
  const [ppeItem] = await db
    .insert(ppeItemsTable)
    .values({ name: "Private object authorization PPE", category: "ostatni" })
    .returning();
  ppeItemId = ppeItem.id;
  await db.insert(ppeAssignmentsTable).values({
    ppeItemId,
    personId,
    ppeNameSnapshot: "Private object authorization PPE",
    personNameSnapshot: "Private object authorization person",
    issuedAt: "2042-01-01",
    signatureObjectPath: paths.ppeSignature,
  });

  const [deniedUser] = await db
    .insert(usersTable)
    .values({
      username: "private-object-denied",
      passwordHash: await bcrypt.hash("Private-Object-Test-42", 4),
      name: "Private object denied actor",
      role: "master",
      isActive: true,
    })
    .returning();
  deniedUserId = deniedUser.id;
  await db.insert(userPermissionOverridesTable).values({
    userId: deniedUserId,
    permission: "jobs.view",
    effect: "deny",
  });
  deniedAgent = request.agent(app);
  const login = await deniedAgent
    .post("/api/auth/login")
    .send({ username: deniedUser.username, password: "Private-Object-Test-42" });
  expect(login.status).toBe(200);
  await bindAuthenticatedAgent(deniedAgent);
});

afterAll(async () => {
  await db.delete(userSessionsTable);
  await db
    .delete(userPermissionOverridesTable)
    .where(inArray(userPermissionOverridesTable.userId, [deniedUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [deniedUserId]));
  await db.delete(ppeAssignmentsTable);
  await db.delete(ppeItemsTable).where(inArray(ppeItemsTable.id, [ppeItemId]));
  await db.delete(peopleTable).where(inArray(peopleTable.id, [personId]));
  await db.delete(billingDocumentsTable);
  await db.delete(quotesTable);
  await db.delete(customerSiteAttachmentsTable);
  await db.delete(activityAttachmentsTable);
  await db.delete(attachmentsTable);
  await db.delete(activitiesTable).where(inArray(activitiesTable.id, [activityId]));
  await db.delete(jobsTable).where(inArray(jobsTable.id, [jobId]));
  await db.delete(customersTable).where(inArray(customersTable.id, [customerId]));
  await pool.end();
});

describe("DB-backed private object authorization", () => {
  it.each([
    [paths.costDocument, ["billing.view"]],
    [paths.customerDocument, ["customers.view"]],
    [paths.jobSheet, ["jobs.view"]],
    [paths.jobSignature, ["jobs.view"]],
    [paths.ppeSignature, ["people.view"]],
    [paths.quote, ["quotes.view"]],
    [paths.jobUpload, ["jobs.view"]],
    [paths.activityUpload, ["activities.view"]],
    [paths.customerUpload, ["customers.view"]],
  ] satisfies ReadonlyArray<readonly [string, Permission[]]>) (
    "maps exact stored path %s to its owning permission",
    async (objectPath, permissions) => {
      await expect(resolvePrivateObjectPermissions(objectPath)).resolves.toEqual(
        permissions,
      );
      await expect(canAccessPrivateObject(objectPath, permissions)).resolves.toBe(true);
      await expect(canAccessPrivateObject(objectPath, [])).resolves.toBe(false);
    },
  );

  it("requires all owning permissions when one upload is referenced by multiple modules", async () => {
    await expect(resolvePrivateObjectPermissions(paths.sharedUpload)).resolves.toEqual([
      "jobs.view",
      "activities.view",
    ]);
    await expect(
      canAccessPrivateObject(paths.sharedUpload, ["jobs.view"]),
    ).resolves.toBe(false);
    await expect(
      canAccessPrivateObject(paths.sharedUpload, ["jobs.view", "activities.view"]),
    ).resolves.toBe(true);
  });

  it("denies an object linked from the wrong domain table", async () => {
    await expect(resolvePrivateObjectPermissions(paths.wrongDomain)).resolves.toBeNull();
  });

  it.each([
    "/objects/uploads/unlinked",
    "/objects/job-sheets/unlinked",
    "/objects/invoices/typed-only.pdf",
    "/objects/backups/typed-only.dump",
    "/objects/future-prefix/unknown",
  ])("denies unlinked, typed-only or unknown generic path %s", async (objectPath) => {
    await expect(resolvePrivateObjectPermissions(objectPath)).resolves.toBeNull();
    await expect(
      canAccessPrivateObject(objectPath, [
        "jobs.view",
        "activities.view",
        "customers.view",
        "people.view",
        "quotes.view",
        "billing.view",
      ]),
    ).resolves.toBe(false);
  });

  it("returns the same 404 at the generic endpoint for forbidden and nonexistent objects", async () => {
    const responses = await Promise.all([
      deniedAgent.get(`/api/storage${paths.jobSheet}`),
      deniedAgent.get(`/api/storage${paths.costDocument}`),
      deniedAgent.get("/api/storage/objects/uploads/unlinked"),
      deniedAgent.get("/api/storage/objects/invoices/typed-only.pdf"),
      deniedAgent.get("/api/storage/objects/future-prefix/unknown"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Object not found" });
    }
  });
});
