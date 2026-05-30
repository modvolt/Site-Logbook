import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  deviceCredentialsTable,
  customersTable,
  customerSitesTable,
} from "@workspace/db";
import {
  ListDeviceCredentialsParams,
  CreateDeviceCredentialParams,
  CreateDeviceCredentialBody,
  UpdateDeviceCredentialParams,
  UpdateDeviceCredentialBody,
  DeleteDeviceCredentialParams,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

// Device credentials are a sensitive credential vault (plaintext passwords).
// Restrict all access to elevated roles; guests/read-only users must not read them.
router.use(requireRole("master", "admin"));

function serializeCredential(c: typeof deviceCredentialsTable.$inferSelect) {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Returns true if the given site exists and belongs to the customer. */
async function siteBelongsToCustomer(
  siteId: number,
  customerId: number,
): Promise<boolean> {
  const [site] = await db
    .select({ id: customerSitesTable.id })
    .from(customerSitesTable)
    .where(
      and(
        eq(customerSitesTable.id, siteId),
        eq(customerSitesTable.customerId, customerId),
      ),
    );
  return !!site;
}

router.get(
  "/customers/:customerId/device-credentials",
  async (req, res): Promise<void> => {
    const params = ListDeviceCredentialsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const credentials = await db
      .select()
      .from(deviceCredentialsTable)
      .where(eq(deviceCredentialsTable.customerId, params.data.customerId))
      .orderBy(deviceCredentialsTable.id);
    res.json(credentials.map(serializeCredential));
  },
);

router.post(
  "/customers/:customerId/device-credentials",
  async (req, res): Promise<void> => {
    const params = CreateDeviceCredentialParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = CreateDeviceCredentialBody.safeParse(req.body);
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

    if (
      parsed.data.siteId != null &&
      !(await siteBelongsToCustomer(parsed.data.siteId, params.data.customerId))
    ) {
      res.status(400).json({ error: "Site does not belong to this customer" });
      return;
    }

    const [credential] = await db
      .insert(deviceCredentialsTable)
      .values({ ...parsed.data, customerId: params.data.customerId })
      .returning();
    res.status(201).json(serializeCredential(credential));
  },
);

router.patch("/device-credentials/:id", async (req, res): Promise<void> => {
  const params = UpdateDeviceCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = UpdateDeviceCredentialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [existing] = await db
    .select({ customerId: deviceCredentialsTable.customerId })
    .from(deviceCredentialsTable)
    .where(eq(deviceCredentialsTable.id, params.data.id));

  if (!existing) {
    res.status(404).json({ error: "Device credential not found" });
    return;
  }

  if (
    parsed.data.siteId != null &&
    !(await siteBelongsToCustomer(parsed.data.siteId, existing.customerId))
  ) {
    res.status(400).json({ error: "Site does not belong to this customer" });
    return;
  }

  const [credential] = await db
    .update(deviceCredentialsTable)
    .set(parsed.data)
    .where(eq(deviceCredentialsTable.id, params.data.id))
    .returning();

  res.json(serializeCredential(credential));
});

router.delete("/device-credentials/:id", async (req, res): Promise<void> => {
  const params = DeleteDeviceCredentialParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [credential] = await db
    .delete(deviceCredentialsTable)
    .where(eq(deviceCredentialsTable.id, params.data.id))
    .returning();

  if (!credential) {
    res.status(404).json({ error: "Device credential not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
