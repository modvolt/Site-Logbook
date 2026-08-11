import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLogTable, db, invoicesTable } from "@workspace/db";
import {
  cancelInvoice,
  type InvoiceCancellationReasonCode,
  updateInvoiceStatus,
} from "../src/lib/invoice-service";

const TAG = `invoice-status-containment-${Date.now()}`;
const invoiceIds: number[] = [];
const actor = { userId: null, name: "Invoice containment test" };

async function makeInvoice(status: "issued" | "sent" | "paid" = "issued") {
  const [invoice] = await db
    .insert(invoicesTable)
    .values({
      invoiceNumber: `${TAG}-${invoiceIds.length + 1}`,
      status,
      totalWithVat: "1210.00",
      subtotalWithoutVat: "1000.00",
      totalVat: "210.00",
      ...(status === "paid"
        ? { paidDate: "2042-03-04", paidAmount: "1210.00" }
        : {}),
    })
    .returning();
  invoiceIds.push(invoice.id);
  return invoice;
}

afterEach(async () => {
  if (!invoiceIds.length) return;
  await db
    .delete(auditLogTable)
    .where(
      and(
        eq(auditLogTable.entityType, "invoices"),
        inArray(auditLogTable.entityId, invoiceIds),
      ),
    );
  await db.delete(invoicesTable).where(inArray(invoicesTable.id, invoiceIds));
  invoiceIds.length = 0;
});

