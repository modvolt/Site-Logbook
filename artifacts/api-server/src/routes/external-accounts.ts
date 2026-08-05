import bcrypt from "bcryptjs";
import { Router, type IRouter, type Response } from "express";
import { z } from "zod/v4";
import { requireVaultStepUp } from "../middlewares/auth";
import { requirePermission } from "../middlewares/permissions";
import {
  activateExternalAccount,
  createExternalAccountDraft,
  ExternalAccountServiceError,
  getExternalAccountDetail,
  listExternalAccounts,
  replaceExternalAccountScopes,
  revokeExternalAccount,
  transferExternalAccountCustodian,
  updateExternalAccountExpiry,
} from "../lib/external-account-service";
import { UserOffboardingError } from "../lib/user-offboarding-service";

const router: IRouter = Router();

const positiveInteger = z.coerce.number().int().positive();
const futureDateTime = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date-time");
const mutationHeader = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/);
const versionBody = z.strictObject({ expectedVersion: positiveInteger });
const scopeSchema = z.discriminatedUnion("resourceType", [
  z.strictObject({
    resourceType: z.literal("job"),
    resourceId: positiveInteger,
    capability: z.literal("read"),
  }),
  z.strictObject({
    resourceType: z.literal("quote"),
    resourceId: positiveInteger,
    capability: z.literal("read"),
  }),
  z.strictObject({
    resourceType: z.literal("switchboard"),
    resourceId: positiveInteger,
    capability: z.literal("read"),
  }),
]);

function requireIdempotencyKey(value: string | undefined): boolean {
  return mutationHeader.safeParse(value).success;
}

function sendServiceError(res: Response, error: unknown): boolean {
  if (error instanceof ExternalAccountServiceError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof UserOffboardingError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

router.use("/external-accounts", requirePermission("users.manage"));

router.get("/external-accounts", async (req, res): Promise<void> => {
  const query = z
    .strictObject({
      status: z
        .enum(["draft", "active", "suspended", "revoked", "expired", "all"])
        .optional(),
      custodianUserId: positiveInteger.optional(),
      beforeId: positiveInteger.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .safeParse(req.query);
  if (!query.success) {
    res
      .status(400)
      .json({
        error: query.error.message,
        code: "invalid_external_account_query",
      });
    return;
  }
  try {
    res.json(
      await listExternalAccounts({
        actorUserId: req.auth!.userId,
        ...query.data,
      }),
    );
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
});

router.get("/external-accounts/:id", async (req, res): Promise<void> => {
  const id = positiveInteger.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "External account not found" });
    return;
  }
  try {
    res.json(
      await getExternalAccountDetail({
        actorUserId: req.auth!.userId,
        externalUserId: id.data,
      }),
    );
  } catch (error) {
    if (!sendServiceError(res, error)) throw error;
  }
});

router.post(
  "/external-accounts",
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    if (!requireIdempotencyKey(req.get("Idempotency-Key"))) {
      res
        .status(400)
        .json({
          error: "Valid Idempotency-Key is required",
          code: "idempotency_key_required",
        });
      return;
    }
    const body = z
      .strictObject({
        username: z.string().trim().min(3).max(80),
        password: z.string().min(12).max(200),
        name: z.string().trim().min(1).max(160),
        email: z.string().email().nullable().optional(),
        custodianUserId: positiveInteger,
        accessExpiresAt: futureDateTime,
      })
      .safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json({
          error: body.error.message,
          code: "invalid_external_account_input",
        });
      return;
    }
    try {
      const passwordHash = await bcrypt.hash(body.data.password, 12);
      res.status(201).json(
        await createExternalAccountDraft({
          actorUserId: req.auth!.userId,
          username: body.data.username,
          passwordHash,
          name: body.data.name,
          email: body.data.email,
          custodianUserId: body.data.custodianUserId,
          accessExpiresAt: new Date(body.data.accessExpiresAt),
        }),
      );
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  },
);

router.put(
  "/external-accounts/:id/scopes",
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const id = positiveInteger.safeParse(req.params.id);
    const body = z
      .strictObject({
        expectedVersion: positiveInteger,
        scopes: z.array(scopeSchema).max(200),
      })
      .safeParse(req.body);
    if (
      !id.success ||
      !body.success ||
      !requireIdempotencyKey(req.get("Idempotency-Key"))
    ) {
      res
        .status(400)
        .json({
          error: "Invalid scope replacement request",
          code: "invalid_external_account_input",
        });
      return;
    }
    try {
      res.json(
        await replaceExternalAccountScopes({
          actorUserId: req.auth!.userId,
          externalUserId: id.data,
          ...body.data,
        }),
      );
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  },
);

router.patch(
  "/external-accounts/:id/expiry",
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const id = positiveInteger.safeParse(req.params.id);
    const body = z
      .strictObject({
        expectedVersion: positiveInteger,
        accessExpiresAt: futureDateTime,
      })
      .safeParse(req.body);
    if (
      !id.success ||
      !body.success ||
      !requireIdempotencyKey(req.get("Idempotency-Key"))
    ) {
      res
        .status(400)
        .json({
          error: "Invalid expiry request",
          code: "invalid_external_account_input",
        });
      return;
    }
    try {
      res.json(
        await updateExternalAccountExpiry({
          actorUserId: req.auth!.userId,
          externalUserId: id.data,
          expectedVersion: body.data.expectedVersion,
          accessExpiresAt: new Date(body.data.accessExpiresAt),
        }),
      );
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  },
);

router.post(
  "/external-accounts/:id/activate",
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const id = positiveInteger.safeParse(req.params.id);
    const body = versionBody.safeParse(req.body);
    if (
      !id.success ||
      !body.success ||
      !requireIdempotencyKey(req.get("Idempotency-Key"))
    ) {
      res
        .status(400)
        .json({
          error: "Invalid activation request",
          code: "invalid_external_account_input",
        });
      return;
    }
    try {
      res.json(
        await activateExternalAccount({
          actorUserId: req.auth!.userId,
          externalUserId: id.data,
          ...body.data,
        }),
      );
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  },
);

router.post(
  "/external-accounts/:id/transfer",
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const id = positiveInteger.safeParse(req.params.id);
    const body = z
      .strictObject({
        expectedVersion: positiveInteger,
        custodianUserId: positiveInteger,
      })
      .safeParse(req.body);
    if (
      !id.success ||
      !body.success ||
      !requireIdempotencyKey(req.get("Idempotency-Key"))
    ) {
      res
        .status(400)
        .json({
          error: "Invalid custody transfer request",
          code: "invalid_external_account_input",
        });
      return;
    }
    try {
      res.json(
        await transferExternalAccountCustodian({
          actorUserId: req.auth!.userId,
          externalUserId: id.data,
          ...body.data,
        }),
      );
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  },
);

router.post(
  "/external-accounts/:id/revoke",
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const id = positiveInteger.safeParse(req.params.id);
    const body = z
      .strictObject({
        expectedVersion: positiveInteger,
        reason: z.string().trim().min(3).max(300),
      })
      .safeParse(req.body);
    if (
      !id.success ||
      !body.success ||
      !requireIdempotencyKey(req.get("Idempotency-Key"))
    ) {
      res
        .status(400)
        .json({
          error: "Invalid revocation request",
          code: "invalid_external_account_input",
        });
      return;
    }
    try {
      res.json(
        await revokeExternalAccount({
          actorUserId: req.auth!.userId,
          externalUserId: id.data,
          ...body.data,
        }),
      );
    } catch (error) {
      if (!sendServiceError(res, error)) throw error;
    }
  },
);

export default router;
