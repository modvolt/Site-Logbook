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
  UpsertMaterialMarkupRuleBody,
  CreateRecurringTemplateBody,
  UpdateRecurringTemplateBody,
  CreateQuoteJobGroupInvoiceDraftBody,
} from "@workspace/api-zod";
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
  listMaterialMarkupRules,
  upsertMaterialMarkupRule,
  deleteMaterialMarkupRule,
  listUnbilledCustomers,
  getUnbilledCustomerDetail,
  listInvoices,
  getInvoiceDetail,
  createDraft,
  createQuoteJobGroupInvoiceDraft,
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
import { getWorkFinancialSummary } from "../lib/work-financial-service";
import { db, auditLogTable } from "@workspace/db";
import { z } from "zod/v4";
import {
  listRecurringTemplates,
  getRecurringTemplateDetail,
  createRecurringTemplate,
  updateRecurringTemplate,
  deleteRecurringTemplate,
  runRecurringGeneration,
  generateTemplateNow,
} from "../lib/recurring-templates";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    typeof (err as Partial<AppError>).statusCode === "number"
  );
}

function handleError(
  err: unknown,
  fallback: string,
  res: import("express").Response,
): void {
  if (isAppError(err)) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  res
    .status(500)
    .json({ error: err instanceof Error ? err.message : fallback });
}

function actorOf(req: import("express").Request): Actor {
  // The global permission middleware guarantees req.auth is present.
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

const WorkFinancialQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  personId: z.coerce.number().int().positive().optional(),
  jobId: z.coerce.number().int().positive().optional(),
  activityId: z.coerce.number().int().positive().optional(),
  billingStatus: z
    .enum(["unbilled", "ready", "billed", "non_billable"])
    .optional(),
});

router.get(
  "/billing/work-financial-summary",
  async (req, res): Promise<void> => {
    const parsed = WorkFinancialQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Neplatný filtr finančního přehledu" });
      return;
    }
    const summary = await getWorkFinancialSummary(parsed.data);
    const canViewCost = req.auth!.permissions.includes("rates.cost.view");
    const filter = <
      T extends {
        cost: number;
        sale: number;
        margin: number;
        marginPercent: number | null;
      },
    >(
      row: T,
    ) => ({
      ...row,
      cost: canViewCost ? row.cost : null,
      margin: canViewCost ? row.margin : null,
      marginPercent: canViewCost ? row.marginPercent : null,
    });
    await db.insert(auditLogTable).values({
      actorUserId: req.auth!.userId,
      actorName: req.auth!.name,
      action: "view",
      entityType: "work_financial_summary",
      summary: `Zobrazení finančního přehledu práce (${canViewCost ? "včetně nákladů" : "bez nákladů"})`,
      method: "GET",
      path: "/billing/work-financial-summary",
    });
    res.json({
      ...filter(summary),
      byBillingStatus: summary.byBillingStatus.map(filter),
      byPerson: summary.byPerson.map(filter),
    });
  },
);

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
      // materialMarkupPercent non-nullable: null = "leave unchanged".
      materialMarkupPercent: d.materialMarkupPercent ?? undefined,
      // marginAlertThresholdPercent non-nullable: null = "leave unchanged".
      marginAlertThresholdPercent: d.marginAlertThresholdPercent ?? undefined,
      // reminderEnabled non-nullable: null = "leave unchanged".
      reminderEnabled: d.reminderEnabled ?? undefined,
      // reminderDays nullable on input but normalized to a default if cleared.
      reminderDays: d.reminderDays ?? undefined,
      quoteNumberPrefix: d.quoteNumberPrefix ?? undefined,
      quoteNumberNextSeq: d.quoteNumberNextSeq ?? undefined,
    });
    res.json(serializeSettings(row));
  } catch (err) {
    handleError(err, "Uložení nastavení fakturace selhalo.", res);
  }
});

// ---------------------------------------------------------------------------
// Per-category material markup rules
// ---------------------------------------------------------------------------

router.get(
  "/billing/material-markup-rules",
  async (_req, res): Promise<void> => {
    res.json({ rules: await listMaterialMarkupRules() });
  },
);

