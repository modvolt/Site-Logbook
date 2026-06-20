import { Router, type IRouter } from "express";
import {
  UpdateBillingSettingsBody,
  CreateInvoiceBody,
  UpdateInvoiceBody,
  CancelInvoiceBody,
  UpdateInvoiceStatusBody,
  SendInvoiceEmailBody,
  SendInvoiceReminderBody,
  ParseBankStatementBody,
  ConfirmBankPaymentsBody,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { sendEmailWithPdf } from "../lib/email";
import {
  sendInvoiceReminder,
  composeReminder,
  isOverdue,
} from "../lib/invoice-reminders";
import {
  ensureBillingSettings,
  serializeSettings,
  updateBillingSettings,
  getBillingSummary,
  listUnbilledCustomers,
  getUnbilledCustomerDetail,
  listInvoices,
  getInvoiceDetail,
  createDraft,
  updateDraft,
  recalcDraft,
  deleteDraft,
  issueInvoice,
  cancelInvoice,
  updateInvoiceStatus,
  getInvoiceForPdf,
  daysOverdue,
  previewBankStatementMatches,
  confirmBankPayments,
  type AppError,
  type Actor,
  type InvoiceCreateInput,
  type InvoiceUpdateInput,
  type InvoiceLineInput,
} from "../lib/invoice-service";
import type { VatMode } from "../lib/invoice-calc";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// Fakturace is admin-only. Path-scoped so it never leaks to downstream routers.
router.use("/billing", requireRole("admin"));

function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    typeof (err as Partial<AppError>).statusCode === "number"
  );
}

function handleError(err: unknown, fallback: string, res: import("express").Response): void {
  if (isAppError(err)) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : fallback });
}

