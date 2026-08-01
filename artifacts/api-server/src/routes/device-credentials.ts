import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  deviceCredentialsTable,
  customersTable,
  customerSitesTable,
  auditLogTable,
} from "@workspace/db";
import {
  ListDeviceCredentialsParams,
  CreateDeviceCredentialParams,
  CreateDeviceCredentialBody,
  UpdateDeviceCredentialParams,
  UpdateDeviceCredentialBody,
  DeleteDeviceCredentialParams,
  AuditCredentialAccessParams,
  AuditCredentialAccessBody,
  AuditCredentialExportParams,
} from "@workspace/api-zod";
import { requireVaultStepUp } from "../middlewares/auth";
import { requirePermission } from "../middlewares/permissions";
import {
  clearedLegacyDeviceSecrets,
  decryptDeviceCredentialPayload,
  encryptDeviceCredentialPayload,
  hydrateDeviceCredential,
  type DeviceCredentialSecretPayload,
} from "../lib/device-credential-secrets";

const router: IRouter = Router();

// Customer permissions control access to the parent entity; credentials.* is
// always required in addition because this is a plaintext credential vault.
const requireVaultView = requirePermission("credentials.view");
const requireVaultManage = requirePermission("credentials.manage");

function serializeCredential(c: typeof deviceCredentialsTable.$inferSelect) {
  const {
    secretCiphertext: _secretCiphertext,
    secretKeyId: _secretKeyId,
    secretEncryptedAt: _secretEncryptedAt,
    ...credential
  } = hydrateDeviceCredential(c);
  return {
    ...credential,
    createdAt: c.createdAt.toISOString(),
  };
}

function secretPayloadFromInput(
  input: Partial<DeviceCredentialSecretPayload>,
  fallback?: DeviceCredentialSecretPayload,
): DeviceCredentialSecretPayload {
  return {
    ipAddress: input.ipAddress !== undefined ? input.ipAddress : fallback?.ipAddress ?? null,
    pin: input.pin !== undefined ? input.pin : fallback?.pin ?? null,
    username: input.username !== undefined ? input.username : fallback?.username ?? null,
    password: input.password !== undefined ? input.password : fallback?.password ?? null,
    email: input.email !== undefined ? input.email : fallback?.email ?? null,
    note: input.note !== undefined ? input.note : fallback?.note ?? null,
    users: input.users !== undefined ? input.users : fallback?.users ?? [],
    networkTopology:
      input.networkTopology !== undefined
        ? input.networkTopology
        : fallback?.networkTopology ?? [],
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
  requireVaultView,
  requireVaultStepUp,
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
  requireVaultManage,
  requireVaultStepUp,
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

    const credential = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(deviceCredentialsTable)
        .values({
          customerId: params.data.customerId,
          siteId: parsed.data.siteId ?? null,
          type: parsed.data.type ?? null,
          serialNumber: parsed.data.serialNumber ?? null,
          ...clearedLegacyDeviceSecrets,
        })
        .returning();
      const encrypted = encryptDeviceCredentialPayload(
        inserted.id,
        secretPayloadFromInput(parsed.data),
      );
      const [updated] = await tx
        .update(deviceCredentialsTable)
        .set(encrypted)
        .where(eq(deviceCredentialsTable.id, inserted.id))
        .returning();
      return updated;
    });
    res.status(201).json(serializeCredential(credential));
  },
);

router.patch("/device-credentials/:id", requireVaultManage, requireVaultStepUp, async (req, res): Promise<void> => {
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
    .select()
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

  const currentSecrets = decryptDeviceCredentialPayload(existing);
  const encrypted = encryptDeviceCredentialPayload(
    existing.id,
    secretPayloadFromInput(parsed.data, currentSecrets),
  );

  const [credential] = await db
    .update(deviceCredentialsTable)
    .set({
      ...(parsed.data.siteId !== undefined ? { siteId: parsed.data.siteId } : {}),
      ...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
      ...(parsed.data.serialNumber !== undefined
        ? { serialNumber: parsed.data.serialNumber }
        : {}),
      ...clearedLegacyDeviceSecrets,
      ...encrypted,
    })
    .where(eq(deviceCredentialsTable.id, params.data.id))
    .returning();

  res.json(serializeCredential(credential));
});

router.delete("/device-credentials/:id", requireVaultManage, requireVaultStepUp, async (req, res): Promise<void> => {
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

// Audit event for the customer credential export/handover PDF page being opened.
router.post(
  "/customers/:customerId/device-credentials/audit-export",
  requireVaultView,
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const params = AuditCredentialExportParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [customer] = await db
      .select({ id: customersTable.id, companyName: customersTable.companyName })
      .from(customersTable)
      .where(eq(customersTable.id, params.data.customerId));

    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }

    const auth = req.auth;
    await db.insert(auditLogTable).values({
      actorUserId: auth?.userId ?? null,
      actorName: auth?.name ?? auth?.username ?? null,
      action: "security",
      entityType: "device-credentials",
      entityId: customer.id,
      summary: `Export přístupových údajů — ${customer.companyName} (zákazník #${customer.id})`,
      method: "POST",
      path: req.path,
    });

    res.sendStatus(204);
  },
);

const FIELD_LABELS: Record<string, string> = {
  pin: "PIN",
  password: "heslo",
  card: "kartu",
  username: "uživatelské jméno",
};

// Security audit endpoint — records view/copy events without the secret value.
// Excluded from the generic auditMutations middleware via SKIP_SUFFIXES.
router.post(
  "/device-credentials/:id/audit-access",
  requireVaultView,
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const params = AuditCredentialAccessParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const parsed = AuditCredentialAccessBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    const [cred] = await db
      .select({
        id: deviceCredentialsTable.id,
        customerId: deviceCredentialsTable.customerId,
        type: deviceCredentialsTable.type,
      })
      .from(deviceCredentialsTable)
      .where(eq(deviceCredentialsTable.id, params.data.id));

    if (!cred) {
      res.status(404).json({ error: "Device credential not found" });
      return;
    }

    const actionLabel = parsed.data.action === "copy" ? "Zkopírování" : "Zobrazení";
    const fieldLabel = FIELD_LABELS[parsed.data.field] ?? parsed.data.field;
    const deviceLabel = cred.type || "zařízení";
    const summary = `${actionLabel}: ${fieldLabel} — ${deviceLabel} (zákazník #${cred.customerId})`;

    const auth = req.auth;
    await db.insert(auditLogTable).values({
      actorUserId: auth?.userId ?? null,
      actorName: auth?.name ?? auth?.username ?? null,
      action: "security",
      entityType: "device-credentials",
      entityId: cred.id,
      summary,
      method: "POST",
      path: req.path,
    });

    res.sendStatus(204);
  },
);

export default router;