router.put(
  "/billing/material-markup-rules",
  async (req, res): Promise<void> => {
    const parsed = UpsertMaterialMarkupRuleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const rule = await upsertMaterialMarkupRule({
        category: parsed.data.category,
        markupPercent: parsed.data.markupPercent,
      });
      res.json(rule);
    } catch (err) {
      handleError(err, "Uložení přirážky kategorie selhalo.", res);
    }
  },
);

router.delete(
  "/billing/material-markup-rules/:id",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Neplatné ID pravidla." });
      return;
    }
    try {
      const ok = await deleteMaterialMarkupRule(id);
      if (!ok) {
        res.status(404).json({ error: "Pravidlo nenalezeno." });
        return;
      }
      res.status(204).end();
    } catch (err) {
      handleError(err, "Smazání přirážky kategorie selhalo.", res);
    }
  },
);

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
        customerId != null && Number.isFinite(customerId)
          ? customerId
          : undefined,
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
    activityIds: d.activityIds ?? undefined,
    labourBillingMode: d.labourBillingMode ?? undefined,
    workGrouping: d.workGrouping ?? undefined,
    billFineJobIds: d.billFineJobIds ?? undefined,
    materialMarkupPercent: d.materialMarkupPercent ?? undefined,
    materialMarkupOverrides: d.materialMarkupOverrides ?? undefined,
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

router.post(
  "/billing/job-groups/:id/invoice-draft",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Neplatné ID akce zakázek." });
      return;
    }
    const parsed = CreateQuoteJobGroupInvoiceDraftBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const created = await createQuoteJobGroupInvoiceDraft(
        id,
        {
          extraJobIds: parsed.data.extraJobIds ?? undefined,
          labourBillingMode: parsed.data.labourBillingMode ?? undefined,
          workGrouping: parsed.data.workGrouping ?? undefined,
          billFineJobIds: parsed.data.billFineJobIds ?? undefined,
          materialMarkupPercent: parsed.data.materialMarkupPercent ?? undefined,
          materialMarkupOverrides:
            parsed.data.materialMarkupOverrides ?? undefined,
          issueDate: parsed.data.issueDate ?? undefined,
          taxableSupplyDate: parsed.data.taxableSupplyDate ?? undefined,
          dueDate: parsed.data.dueDate ?? undefined,
          paymentMethod: parsed.data.paymentMethod ?? undefined,
          vatModeDefault: parsed.data.vatModeDefault ?? undefined,
          notes: parsed.data.notes ?? undefined,
        },
        actorOf(req),
      );
      res.status(201).json(created);
    } catch (err) {
      handleError(err, "Vytvoření konceptu faktury z akce selhalo.", res);
    }
  },
);

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
    await deleteDraft(id, actorOf(req));
    res.status(204).end();
  } catch (err) {
    handleError(err, "Smazání konceptu faktury selhalo.", res);
  }
});

router.post(
  "/billing/invoices/:id/recalculate",
  async (req, res): Promise<void> => {
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
  },
);

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
      await cancelInvoice(
        id,
        parsed.data.returnJobsToDone ?? false,
        actorOf(req),
      ),
    );
  } catch (err) {
    handleError(err, "Storno faktury selhalo.", res);
  }
});

router.patch(
  "/billing/invoices/:id/status",
  async (req, res): Promise<void> => {
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
  },
);

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
      res.json(await confirmBankPayments(parsed.data.payments, actorOf(req)));
    } catch (err) {
      handleError(err, "Označení faktur jako zaplacené selhalo.", res);
    }
  },
);

router.post(
  "/billing/invoices/:id/send-email",
  async (req, res): Promise<void> => {
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
      res
        .status(400)
        .json({ error: "Chybí platná e-mailová adresa příjemce." });
      return;
    }
    const number = invoice.invoiceNumber ?? `#${id}`;
    const subject = (parsed.data.subject ?? "").trim() || `Faktura ${number}`;
    const message =
      (parsed.data.message ?? "").trim() ||
      `Dobrý den,\n\nv příloze zasíláme fakturu ${number}.\n\nS pozdravem`;
    try {
      const buffer = await objectStorage.getPrivateObjectBuffer(
        invoice.pdfObjectPath,
      );
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
        res
          .status(404)
          .json({ error: "PDF faktury nebylo nalezeno v úložišti." });
        return;
      }
      req.log.error({ err, invoiceId: id }, "Invoice email failed");
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : "Odeslání faktury e-mailem selhalo.",
      });
    }
  },
);