function actorOf(req: import("express").Request): Actor {
  // requireRole guarantees req.auth is present.
  return { userId: req.auth!.userId, name: req.auth!.name };
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

router.get("/billing/summary", async (_req, res): Promise<void> => {
  res.json(await getBillingSummary());
});

// ---------------------------------------------------------------------------
// Settings (singleton)
// ---------------------------------------------------------------------------

router.get("/billing/settings", async (_req, res): Promise<void> => {
  const row = await ensureBillingSettings();
  res.json(serializeSettings(row));
});

router.put("/billing/settings", async (req, res): Promise<void> => {
  const parsed = UpdateBillingSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const row = await updateBillingSettings({
      // Non-nullable columns: a null clears nothing — treat as "leave unchanged".
      supplierName: d.supplierName ?? undefined,
      defaultDueDays: d.defaultDueDays ?? undefined,
      defaultPaymentMethod: d.defaultPaymentMethod ?? undefined,
      vatPayer: d.vatPayer ?? undefined,
      vatModeDefault: (d.vatModeDefault ?? undefined) as VatMode | undefined,
      numberPrefix: d.numberPrefix ?? undefined,
      numberFormat: d.numberFormat ?? undefined,
      // numberNextSeq is non-nullable: null = "leave unchanged".
      numberNextSeq: d.numberNextSeq ?? undefined,
      // Nullable columns: a null explicitly clears the value.
      numberYear: d.numberYear,
      supplierIc: d.supplierIc,
      supplierDic: d.supplierDic,
      supplierAddress: d.supplierAddress,
      supplierEmail: d.supplierEmail,
      supplierPhone: d.supplierPhone,
      bankAccount: d.bankAccount,
      iban: d.iban,
      bic: d.bic,
      invoiceFooterNote: d.invoiceFooterNote,
      // reminderEnabled non-nullable: null = "leave unchanged".
      reminderEnabled: d.reminderEnabled ?? undefined,
      // reminderDays nullable on input but normalized to a default if cleared.
      reminderDays: d.reminderDays ?? undefined,
    });
    res.json(serializeSettings(row));
  } catch (err) {
    handleError(err, "Uložení nastavení fakturace selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Unbilled (done jobs grouped by customer)
// ---------------------------------------------------------------------------

router.get("/billing/unbilled", async (_req, res): Promise<void> => {
  res.json(await listUnbilledCustomers());
});

router.get("/billing/unbilled/:customerId", async (req, res): Promise<void> => {
  const customerId = parseId(req.params.customerId);
  if (customerId === null) {
    res.status(400).json({ error: "Neplatné ID zákazníka." });
    return;
  }
  try {
    const detail = await getUnbilledCustomerDetail(customerId);
    if (!detail) {
      res.status(404).json({ error: "Zákazník nenalezen." });
      return;
    }
    res.json(detail);
  } catch (err) {
    handleError(err, "Načtení podkladů selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

router.get("/billing/invoices", async (req, res): Promise<void> => {
  const status =
    typeof req.query.status === "string" && req.query.status.length > 0
      ? req.query.status
      : undefined;
  const customerIdRaw = req.query.customerId;
  const customerId =
    typeof customerIdRaw === "string" && customerIdRaw.length > 0
      ? Number(customerIdRaw)
      : undefined;
  res.json(
    await listInvoices({
      status,
      customerId:
        customerId != null && Number.isFinite(customerId) ? customerId : undefined,
    }),
  );
});

router.post("/billing/invoices", async (req, res): Promise<void> => {
  const parsed = CreateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const input: InvoiceCreateInput = {
    customerId: d.customerId,
    jobIds: d.jobIds ?? undefined,
    billFineJobIds: d.billFineJobIds ?? undefined,
    vatModeDefault: d.vatModeDefault ?? undefined,
    issueDate: d.issueDate ?? undefined,
    taxableSupplyDate: d.taxableSupplyDate ?? undefined,
    dueDate: d.dueDate ?? undefined,
    paymentMethod: d.paymentMethod ?? undefined,
    variableSymbol: d.variableSymbol ?? undefined,
    constantSymbol: d.constantSymbol ?? undefined,
    specificSymbol: d.specificSymbol ?? undefined,
    notes: d.notes ?? undefined,
    lines: d.lines?.map(mapLineInput),
  };
  try {
    const created = await createDraft(input, actorOf(req));
    res.status(201).json(created);
  } catch (err) {
    handleError(err, "Vytvoření konceptu faktury selhalo.", res);
  }
});

router.get("/billing/invoices/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const detail = await getInvoiceDetail(id);
  if (!detail) {
    res.status(404).json({ error: "Faktura nenalezena." });
    return;
  }
  res.json(detail);
});

router.patch("/billing/invoices/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const parsed = UpdateInvoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  const input: InvoiceUpdateInput = {
    issueDate: d.issueDate ?? undefined,
    taxableSupplyDate: d.taxableSupplyDate ?? undefined,
    dueDate: d.dueDate ?? undefined,
    paymentMethod: d.paymentMethod ?? undefined,
    variableSymbol: d.variableSymbol ?? undefined,
    constantSymbol: d.constantSymbol ?? undefined,
    specificSymbol: d.specificSymbol ?? undefined,
    vatModeDefault: d.vatModeDefault ?? undefined,
    notes: d.notes ?? undefined,
    lines: d.lines?.map(mapLineInput),
  };
  try {
    const updated = await updateDraft(id, input);
    res.json(updated);
  } catch (err) {
    handleError(err, "Úprava konceptu faktury selhala.", res);
  }
});

router.delete("/billing/invoices/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  try {
    await deleteDraft(id);
    res.status(204).end();
  } catch (err) {
    handleError(err, "Smazání konceptu faktury selhalo.", res);
  }
});

router.post("/billing/invoices/:id/recalculate", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  try {
    res.json(await recalcDraft(id));
  } catch (err) {
    handleError(err, "Přepočet faktury selhal.", res);
  }
});

router.post("/billing/invoices/:id/issue", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  try {
    res.json(await issueInvoice(id, actorOf(req)));
  } catch (err) {
    handleError(err, "Vystavení faktury selhalo.", res);
  }
});

router.post("/billing/invoices/:id/cancel", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const parsed = CancelInvoiceBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await cancelInvoice(id, parsed.data.returnJobsToDone ?? false, actorOf(req)),
    );
  } catch (err) {
    handleError(err, "Storno faktury selhalo.", res);
  }
});

router.patch("/billing/invoices/:id/status", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const parsed = UpdateInvoiceStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await updateInvoiceStatus(id, {
        status: parsed.data.status,
        paidDate: parsed.data.paidDate ?? null,
        paidAmount: parsed.data.paidAmount ?? null,
      }),
    );
  } catch (err) {
    handleError(err, "Změna stavu faktury selhala.", res);
  }
});

// ---------------------------------------------------------------------------
// Bank statement payment matching (Komerční banka GPC / CAMT.053)
// ---------------------------------------------------------------------------

router.post(
  "/billing/bank-statements/parse",
  async (req, res): Promise<void> => {
    const parsed = ParseBankStatementBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(parsed.data.contentBase64, "base64");
    } catch {
      res.status(400).json({ error: "Obsah souboru se nepodařilo dekódovat." });
      return;
    }
    try {
      res.json(await previewBankStatementMatches(buf));
    } catch (err) {
      handleError(err, "Zpracování bankovního výpisu selhalo.", res);
    }
  },
);

