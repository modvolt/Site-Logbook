import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogTable,
  billingDocumentReferencesTable,
  billingDocumentsTable,
  db,
} from "@workspace/db";
import {
  addReference,
  approveDocument,
  deleteReference,
  getDocument,
  listDocuments,
  setDocumentDeliveryNoteResolution,
  setDocumentStatus,
  updateReference,
} from "../src/lib/cost-document-service";
import { enforceApiPermission } from "../src/middlewares/permissions";

const TAG = `test-delivery-note-gate-${Date.now()}`;
const actor = { userId: null, name: TAG };
const documentIds: number[] = [];

async function createDocument(
  docType: "invoice" | "delivery_note",
  status: "needs_review" | "approved" = "needs_review",
) {
  const [document] = await db
    .insert(billingDocumentsTable)
    .values({
      status,
      docType,
      docTypeSource: "admin",
      source: "manual",
      supplierName: `Dodavatel ${TAG}`,
      documentNumber: `${docType === "invoice" ? "FV" : "DL"}-${TAG}-${documentIds.length + 1}`,
    })
    .returning();
  documentIds.push(document.id);
  return document;
}

async function linkDeliveryNote(invoiceId: number, deliveryNoteId: number) {
  const [reference] = await db
    .insert(billingDocumentReferencesTable)
    .values({
      documentId: invoiceId,
      referenceType: "delivery_note",
      referenceNumber: `DL-${TAG}-${deliveryNoteId}`,
      source: "manual",
      matchedDocumentId: deliveryNoteId,
      matchConfidence: "1",
      matchConfirmed: 1,
    })
    .returning();
  return reference;
}

afterEach(async () => {
  if (documentIds.length === 0) return;
  await db
    .delete(auditLogTable)
    .where(
      and(
        eq(auditLogTable.entityType, "billing_documents"),
        inArray(auditLogTable.entityId, documentIds),
      ),
    );
  await db
    .delete(billingDocumentsTable)
    .where(inArray(billingDocumentsTable.id, documentIds));
  documentIds.length = 0;
});