describe("invoice status containment", () => {
  it("keeps a recorded payment immutable while allowing an exact idempotent replay", async () => {
    const invoice = await makeInvoice();
    const paid = await updateInvoiceStatus(
      invoice.id,
      { status: "paid", paidDate: "2042-03-04", paidAmount: 1210 },
      actor,
    );
    expect(paid?.status).toBe("paid");
    expect(paid?.paidDate).toBe("2042-03-04");
    expect(paid?.paidAmount).toBe(1210);

    await updateInvoiceStatus(
      invoice.id,
      { status: "paid", paidDate: "2042-03-04", paidAmount: 1210 },
      actor,
    );
    await expect(
      updateInvoiceStatus(invoice.id, { status: "sent" }, actor),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      updateInvoiceStatus(
        invoice.id,
        { status: "paid", paidDate: "2042-03-05", paidAmount: 1000 },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("paid");
    expect(stored.paidDate).toBe("2042-03-04");
    expect(Number(stored.paidAmount)).toBe(1210);
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.entityType, "invoices"),
          eq(auditLogTable.entityId, invoice.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].actorName).toBe(actor.name);
    expect(audits[0].summary).toContain("manual_payment_confirmation");
  });

  it("records sent once and rejects payment fields on a sent transition", async () => {
    const invoice = await makeInvoice();
    await updateInvoiceStatus(invoice.id, { status: "sent" }, actor);
    await updateInvoiceStatus(invoice.id, { status: "sent" }, actor);
    await expect(
      updateInvoiceStatus(invoice.id, { status: "sent", paidAmount: 1 }, actor),
    ).rejects.toMatchObject({ statusCode: 400 });
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.entityId, invoice.id));
    expect(audits).toHaveLength(1);
    expect(audits[0].summary).toContain("manual_delivery_confirmation");
  });

  it("rejects invalid payment evidence before changing the invoice", async () => {
    const invoice = await makeInvoice();
    await expect(
      updateInvoiceStatus(
        invoice.id,
        { status: "paid", paidDate: "2042-02-30", paidAmount: 1210 },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateInvoiceStatus(
        invoice.id,
        { status: "paid", paidDate: "2042-02-28", paidAmount: -1 },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("issued");
    expect(stored.paidDate).toBeNull();
    expect(stored.paidAmount).toBeNull();
  });

  it("serializes a paid-versus-sent race so sent cannot erase the payment", async () => {
    const invoice = await makeInvoice();
    try {
      await db.execute(
        sql.raw(`
        create or replace function test_invoice_paid_delay()
        returns trigger language plpgsql as $$
        begin
          if new.status = 'paid' then
            perform pg_sleep(0.20);
          end if;
          return new;
        end;
        $$
      `),
      );
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_paid_delay_trg on invoices",
        ),
      );
      await db.execute(
        sql.raw(`
        create trigger test_invoice_paid_delay_trg
        before update on invoices
        for each row execute function test_invoice_paid_delay()
      `),
      );

      const paid = updateInvoiceStatus(
        invoice.id,
        { status: "paid", paidDate: "2042-03-04", paidAmount: 1210 },
        actor,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const sent = updateInvoiceStatus(invoice.id, { status: "sent" }, actor);
      const results = await Promise.allSettled([paid, sent]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ statusCode: 409 }),
      });
    } finally {
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_paid_delay_trg on invoices",
        ),
      );
      await db.execute(
        sql.raw("drop function if exists test_invoice_paid_delay()"),
      );
    }

    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("paid");
    expect(stored.paidDate).toBe("2042-03-04");
    expect(Number(stored.paidAmount)).toBe(1210);
  });

  it("rolls the status back when the required audit insert fails", async () => {
    const invoice = await makeInvoice();
    try {
      await db.execute(
        sql.raw(`
        create or replace function test_invoice_audit_reject()
        returns trigger language plpgsql as $$
        begin
          if new.path = '/billing/invoices/${invoice.id}/status' then
            raise exception 'test audit rejection';
          end if;
          return new;
        end;
        $$
      `),
      );
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_audit_reject_trg on audit_log",
        ),
      );
      await db.execute(
        sql.raw(`
        create trigger test_invoice_audit_reject_trg
        before insert on audit_log
        for each row execute function test_invoice_audit_reject()
      `),
      );
      await expect(
        updateInvoiceStatus(invoice.id, { status: "sent" }, actor),
      ).rejects.toThrow(/Failed query: insert into "audit_log"/);
    } finally {
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_audit_reject_trg on audit_log",
        ),
      );
      await db.execute(
        sql.raw("drop function if exists test_invoice_audit_reject()"),
      );
    }
    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("issued");
  });

  it("requires a registered cancellation reason and persists it in the atomic audit", async () => {
    const invoice = await makeInvoice();
    await expect(
      cancelInvoice(
        invoice.id,
        {
          returnJobsToDone: false,
          reasonCode: "not_registered" as InvoiceCancellationReasonCode,
        },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });

    const cancelled = await cancelInvoice(
      invoice.id,
      { returnJobsToDone: false, reasonCode: "customer_complaint" },
      actor,
    );
    expect(cancelled?.status).toBe("cancelled");
    const audits = await db
      .select()
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.entityType, "invoices"),
          eq(auditLogTable.entityId, invoice.id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].actorName).toBe(actor.name);
    expect(audits[0].summary).toContain("důvod: customer_complaint");
  });

  it("refuses direct cancellation whenever payment evidence exists", async () => {
    const invoice = await makeInvoice("paid");
    await expect(
      cancelInvoice(
        invoice.id,
        { returnJobsToDone: false, reasonCode: "billing_error" },
        actor,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("paid");
    expect(stored.paidDate).toBe("2042-03-04");
    expect(Number(stored.paidAmount)).toBe(1210);
  });

  it("serializes payment against cancellation so cancellation cannot hide the payment", async () => {
    const invoice = await makeInvoice();
    try {
      await db.execute(
        sql.raw(`
        create or replace function test_invoice_cancel_paid_delay()
        returns trigger language plpgsql as $$
        begin
          if new.status = 'paid' then
            perform pg_sleep(0.20);
          end if;
          return new;
        end;
        $$
      `),
      );
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_cancel_paid_delay_trg on invoices",
        ),
      );
      await db.execute(
        sql.raw(`
        create trigger test_invoice_cancel_paid_delay_trg
        before update on invoices
        for each row execute function test_invoice_cancel_paid_delay()
      `),
      );

      const paid = updateInvoiceStatus(
        invoice.id,
        { status: "paid", paidDate: "2042-03-04", paidAmount: 1210 },
        actor,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const cancelled = cancelInvoice(
        invoice.id,
        { returnJobsToDone: false, reasonCode: "customer_complaint" },
        actor,
      );
      const results = await Promise.allSettled([paid, cancelled]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ statusCode: 409 }),
      });
    } finally {
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_cancel_paid_delay_trg on invoices",
        ),
      );
      await db.execute(
        sql.raw("drop function if exists test_invoice_cancel_paid_delay()"),
      );
    }

    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("paid");
    expect(stored.paidDate).toBe("2042-03-04");
  });

  it("rolls cancellation back when the required audit insert fails", async () => {
    const invoice = await makeInvoice();
    try {
      await db.execute(
        sql.raw(`
        create or replace function test_invoice_cancel_audit_reject()
        returns trigger language plpgsql as $$
        begin
          if new.path = '/billing/invoices/${invoice.id}/cancel' then
            raise exception 'test cancellation audit rejection';
          end if;
          return new;
        end;
        $$
      `),
      );
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_cancel_audit_reject_trg on audit_log",
        ),
      );
      await db.execute(
        sql.raw(`
        create trigger test_invoice_cancel_audit_reject_trg
        before insert on audit_log
        for each row execute function test_invoice_cancel_audit_reject()
      `),
      );
      await expect(
        cancelInvoice(
          invoice.id,
          { returnJobsToDone: false, reasonCode: "billing_error" },
          actor,
        ),
      ).rejects.toThrow(/Failed query: insert into "audit_log"/);
    } finally {
      await db.execute(
        sql.raw(
          "drop trigger if exists test_invoice_cancel_audit_reject_trg on audit_log",
        ),
      );
      await db.execute(
        sql.raw("drop function if exists test_invoice_cancel_audit_reject()"),
      );
    }
    const [stored] = await db
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoice.id));
    expect(stored.status).toBe("issued");
  });
});
