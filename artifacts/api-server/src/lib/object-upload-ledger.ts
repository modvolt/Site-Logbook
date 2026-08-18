import { and, eq } from "drizzle-orm";
import { db, objectUploadsTable } from "@workspace/db";

export const LEDGERED_UPLOAD_PREFIX = "/objects/uploads/v2/";

type UpdateExecutor = Pick<typeof db, "update">;

export class ObjectUploadClaimError extends Error {
  constructor() {
    super("Upload není ve stavu, který lze bezpečně navázat na záznam.");
    this.name = "ObjectUploadClaimError";
  }
}

export async function createObjectUploadIntent(input: {
  objectPath: string;
  uploadedByUserId: number;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}): Promise<void> {
  await db.insert(objectUploadsTable).values(input);
}

export async function markObjectUploadStored(
  objectPath: string,
  scannerStatus: "content_validated" | "clean",
): Promise<void> {
  await db.update(objectUploadsTable).set({
    state: "stored",
    scannerStatus,
    storedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(objectUploadsTable.objectPath, objectPath));
}

export async function markObjectUploadQuarantined(
  objectPath: string,
  reason: string,
): Promise<void> {
  await db.update(objectUploadsTable).set({
    state: "quarantined",
    scannerStatus: "unavailable",
    storedAt: new Date(),
    lastError: reason.slice(0, 1_000),
    updatedAt: new Date(),
  }).where(eq(objectUploadsTable.objectPath, objectPath));
}

export async function markObjectUploadFailed(
  objectPath: string,
  reason: string,
  scannerStatus: "pending" | "malicious" | "unavailable" = "pending",
): Promise<void> {
  await db.update(objectUploadsTable).set({
    state: "failed",
    scannerStatus,
    lastError: reason.slice(0, 1_000),
    updatedAt: new Date(),
  }).where(eq(objectUploadsTable.objectPath, objectPath));
}

/** Atomically claim only a current user's v2 staged upload. Legacy paths are untouched. */
export async function claimObjectUpload(
  executor: UpdateExecutor,
  input: {
    objectPath: string;
    userId: number;
    claimType: string;
    claimId: string | number;
  },
): Promise<void> {
  if (!input.objectPath.startsWith(LEDGERED_UPLOAD_PREFIX)) return;
  const [claimed] = await executor.update(objectUploadsTable).set({
    state: "claimed",
    claimType: input.claimType,
    claimId: String(input.claimId),
    claimedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(objectUploadsTable.objectPath, input.objectPath),
    eq(objectUploadsTable.uploadedByUserId, input.userId),
    eq(objectUploadsTable.state, "stored"),
  )).returning({ objectPath: objectUploadsTable.objectPath });
  if (!claimed) throw new ObjectUploadClaimError();
}
