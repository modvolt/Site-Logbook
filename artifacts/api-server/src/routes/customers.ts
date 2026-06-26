import { Router, type IRouter } from "express";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db, customersTable, invoicesTable, auditLogTable } from "@workspace/db";
import {
  CreateCustomerBody,
  UpdateCustomerBody,
  UpdateCustomerParams,
  DeleteCustomerParams,
  GetCustomerFinancialSummaryParams,
  SendCredentialsEmailParams,
  SendCredentialsEmailBody,
  ImportCustomersBody,
} from "@workspace/api-zod";
import { sendEmailWithPdf } from "../lib/email";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

function serializeCustomer(c: typeof customersTable.$inferSelect) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/customers", async (_req, res): Promise<void> => {
  const customers = await db.select().from(customersTable).orderBy(customersTable.companyName);
  res.json(customers.map(serializeCustomer));
});

router.post("/customers", async (req, res): Promise<void> => {
  const parsed = CreateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db.insert(customersTable).values(parsed.data).returning();
  res.status(201).json(serializeCustomer(customer));
});

router.post("/customers/import", async (req, res): Promise<void> => {
  const parsed = ImportCustomersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: customersTable.id,
        ic: customersTable.ic,
        companyName: customersTable.companyName,
      })
      .from(customersTable);
    // Match incoming rows by IČ first (more reliable), then by company name.
    const byIc = new Map<string, number>();
    const byName = new Map<string, number>();
    for (const row of existing) {
      if (row.ic) byIc.set(row.ic.trim().toLowerCase(), row.id);
      if (row.companyName) byName.set(row.companyName.trim().toLowerCase(), row.id);
    }

    for (const raw of parsed.data.items) {
      const companyName = raw.companyName?.trim();
      if (!companyName) {
        skipped++;
        continue;
      }
      const ic = raw.ic?.trim() || null;

      // Only set fields the caller actually provided, so a partial file updates
      // those fields without wiping the rest of a matched customer.
      const provided: Record<string, unknown> = { companyName };
      if (raw.contactPerson !== undefined) provided.contactPerson = raw.contactPerson;
      if (raw.phone !== undefined) provided.phone = raw.phone;
      if (raw.email !== undefined) provided.email = raw.email;
      if (raw.ic !== undefined) provided.ic = ic;
      if (raw.dic !== undefined) provided.dic = raw.dic;
      if (raw.address !== undefined) provided.address = raw.address;

      const icKey = ic?.toLowerCase();
      const nameKey = companyName.toLowerCase();
      const matchId = (icKey ? byIc.get(icKey) : undefined) ?? byName.get(nameKey);

      if (matchId != null) {
        await tx
          .update(customersTable)
          .set(provided)
          .where(eq(customersTable.id, matchId));
        // Refresh the lookup maps so later rows referencing this customer's
        // (possibly changed) IČ or name resolve to the same record instead of
        // being inserted as duplicates.
        if (icKey) byIc.set(icKey, matchId);
        byName.set(nameKey, matchId);
        updated++;
      } else {
        const [row] = await tx
          .insert(customersTable)
          .values(provided as any)
          .returning({ id: customersTable.id });
        if (row) {
          if (icKey) byIc.set(icKey, row.id);
          byName.set(nameKey, row.id);
        }
        created++;
      }
    }
  });

  res.json({ created, updated, skipped });
});

router.patch("/customers/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCustomerBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db
    .update(customersTable)
    .set(parsed.data)
    .where(eq(customersTable.id, params.data.id))
    .returning();

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(serializeCustomer(customer));
});

router.delete("/customers/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [customer] = await db
    .delete(customersTable)
    .where(eq(customersTable.id, params.data.id))
    .returning();

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  await db.insert(auditLogTable).values({
    actorUserId: req.auth?.userId ?? null,
    actorName: req.auth?.name ?? req.auth?.username ?? null,
    action: "delete",
    entityType: "customer",
    entityId: customer.id,
    summary: `Zákazník smazán: ${customer.companyName ?? `#${customer.id}`} (vč. přístupových údajů a dalších dat)`,
    method: "DELETE",
    path: req.path,
  });

  res.sendStatus(204);
});

router.get("/customers/:id/financial-summary", requireRole("admin", "master"), async (req, res): Promise<void> => {
  const params = GetCustomerFinancialSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const { id } = params.data;

  const [row] = await db
    .select({
      openBalance: sql<string>`COALESCE(SUM(CASE WHEN ${invoicesTable.paidDate} IS NULL AND ${invoicesTable.status} != 'cancelled' THEN ${invoicesTable.totalWithVat}::numeric ELSE 0 END), 0)::text`,
      lastPaymentDate: sql<string | null>`MAX(${invoicesTable.paidDate})`,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.customerId, id));

  res.json({
    openBalance: row?.openBalance ?? "0",
    lastPaymentDate: row?.lastPaymentDate ?? null,
  });
});

// Distributes the sensitive credential-vault PDF; restrict to elevated roles
// to match the device-credentials access boundary.
router.post("/customers/:id/send-credentials-email", requireRole("master", "admin"), async (req, res): Promise<void> => {
  const params = SendCredentialsEmailParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = SendCredentialsEmailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db
    .select({ companyName: customersTable.companyName, email: customersTable.email })
    .from(customersTable)
    .where(eq(customersTable.id, params.data.id));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

  // Build the recipient list: use supplied addresses or fall back to the
  // customer's stored email.
  const rawTo = parsed.data.to && parsed.data.to.length > 0
    ? parsed.data.to.map((a) => a.trim()).filter(Boolean)
    : [customer.email?.trim() ?? ""].filter(Boolean);

  if (rawTo.length === 0) {
    res.status(400).json({ error: "Zákazník nemá uložený e-mail." });
    return;
  }

  const invalidAddress = rawTo.find((addr) => !emailPattern.test(addr));
  if (invalidAddress) {
    res.status(400).json({ error: `Neplatná e-mailová adresa příjemce: ${invalidAddress}` });
    return;
  }

  const subject = parsed.data.subject?.trim() || "Přístupové údaje";
  const message =
    parsed.data.message?.trim() ||
    `Dobrý den${customer.companyName ? `, ${customer.companyName}` : ""},\n\n` +
      `v příloze zasíláme přehled přístupových údajů k Vašim zařízením.\n\n` +
      `Tento dokument obsahuje citlivé údaje, uchovávejte jej prosím bezpečně.\n\n` +
      `S pozdravem,\nModvolt s.r.o.`;

  const filename = `pristupove-udaje-${params.data.id}.pdf`;

  try {
    await sendEmailWithPdf({
      to: rawTo,
      subject,
      text: message,
      pdfBase64: parsed.data.pdfBase64,
      filename,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to send credentials email");
    res.status(502).json({ error: err instanceof Error ? err.message : "Odeslání e-mailu selhalo." });
    return;
  }

  res.json({ sent: true, to: rawTo.join(", ") });
});

export default router;
