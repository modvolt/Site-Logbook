import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, customerContactsTable, customersTable } from "@workspace/db";
import {
  CreateCustomerContactBody,
  CreateCustomerContactParams,
  ListCustomerContactsParams,
  UpdateCustomerContactBody,
  UpdateCustomerContactParams,
  DeleteCustomerContactParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeContact(c: typeof customerContactsTable.$inferSelect) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/customers/:customerId/contacts", async (req, res): Promise<void> => {
  const params = ListCustomerContactsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const contacts = await db
    .select()
    .from(customerContactsTable)
    .where(eq(customerContactsTable.customerId, params.data.customerId))
    .orderBy(customerContactsTable.id);
  res.json(contacts.map(serializeContact));
});

router.post("/customers/:customerId/contacts", async (req, res): Promise<void> => {
  const params = CreateCustomerContactParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CreateCustomerContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [customer] = await db
    .select({ id: customersTable.id })
    .from(customersTable)
    .where(eq(customersTable.id, params.data.customerId));
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  const [contact] = await db
    .insert(customerContactsTable)
    .values({ ...parsed.data, customerId: params.data.customerId })
    .returning();
  res.status(201).json(serializeContact(contact));
});

router.patch("/customer-contacts/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerContactParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCustomerContactBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [contact] = await db
    .update(customerContactsTable)
    .set(parsed.data)
    .where(eq(customerContactsTable.id, params.data.id))
    .returning();

  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  res.json(serializeContact(contact));
});

router.delete("/customer-contacts/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerContactParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [contact] = await db
    .delete(customerContactsTable)
    .where(eq(customerContactsTable.id, params.data.id))
    .returning();

  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
