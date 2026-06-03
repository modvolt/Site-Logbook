import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, customerSitesTable, customersTable } from "@workspace/db";
import {
  CreateCustomerSiteBody,
  CreateCustomerSiteParams,
  ListCustomerSitesParams,
  GetCustomerSiteParams,
  UpdateCustomerSiteBody,
  UpdateCustomerSiteParams,
  DeleteCustomerSiteParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeSite(s: typeof customerSitesTable.$inferSelect) {
  return {
    ...s,
    createdAt: s.createdAt.toISOString(),
  };
}

router.get("/customers/:customerId/sites", async (req, res): Promise<void> => {
  const params = ListCustomerSitesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const sites = await db
    .select()
    .from(customerSitesTable)
    .where(eq(customerSitesTable.customerId, params.data.customerId))
    .orderBy(customerSitesTable.name);
  res.json(sites.map(serializeSite));
});

router.post("/customers/:customerId/sites", async (req, res): Promise<void> => {
  const params = CreateCustomerSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = CreateCustomerSiteBody.safeParse(req.body);
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

  const [site] = await db
    .insert(customerSitesTable)
    .values({ ...parsed.data, customerId: params.data.customerId })
    .returning();
  res.status(201).json(serializeSite(site));
});

router.get("/customer-sites/:id", async (req, res): Promise<void> => {
  const params = GetCustomerSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [site] = await db
    .select()
    .from(customerSitesTable)
    .where(eq(customerSitesTable.id, params.data.id));

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  res.json(serializeSite(site));
});

router.patch("/customer-sites/:id", async (req, res): Promise<void> => {
  const params = UpdateCustomerSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateCustomerSiteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [site] = await db
    .update(customerSitesTable)
    .set(parsed.data)
    .where(eq(customerSitesTable.id, params.data.id))
    .returning();

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  res.json(serializeSite(site));
});

router.delete("/customer-sites/:id", async (req, res): Promise<void> => {
  const params = DeleteCustomerSiteParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [site] = await db
    .delete(customerSitesTable)
    .where(eq(customerSitesTable.id, params.data.id))
    .returning();

  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
