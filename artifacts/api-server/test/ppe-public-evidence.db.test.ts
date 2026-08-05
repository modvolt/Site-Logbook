import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db,
  peopleTable,
  ppeAssignmentsTable,
  ppeItemsTable,
  ppePublicEvidenceEventsTable,
  ppePublicEvidenceVersionsTable,
  publicAccessTokensTable,
  usersTable,
} from "@workspace/db";
import { evidenceSha256 } from "../src/lib/evidence-hash";
import {
  consumePpePublicEvidenceToken,
  issuePpePublicEvidenceToken,
  resolvePpePublicEvidenceToken,
} from "../src/lib/ppe-public-evidence";
import {
  hashPublicAccessToken,
  resolvePublicAccessToken,
} from "../src/lib/public-access-token";

const TAG = `ppe-public-evidence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const FUTURE = () => new Date(Date.now() + 10 * 60_000);

let issuerId: number;
let personId: number;
let itemId: number;

beforeAll(async () => {
  const [issuer] = await db.insert(usersTable).values({
    username: `${TAG}-issuer`,
    passwordHash: "not-used",
    name: `Issuer ${TAG}`,
    role: "admin",
    isActive: true,
  }).returning();
  issuerId = issuer!.id;

  const [person] = await db.insert(peopleTable).values({
    name: `Recipient ${TAG}`,
  }).returning();
  personId = person!.id;

  const [item] = await db.insert(ppeItemsTable).values({
    name: `Helmet ${TAG}`,
    category: "hlava",
    active: true,
  }).returning();
  itemId = item!.id;
});

async function createAssignment() {
  const [assignment] = await db.insert(ppeAssignmentsTable).values({
    ppeItemId: itemId,
    personId,
    ppeNameSnapshot: `Helmet ${TAG}`,
    personNameSnapshot: `Recipient ${TAG}`,
    ppeCategorySnapshot: "hlava",
    ppeStandardSnapshot: "EN 397",
    quantity: 1,
    size: "M",
    serialNumber: `SN-${Math.random().toString(36).slice(2)}`,
    issuedAt: "2026-08-05",
    replaceBy: "2027-08-05",
    status: "issued",
  }).returning();
  return assignment!;
}

describe("PPE public immutable evidence at the database boundary", () => {
  it("keeps public display content bound to the issuance snapshot", async () => {
    const assignment = await createAssignment();
    const issued = await issuePpePublicEvidenceToken({
      assignmentId: assignment.id,
      purpose: "ppe_signature",
      expiresAt: FUTURE(),
      createdByUserId: issuerId,
    });

    await db.update(ppeAssignmentsTable).set({
      ppeNameSnapshot: `Changed after issuance ${TAG}`,
      quantity: 9,
    }).where(eq(ppeAssignmentsTable.id, assignment.id));

    const resolved = await resolvePpePublicEvidenceToken(
      "ppe_signature",
      issued.token,
    );
    expect(resolved.record).toMatchObject({
      resourceId: assignment.id,
      artifactBindingStatus: "bound",
      ppeEvidenceVersionId: issued.evidenceVersion.id,
    });
    expect(resolved.snapshot.assignment).toMatchObject({
      ppeNameSnapshot: `Helmet ${TAG}`,
      quantity: 1,
    });
    expect(resolved.evidenceVersion.snapshotSha256).toBe(
      evidenceSha256(resolved.snapshot),
    );

    await expect(db.update(ppePublicEvidenceVersionsTable)
      .set({ confirmationText: "Tampered" })
      .where(eq(ppePublicEvidenceVersionsTable.id, issued.evidenceVersion.id)))
      .rejects.toBeDefined();
    await expect(db.delete(ppePublicEvidenceVersionsTable)
      .where(eq(ppePublicEvidenceVersionsTable.id, issued.evidenceVersion.id)))
      .rejects.toBeDefined();
  });

  it("atomically confirms and appends one immutable event with the exact evidence", async () => {
    const assignment = await createAssignment();
    const issued = await issuePpePublicEvidenceToken({
      assignmentId: assignment.id,
      purpose: "ppe_confirmation",
      expiresAt: FUTURE(),
      createdByUserId: issuerId,
    });

    const consumed = await consumePpePublicEvidenceToken({
      purpose: "ppe_confirmation",
      token: issued.token,
      action: "confirmed",
    });
    expect(consumed.snapshot).toEqual(issued.snapshot);

    const [assignmentAfter] = await db.select({
      employeeConfirmedAt: ppeAssignmentsTable.employeeConfirmedAt,
    }).from(ppeAssignmentsTable)
      .where(eq(ppeAssignmentsTable.id, assignment.id));
    expect(assignmentAfter?.employeeConfirmedAt).toBeInstanceOf(Date);

    const [tokenAfter] = await db.select({
      consumedAt: publicAccessTokensTable.consumedAt,
      consumeAction: publicAccessTokensTable.consumeAction,
    }).from(publicAccessTokensTable)
      .where(eq(publicAccessTokensTable.id, issued.record.id));
    expect(tokenAfter?.consumedAt).toBeInstanceOf(Date);
    expect(tokenAfter?.consumeAction).toBe("confirmed");

    const [event] = await db.select()
      .from(ppePublicEvidenceEventsTable)
      .where(eq(ppePublicEvidenceEventsTable.publicAccessTokenId, issued.record.id));
    expect(event).toMatchObject({
      assignmentId: assignment.id,
      evidenceVersionId: issued.evidenceVersion.id,
      action: "confirmed",
      snapshotSha256: issued.evidenceVersion.snapshotSha256,
      confirmationText: issued.evidenceVersion.confirmationText,
      signatureObjectPath: null,
      signatureSha256: null,
    });

    await expect(db.update(ppePublicEvidenceEventsTable)
      .set({ confirmationText: "Tampered" })
      .where(eq(ppePublicEvidenceEventsTable.id, event!.id)))
      .rejects.toBeDefined();
    await expect(db.delete(ppePublicEvidenceEventsTable)
      .where(eq(ppePublicEvidenceEventsTable.id, event!.id)))
      .rejects.toBeDefined();
  });

  it("fails legacy unbound PPE capabilities closed without inventing evidence", async () => {
    const assignment = await createAssignment();
    const rawToken = "L".repeat(43);
    await db.insert(publicAccessTokensTable).values({
      purpose: "ppe_confirmation",
      resourceType: "ppe_assignment",
      resourceId: assignment.id,
      artifactBindingStatus: "not_applicable",
      tokenHash: hashPublicAccessToken(rawToken),
      tokenPrefix: rawToken.slice(0, 8),
      expiresAt: FUTURE(),
      legacyImportedAt: new Date(),
    });

    await expect(resolvePublicAccessToken("ppe_confirmation", rawToken))
      .rejects.toMatchObject({ code: "revoked" });
    const versions = await db.select({ id: ppePublicEvidenceVersionsTable.id })
      .from(ppePublicEvidenceVersionsTable)
      .where(eq(ppePublicEvidenceVersionsTable.assignmentId, assignment.id));
    expect(versions).toHaveLength(0);
  });

  it("rechecks assignment eligibility inside consume and rolls the action back", async () => {
    const assignment = await createAssignment();
    const issued = await issuePpePublicEvidenceToken({
      assignmentId: assignment.id,
      purpose: "ppe_signature",
      expiresAt: FUTURE(),
      createdByUserId: issuerId,
    });
    await db.update(ppeAssignmentsTable)
      .set({ status: "returned" })
      .where(eq(ppeAssignmentsTable.id, assignment.id));

    await expect(consumePpePublicEvidenceToken({
      purpose: "ppe_signature",
      token: issued.token,
      action: "signed",
      signatureObjectPath: `/objects/ppe-signatures/${assignment.id}-test.png`,
      signatureSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "closed" });

    const [tokenAfter] = await db.select({
      consumedAt: publicAccessTokensTable.consumedAt,
      revokedAt: publicAccessTokensTable.revokedAt,
    }).from(publicAccessTokensTable)
      .where(eq(publicAccessTokensTable.id, issued.record.id));
    expect(tokenAfter).toEqual({ consumedAt: null, revokedAt: null });
    const events = await db.select({ id: ppePublicEvidenceEventsTable.id })
      .from(ppePublicEvidenceEventsTable)
      .where(and(
        eq(ppePublicEvidenceEventsTable.assignmentId, assignment.id),
        eq(ppePublicEvidenceEventsTable.publicAccessTokenId, issued.record.id),
      ));
    expect(events).toHaveLength(0);
  });
});
