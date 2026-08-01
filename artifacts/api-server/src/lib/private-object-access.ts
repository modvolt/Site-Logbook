import { eq } from "drizzle-orm";
import {
  activityAttachmentsTable,
  attachmentsTable,
  billingDocumentFilesTable,
  billingDocumentsTable,
  customerSiteAttachmentsTable,
  db,
  emailImportAttachmentsTable,
  jobsTable,
  ppeAssignmentsTable,
  quotesTable,
  type Permission,
} from "@workspace/db";
import { classifyPrivateObjectPath } from "./private-object-policy";

async function hasJobAttachment(objectPath: string): Promise<boolean> {
  const rows = await db
    .select({ id: attachmentsTable.id })
    .from(attachmentsTable)
    .where(eq(attachmentsTable.url, objectPath))
    .limit(1);
  return rows.length > 0;
}

async function hasActivityAttachment(objectPath: string): Promise<boolean> {
  const rows = await db
    .select({ id: activityAttachmentsTable.id })
    .from(activityAttachmentsTable)
    .where(eq(activityAttachmentsTable.url, objectPath))
    .limit(1);
  return rows.length > 0;
}

async function hasCustomerAttachment(objectPath: string): Promise<boolean> {
  const rows = await db
    .select({ id: customerSiteAttachmentsTable.id })
    .from(customerSiteAttachmentsTable)
    .where(eq(customerSiteAttachmentsTable.url, objectPath))
    .limit(1);
  return rows.length > 0;
}

async function hasCostDocumentReference(objectPath: string): Promise<boolean> {
  const [documents, files, emailAttachments] = await Promise.all([
    db
      .select({ id: billingDocumentsTable.id })
      .from(billingDocumentsTable)
      .where(eq(billingDocumentsTable.objectPath, objectPath))
      .limit(1),
    db
      .select({ id: billingDocumentFilesTable.id })
      .from(billingDocumentFilesTable)
      .where(eq(billingDocumentFilesTable.objectPath, objectPath))
      .limit(1),
    db
      .select({ id: emailImportAttachmentsTable.id })
      .from(emailImportAttachmentsTable)
      .where(eq(emailImportAttachmentsTable.objectPath, objectPath))
      .limit(1),
  ]);
  return documents.length > 0 || files.length > 0 || emailAttachments.length > 0;
}

async function hasQuoteReference(objectPath: string): Promise<boolean> {
  const rows = await db
    .select({ id: quotesTable.id })
    .from(quotesTable)
    .where(eq(quotesTable.pdfObjectPath, objectPath))
    .limit(1);
  return rows.length > 0;
}

async function hasJobSignatureReference(objectPath: string): Promise<boolean> {
  const rows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.signatureObjectPath, objectPath))
    .limit(1);
  return rows.length > 0;
}

async function hasPpeSignatureReference(objectPath: string): Promise<boolean> {
  const rows = await db
    .select({ id: ppeAssignmentsTable.id })
    .from(ppeAssignmentsTable)
    .where(eq(ppeAssignmentsTable.signatureObjectPath, objectPath))
    .limit(1);
  return rows.length > 0;
}

/**
 * Resolves an exact database reference to the module permissions that own it.
 * `null` means the generic route must behave as if the object did not exist.
 * A shared `/uploads/` key requires every module permission that references it.
 */
export async function resolvePrivateObjectPermissions(
  objectPath: string,
): Promise<readonly Permission[] | null> {
  const classification = classifyPrivateObjectPath(objectPath);
  if (classification.kind !== "db-backed") return null;

  switch (classification.prefix) {
    case "cost-documents":
      return (await hasCostDocumentReference(objectPath)) ? ["billing.view"] : null;
    case "customer-documents":
      return (await hasCustomerAttachment(objectPath)) ? ["customers.view"] : null;
    case "job-sheets":
      return (await hasJobAttachment(objectPath)) ? ["jobs.view"] : null;
    case "job-signatures":
      return (await hasJobSignatureReference(objectPath)) ? ["jobs.view"] : null;
    case "ppe-signatures":
      return (await hasPpeSignatureReference(objectPath)) ? ["people.view"] : null;
    case "quotes":
      return (await hasQuoteReference(objectPath)) ? ["quotes.view"] : null;
    case "uploads": {
      const [job, activity, customer] = await Promise.all([
        hasJobAttachment(objectPath),
        hasActivityAttachment(objectPath),
        hasCustomerAttachment(objectPath),
      ]);
      const required: Permission[] = [];
      if (job) required.push("jobs.view");
      if (activity) required.push("activities.view");
      if (customer) required.push("customers.view");
      return required.length > 0 ? required : null;
    }
  }
}

export async function canAccessPrivateObject(
  objectPath: string,
  permissions: readonly Permission[],
): Promise<boolean> {
  const required = await resolvePrivateObjectPermissions(objectPath);
  return required !== null && required.every((permission) => permissions.includes(permission));
}
