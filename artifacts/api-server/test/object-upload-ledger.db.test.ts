import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, objectUploadsTable, pool, usersTable } from "@workspace/db";
import {
  claimObjectUpload,
  createObjectUploadIntent,
  markObjectUploadQuarantined,
  markObjectUploadStored,
  ObjectUploadClaimError,
} from "../src/lib/object-upload-ledger";

const userIds: number[] = [];
const objectPaths: string[] = [];

beforeAll(async () => {
  for (const label of ["owner", "other"]) {
    const [user] = await db.insert(usersTable).values({
      username: `upload-ledger-${label}-${randomUUID()}`,
      passwordHash: "not-used",
      name: label,
      role: "admin",
    }).returning({ id: usersTable.id });
    userIds.push(user.id);
  }
});

afterAll(async () => {
  if (objectPaths.length) {
    await db.delete(objectUploadsTable).where(inArray(objectUploadsTable.objectPath, objectPaths));
  }
  if (userIds.length) await db.delete(usersTable).where(inArray(usersTable.id, userIds));
  await pool.end();
});

async function stagedUpload(owner = userIds[0]): Promise<string> {
  const objectPath = `/objects/uploads/v2/${randomUUID()}`;
  objectPaths.push(objectPath);
  await createObjectUploadIntent({
    objectPath,
    uploadedByUserId: owner,
    originalName: "photo.png",
    contentType: "image/png",
    sizeBytes: 128,
    sha256: "a".repeat(64),
  });
  await markObjectUploadStored(objectPath, "content_validated");
  return objectPath;
}

describe("durable object upload ledger", () => {
  it("keeps an unclaimed completed upload visibly staged", async () => {
    const objectPath = await stagedUpload();
    const [record] = await db.select().from(objectUploadsTable)
      .where(eq(objectUploadsTable.objectPath, objectPath));
    expect(record.state).toBe("stored");
    expect(record.claimId).toBeNull();
    expect(record.storedAt).toBeInstanceOf(Date);
  });

  it("allows exactly the uploader to claim a staged v2 object", async () => {
    const objectPath = await stagedUpload();
    await expect(claimObjectUpload(db, {
      objectPath,
      userId: userIds[1],
      claimType: "job_attachment",
      claimId: 10,
    })).rejects.toBeInstanceOf(ObjectUploadClaimError);

    await claimObjectUpload(db, {
      objectPath,
      userId: userIds[0],
      claimType: "job_attachment",
      claimId: 11,
    });
    const [record] = await db.select().from(objectUploadsTable)
      .where(eq(objectUploadsTable.objectPath, objectPath));
    expect(record).toMatchObject({ state: "claimed", claimType: "job_attachment", claimId: "11" });
  });

  it("never permits a quarantined object to be claimed", async () => {
    const objectPath = `/objects/uploads/v2/${randomUUID()}`;
    objectPaths.push(objectPath);
    await createObjectUploadIntent({
      objectPath,
      uploadedByUserId: userIds[0],
      originalName: "macro.doc",
      contentType: "application/msword",
      sizeBytes: 64,
      sha256: "b".repeat(64),
    });
    await markObjectUploadQuarantined(objectPath, "scanner unavailable");
    await expect(claimObjectUpload(db, {
      objectPath,
      userId: userIds[0],
      claimType: "job_attachment",
      claimId: 12,
    })).rejects.toBeInstanceOf(ObjectUploadClaimError);
    const [record] = await db.select().from(objectUploadsTable)
      .where(eq(objectUploadsTable.objectPath, objectPath));
    expect(record.state).toBe("quarantined");
  });
});
