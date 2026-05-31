import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@workspace/db";
import {
  CreateCustomerBody,
  UpdateCustomerBody,
  UpdateCustomerParams,
  DeleteCustomerParams,
  SendCredentialsEmailParams,
  SendCredentialsEmailBody,
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

  res.sendStatus(204);
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

  const to = (parsed.data.to ?? customer.email ?? "").trim();
  if (!to) {
    res.status(400).json({ error: "Zákazník nemá uložený e-mail." });
    return;
  }

  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!emailPattern.test(to)) {
    res.status(400).json({ error: "Neplatná e-mailová adresa příjemce." });
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
      to,
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

  res.json({ sent: true, to });
});

export default router;
