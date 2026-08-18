import { Router, type IRouter } from "express";
import { and, desc, eq, gt, isNotNull, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  publicAccessTokensTable,
  switchboardsTable,
  type PublicAccessTokenPurpose,
} from "@workspace/db";
import { requirePermission } from "../middlewares/permissions";
import { requireVaultStepUp } from "../middlewares/auth";
import { lockAndAuthorizeUserManager } from "../lib/user-offboarding-service";
import { revokePublicAccessTokenById } from "../lib/public-access-token";
import {
  deactivateSwitchboardQrGrant,
  SwitchboardQrGrantError,
} from "../lib/switchboard-qr-grant";

const router: IRouter = Router();

const purpose = z.enum([
  "job_signature",
  "ppe_signature",
  "ppe_confirmation",
  "quote_decision",
]);

const listQuery = z.object({
  status: z.enum(["active", "expired", "revoked", "consumed", "all"]).default("active"),
  purpose: purpose.optional(),
  resourceType: z.enum(["job", "ppe_assignment", "quote"]).optional(),
  resourceId: z.coerce.number().int().positive().optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function stateOf(row: {
  revokedAt: Date | null;
  consumedAt: Date | null;
  expiresAt: Date;
}): "active" | "expired" | "revoked" | "consumed" {
  if (row.revokedAt) return "revoked";
  if (row.consumedAt) return "consumed";
  return row.expiresAt <= new Date() ? "expired" : "active";
}

router.get(
  "/external-grants",
  requirePermission("users.manage"),
  async (req, res): Promise<void> => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Neplatný filtr externích přístupů." });
      return;
    }
    const conditions: SQL[] = [];
    if (query.data.purpose) {
      conditions.push(eq(publicAccessTokensTable.purpose, query.data.purpose));
    }
    if (query.data.resourceType) {
      conditions.push(eq(publicAccessTokensTable.resourceType, query.data.resourceType));
    }
    if (query.data.resourceId) {
      conditions.push(eq(publicAccessTokensTable.resourceId, query.data.resourceId));
    }
    if (query.data.beforeId) {
      conditions.push(lt(publicAccessTokensTable.id, query.data.beforeId));
    }
    const now = new Date();
    if (query.data.status === "active") {
      conditions.push(isNull(publicAccessTokensTable.revokedAt));
      conditions.push(isNull(publicAccessTokensTable.consumedAt));
      conditions.push(gt(publicAccessTokensTable.expiresAt, now));
    } else if (query.data.status === "expired") {
      conditions.push(isNull(publicAccessTokensTable.revokedAt));
      conditions.push(isNull(publicAccessTokensTable.consumedAt));
      conditions.push(lte(publicAccessTokensTable.expiresAt, now));
    } else if (query.data.status === "revoked") {
      conditions.push(isNotNull(publicAccessTokensTable.revokedAt));
    } else if (query.data.status === "consumed") {
      conditions.push(isNotNull(publicAccessTokensTable.consumedAt));
    }

    const rows = await db
      .select({
        id: publicAccessTokensTable.id,
        purpose: publicAccessTokensTable.purpose,
        resourceType: publicAccessTokensTable.resourceType,
        resourceId: publicAccessTokensTable.resourceId,
        artifactBindingStatus: publicAccessTokensTable.artifactBindingStatus,
        tokenPrefix: publicAccessTokensTable.tokenPrefix,
        expiresAt: publicAccessTokensTable.expiresAt,
        createdAt: publicAccessTokensTable.createdAt,
        createdByUserId: publicAccessTokensTable.createdByUserId,
        ownerKind: publicAccessTokensTable.ownerKind,
        ownerUserId: publicAccessTokensTable.ownerUserId,
        ownerAssignedAt: publicAccessTokensTable.ownerAssignedAt,
        ownerAssignmentSource: publicAccessTokensTable.ownerAssignmentSource,
        revokedAt: publicAccessTokensTable.revokedAt,
        revokedByUserId: publicAccessTokensTable.revokedByUserId,
        revokeReason: publicAccessTokensTable.revokeReason,
        consumedAt: publicAccessTokensTable.consumedAt,
        consumeAction: publicAccessTokensTable.consumeAction,
      })
      .from(publicAccessTokensTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(publicAccessTokensTable.id))
      .limit(query.data.limit);

    res.json({
      items: rows.map((row) => ({
        ...row,
        purpose: row.purpose as PublicAccessTokenPurpose,
        state: stateOf(row),
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        ownerAssignedAt: row.ownerAssignedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        consumedAt: row.consumedAt?.toISOString() ?? null,
      })),
      nextBeforeId: rows.length === query.data.limit ? rows.at(-1)!.id : null,
    });
  },
);