router.post(
  "/billing/bank-statements/confirm",
  async (req, res): Promise<void> => {
    const parsed = ConfirmBankPaymentsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      res.json(
        await confirmBankPayments(parsed.data.payments, actorOf(req)),
      );
    } catch (err) {
      handleError(err, "Označení faktur jako zaplacené selhalo.", res);
    }
  },
);

router.post("/billing/invoices/:id/send-email", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const parsed = SendInvoiceEmailBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const invoice = await getInvoiceForPdf(id);
  if (!invoice) {
    res.status(404).json({ error: "Faktura nenalezena." });
    return;
  }
  if (invoice.status === "draft" || !invoice.pdfObjectPath) {
    res.status(409).json({ error: "Fakturu je nutné nejprve vystavit." });
    return;
  }
  const to = (parsed.data.to ?? invoice.customerEmail ?? "").trim();
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to)) {
    res.status(400).json({ error: "Chybí platná e-mailová adresa příjemce." });
    return;
  }
  const number = invoice.invoiceNumber ?? `#${id}`;
  const subject = (parsed.data.subject ?? "").trim() || `Faktura ${number}`;
  const message =
    (parsed.data.message ?? "").trim() ||
    `Dobrý den,\n\nv příloze zasíláme fakturu ${number}.\n\nS pozdravem`;
  try {
    const buffer = await objectStorage.getPrivateObjectBuffer(invoice.pdfObjectPath);
    await sendEmailWithPdf({
      to,
      subject,
      text: message,
      pdfBase64: buffer.toString("base64"),
      filename: `faktura-${number.replace(/[^\w.-]+/g, "-")}.pdf`,
    });
    res.json({ sent: true, to });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "PDF faktury nebylo nalezeno v úložišti." });
      return;
    }
    req.log.error({ err, invoiceId: id }, "Invoice email failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Odeslání faktury e-mailem selhalo.",
    });
  }
});

router.post("/billing/invoices/:id/reminder", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const parsed = SendInvoiceReminderBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await sendInvoiceReminder(
      id,
      {
        to: parsed.data.to ?? null,
        subject: parsed.data.subject ?? null,
        message: parsed.data.message ?? null,
        auto: false,
      },
      actorOf(req),
    );
    res.json(result);
  } catch (err) {
    req.log.error({ err, invoiceId: id }, "Invoice reminder failed");
    handleError(err, "Odeslání upomínky selhalo.", res);
  }
});

router.get("/billing/invoices/:id/reminder-preview", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const invoice = await getInvoiceForPdf(id);
  if (!invoice) {
    res.status(404).json({ error: "Faktura nenalezena." });
    return;
  }
  if (!isOverdue(invoice)) {
    res.status(409).json({ error: "Faktura není po splatnosti." });
    return;
  }
  const days = daysOverdue(invoice.dueDate!);
  const { subject, message } = composeReminder(invoice, days);
  res.json({
    subject,
    message,
    to: invoice.customerEmail ?? null,
    daysOverdue: days,
  });
});

router.get("/billing/invoices/:id/pdf", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Neplatné ID faktury." });
    return;
  }
  const invoice = await getInvoiceForPdf(id);
  if (!invoice || !invoice.pdfObjectPath) {
    res.status(404).json({ error: "PDF faktury není k dispozici." });
    return;
  }
  const number = (invoice.invoiceNumber ?? `${id}`).replace(/[^\w.-]+/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="faktura-${number}.pdf"`);
  try {
    await objectStorage.servePrivateObject(invoice.pdfObjectPath, res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "PDF faktury nebylo nalezeno v úložišti." });
      return;
    }
    req.log.error({ err, invoiceId: id }, "Invoice PDF download failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Stažení PDF faktury selhalo." });
    }
  }
});

function mapLineInput(line: {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unitPriceWithoutVat?: number | null;
  discountPercent?: number | null;
  vatRate?: number | null;
  vatMode?: InvoiceLineInput["vatMode"];
  sourceType?: string | null;
  sourceId?: number | null;
  jobId?: number | null;
  activityId?: number | null;
}): InvoiceLineInput {
  return {
    description: line.description,
    quantity: line.quantity ?? undefined,
    unit: line.unit ?? undefined,
    unitPriceWithoutVat: line.unitPriceWithoutVat ?? undefined,
    discountPercent: line.discountPercent ?? undefined,
    vatRate: line.vatRate ?? undefined,
    vatMode: line.vatMode ?? undefined,
    sourceType: line.sourceType ?? undefined,
    sourceId: line.sourceId ?? undefined,
    jobId: line.jobId ?? undefined,
    activityId: line.activityId ?? undefined,
  };
}

export default router;