describe("supplier invoice delivery-note approval gate", () => {
  it("blocks an invoice until an administrator decides whether a delivery note exists", async () => {
    const invoice = await createDocument("invoice");

    const detail = await getDocument(invoice.id);
    expect(detail?.document.deliveryNoteWorkflow.state).toBe("needs_decision");
    await expect(approveDocument(invoice.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("allows an audited no-delivery-note decision with a mandatory reason", async () => {
    const invoice = await createDocument("invoice");

    await expect(
      setDocumentDeliveryNoteResolution(
        invoice.id,
        { resolution: "not_required", reason: "  " },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const reason = "Dodavatel dodací list nevystavil";
    const resolved = await setDocumentDeliveryNoteResolution(
      invoice.id,
      { resolution: "not_required", reason },
      actor,
    );
    expect(resolved?.document.deliveryNoteWorkflow.state).toBe(
      "ready_without_delivery_note",
    );

    await approveDocument(invoice.id, actor);
    const approved = await getDocument(invoice.id);
    expect(approved?.document.status).toBe("approved");

    const [audit] = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.entityType, "billing_documents"),
          eq(auditLogTable.entityId, invoice.id),
          eq(auditLogTable.action, "delivery_note_resolution_changed"),
        ),
      );
    expect(audit?.summary).toContain(reason);
  });

  it("requires every linked delivery note to be confirmed and approved", async () => {
    const invoice = await createDocument("invoice");
    const deliveryNote = await createDocument("delivery_note");
    await linkDeliveryNote(invoice.id, deliveryNote.id);

    const waiting = await getDocument(invoice.id);
    expect(waiting?.document.deliveryNoteWorkflow).toMatchObject({
      state: "waiting_for_delivery_note",
      referenceCount: 1,
      approvedReferenceCount: 0,
    });
    await expect(approveDocument(invoice.id, actor)).rejects.toMatchObject({
      statusCode: 409,
    });

    await approveDocument(deliveryNote.id, actor);
    const ready = await getDocument(invoice.id);
    expect(ready?.document.deliveryNoteWorkflow).toMatchObject({
      state: "ready",
      referenceCount: 1,
      approvedReferenceCount: 1,
    });

    await approveDocument(invoice.id, actor);
    expect((await getDocument(invoice.id))?.document.status).toBe("approved");
  });

  it("supports an audited waiver when a referenced delivery note is unavailable", async () => {
    const invoice = await createDocument("invoice");
    const deliveryNote = await createDocument("delivery_note");
    await linkDeliveryNote(invoice.id, deliveryNote.id);

    await expect(
      setDocumentDeliveryNoteResolution(
        invoice.id,
        {
          resolution: "not_required",
          reason: "Dodací list nebude dodán",
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    await setDocumentDeliveryNoteResolution(
      invoice.id,
      {
        resolution: "waived",
        reason: "Dodavatel odmítl dodat kopii dodacího listu",
      },
      actor,
    );
    await approveDocument(invoice.id, actor);
    expect((await getDocument(invoice.id))?.document.status).toBe("approved");
  });

  it("does not allow an approved delivery note to be reopened under an approved invoice", async () => {
    const invoice = await createDocument("invoice");
    const deliveryNote = await createDocument("delivery_note");
    await approveDocument(deliveryNote.id, actor);
    await linkDeliveryNote(invoice.id, deliveryNote.id);
    await approveDocument(invoice.id, actor);

    await expect(
      setDocumentStatus(deliveryNote.id, "needs_review", actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await getDocument(deliveryNote.id))?.document.status).toBe(
      "approved",
    );
  });

  it("locks reference creation, changes and deletion after invoice approval", async () => {
    const invoice = await createDocument("invoice");
    const deliveryNote = await createDocument("delivery_note");
    await approveDocument(deliveryNote.id, actor);
    const reference = await linkDeliveryNote(invoice.id, deliveryNote.id);
    await approveDocument(invoice.id, actor);

    await expect(
      addReference(
        invoice.id,
        {
          referenceType: "delivery_note",
          referenceNumber: `DL-${TAG}-EXTRA`,
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updateReference(
        invoice.id,
        reference.id,
        { matchConfirmed: false },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      deleteReference(invoice.id, reference.id, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("serializes a racing approval and reference creation", async () => {
    const invoice = await createDocument("invoice");
    await setDocumentDeliveryNoteResolution(
      invoice.id,
      {
        resolution: "not_required",
        reason: "Test souběhu bez dodacího listu",
      },
      actor,
    );

    const results = await Promise.allSettled([
      approveDocument(invoice.id, actor),
      addReference(
        invoice.id,
        {
          referenceType: "delivery_note",
          referenceNumber: `DL-${TAG}-RACE`,
        },
        actor,
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );

    const detail = await getDocument(invoice.id);
    if (detail?.document.status === "approved") {
      expect(detail.references).toHaveLength(0);
    } else {
      expect(detail?.document.status).toBe("needs_review");
      expect(detail?.references).toHaveLength(1);
    }
  });

  it("filters the two review queues by document type", async () => {
    const invoice = await createDocument("invoice");
    const deliveryNote = await createDocument("delivery_note");

    const invoices = await listDocuments({
      status: "needs_review",
      docType: "invoice",
    });
    const deliveryNotes = await listDocuments({
      status: "needs_review",
      docType: "delivery_note",
    });

    expect(invoices.map((document) => document.id)).toContain(invoice.id);
    expect(invoices.map((document) => document.id)).not.toContain(
      deliveryNote.id,
    );
    expect(deliveryNotes.map((document) => document.id)).toContain(
      deliveryNote.id,
    );
    expect(deliveryNotes.map((document) => document.id)).not.toContain(
      invoice.id,
    );
  });
});

describe("delivery-note exception permission", () => {
  function runPermissionCheck(permissions: string[]) {
    const request = {
      path: "/billing/documents/123/delivery-note-resolution",
      method: "POST",
      auth: { role: "admin", accountType: "internal", permissions },
    };
    const response = {
      status: vi.fn(),
      json: vi.fn(),
    };
    response.status.mockReturnValue(response);
    response.json.mockReturnValue(response);
    const next = vi.fn();

    enforceApiPermission(request as never, response as never, next);
    return { response, next };
  }

  it("requires billing.approve in addition to module visibility", () => {
    const denied = runPermissionCheck(["billing.view", "billing.manage"]);
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.response.status).toHaveBeenCalledWith(403);
    expect(denied.response.json).toHaveBeenCalledWith({
      error: "Forbidden",
      requiredPermission: "billing.approve",
    });

    const allowed = runPermissionCheck(["billing.view", "billing.approve"]);
    expect(allowed.response.status).not.toHaveBeenCalled();
    expect(allowed.next).toHaveBeenCalledOnce();
  });
});