const qrListQuery = z.object({
  status: z.enum(["active", "expired", "disabled", "all"]).default("active"),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

router.get(
  "/external-grants/switchboard-qr",
  requirePermission("users.manage"),
  async (req, res): Promise<void> => {
    const query = qrListQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Neplatný filtr QR přístupů." });
      return;
    }
    const now = new Date();
    const conditions: SQL[] = [isNotNull(switchboardsTable.qrTokenPrefix)];
    if (query.data.beforeId) {
      conditions.push(lt(switchboardsTable.id, query.data.beforeId));
    }
    if (query.data.status === "active") {
      conditions.push(eq(switchboardsTable.qrEnabled, true));
      conditions.push(
        or(
          isNull(switchboardsTable.qrExpiresAt),
          gt(switchboardsTable.qrExpiresAt, now),
        )!,
      );
      conditions.push(isNull(switchboardsTable.archivedAt));
    } else if (query.data.status === "expired") {
      conditions.push(eq(switchboardsTable.qrEnabled, true));
      conditions.push(lte(switchboardsTable.qrExpiresAt, now));
      conditions.push(isNull(switchboardsTable.archivedAt));
    } else if (query.data.status === "disabled") {
      conditions.push(
        or(
          eq(switchboardsTable.qrEnabled, false),
          isNotNull(switchboardsTable.archivedAt),
        )!,
      );
    }
    const rows = await db
      .select({
        switchboardId: switchboardsTable.id,
        designation: switchboardsTable.designation,
        tokenPrefix: switchboardsTable.qrTokenPrefix,
        enabled: switchboardsTable.qrEnabled,
        expiresAt: switchboardsTable.qrExpiresAt,
        ownerKind: switchboardsTable.qrOwnerKind,
        ownerUserId: switchboardsTable.qrOwnerUserId,
        ownerAssignedAt: switchboardsTable.qrOwnerAssignedAt,
        ownerAssignmentSource: switchboardsTable.qrOwnerAssignmentSource,
        archivedAt: switchboardsTable.archivedAt,
      })
      .from(switchboardsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(switchboardsTable.id))
      .limit(query.data.limit);
    res.json({
      items: rows.map((row) => ({
        ...row,
        state: row.archivedAt
          ? "disabled"
          : !row.enabled
            ? "disabled"
            : row.expiresAt && row.expiresAt <= now
              ? "expired"
              : "active",
        expiresAt: row.expiresAt?.toISOString() ?? null,
        ownerAssignedAt: row.ownerAssignedAt?.toISOString() ?? null,
        archivedAt: row.archivedAt?.toISOString() ?? null,
      })),
      nextBeforeId: rows.length === query.data.limit
        ? rows.at(-1)!.switchboardId
        : null,
    });
  },
);

const revokeBody = z.object({
  reason: z.string().trim().min(3).max(300),
}).strict();

router.post(
  "/external-grants/public/:id/revoke",
  requirePermission("users.manage"),
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const tokenId = z.coerce.number().int().positive().safeParse(req.params.id);
    const body = revokeBody.safeParse(req.body);
    if (!tokenId.success || !body.success) {
      res.status(400).json({ error: "Neplatné zrušení externího přístupu." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      await lockAndAuthorizeUserManager(tx, req.auth!.userId);
      return revokePublicAccessTokenById(
        {
          tokenId: tokenId.data,
          revokedByUserId: req.auth!.userId,
          reason: `manual_admin_revoke:${body.data.reason}`,
        },
        tx,
      );
    });
    if (!result.found) {
      res.status(404).json({ error: "Externí přístup nebyl nalezen." });
      return;
    }
    if (!result.revoked) {
      res.status(409).json({ error: "Externí přístup již není aktivní." });
      return;
    }
    res.json({
      id: result.revoked.id,
      state: "revoked",
      revokedAt: result.revoked.revokedAt!.toISOString(),
    });
  },
);

router.post(
  "/external-grants/switchboard-qr/:id/deactivate",
  requirePermission("users.manage"),
  requireVaultStepUp,
  async (req, res): Promise<void> => {
    const boardId = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!boardId.success) {
      res.status(400).json({ error: "Neplatné ID QR přístupu." });
      return;
    }
    try {
      await deactivateSwitchboardQrGrant({
        switchboardId: boardId.data,
        actorUserId: req.auth!.userId,
      });
      res.json({ switchboardId: boardId.data, state: "disabled" });
    } catch (error) {
      if (error instanceof SwitchboardQrGrantError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  },
);

export default router;