router.post(
  "/billing/invoices/:id/reminder",
  async (req, res): Promise<void> => {
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
  },
);

router.get(
  "/billing/invoices/:id/reminder-preview",
  async (req, res): Promise<void> => {
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
  },
);

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
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="faktura-${number}.pdf"`,
  );
  try {
    await objectStorage.servePrivateObject(invoice.pdfObjectPath, res);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res
        .status(404)
        .json({ error: "PDF faktury nebylo nalezeno v úložišti." });
      return;
    }
    req.log.error({ err, invoiceId: id }, "Invoice PDF download failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Stažení PDF faktury selhalo." });
    }
  }
});

// ---------------------------------------------------------------------------
// Recurring invoice templates (paušální faktury)
// ---------------------------------------------------------------------------

router.get("/billing/recurring-templates", async (_req, res): Promise<void> => {
  res.json(await listRecurringTemplates());
});

router.post("/billing/recurring-templates", async (req, res): Promise<void> => {
  const parsed = CreateRecurringTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const template = await createRecurringTemplate({
      customerId: d.customerId,
      name: d.name,
      items: d.items.map((item) => ({
        ...item,
        unit: item.unit ?? null,
        vatRate: item.vatRate ?? null,
        discountPercent: item.discountPercent ?? null,
      })),
      interval: d.interval,
      dayOfMonth: d.dayOfMonth,
      nextGenerationDate: d.nextGenerationDate,
      isActive: d.isActive ?? true,
      notes: d.notes ?? null,
      vatModeDefault: d.vatModeDefault ?? "standard",
    });
    res.status(201).json(template);
  } catch (err) {
    handleError(err, "Vytvoření šablony selhalo.", res);
  }
});

router.get(
  "/billing/recurring-templates/:id",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Neplatné ID šablony." });
      return;
    }
    const template = await getRecurringTemplateDetail(id);
    if (!template) {
      res.status(404).json({ error: "Šablona nenalezena." });
      return;
    }
    res.json(template);
  },
);

router.put(
  "/billing/recurring-templates/:id",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Neplatné ID šablony." });
      return;
    }
    const parsed = UpdateRecurringTemplateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const d = parsed.data;
    try {
      const template = await updateRecurringTemplate(id, {
        name: d.name ?? undefined,
        items: d.items
          ? d.items.map((item) => ({
              ...item,
              unit: item.unit ?? null,
              vatRate: item.vatRate ?? null,
              discountPercent: item.discountPercent ?? null,
            }))
          : undefined,
        interval: d.interval ?? undefined,
        dayOfMonth: d.dayOfMonth ?? undefined,
        nextGenerationDate: d.nextGenerationDate ?? undefined,
        isActive: d.isActive ?? undefined,
        notes: d.notes,
        vatModeDefault: d.vatModeDefault ?? undefined,
      });
      res.json(template);
    } catch (err) {
      handleError(err, "Aktualizace šablony selhala.", res);
    }
  },
);

router.delete(
  "/billing/recurring-templates/:id",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Neplatné ID šablony." });
      return;
    }
    try {
      const ok = await deleteRecurringTemplate(id);
      if (!ok) {
        res.status(404).json({ error: "Šablona nenalezena." });
        return;
      }
      res.status(204).end();
    } catch (err) {
      handleError(err, "Smazání šablony selhalo.", res);
    }
  },
);

router.post(
  "/billing/recurring-templates/generate",
  async (req, res): Promise<void> => {
    const today = new Date().toISOString().split("T")[0]!;
    try {
      const result = await runRecurringGeneration(today);
      res.json(result);
    } catch (err) {
      handleError(err, "Ruční generování paušálních faktur selhalo.", res);
    }
  },
);

router.post(
  "/billing/recurring-templates/:id/generate",
  async (req, res): Promise<void> => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Neplatné ID šablony." });
      return;
    }
    try {
      const result = await generateTemplateNow(id);
      res.json(result);
    } catch (err) {
      handleError(err, "Generování konceptu faktury selhalo.", res);
    }
  },
);

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
