import { randomUUID } from "node:crypto";
import { and, desc, eq, max, sql } from "drizzle-orm";
import {
  billingSettingsTable,
  db,
  switchboardDocumentsTable,
  switchboardEventsTable,
  switchboardLabelVersionsTable,
  switchboardsTable,
} from "@workspace/db";
import { ObjectStorageService } from "./objectStorage";
import {
  generateSwitchboardLabel,
  SWITCHBOARD_LABEL_GENERATOR_VERSION,
  validateLabelSnapshot,
  type SwitchboardLabelSnapshot,
} from "./switchboard-label";
import { createQrToken, decryptQrToken, encryptQrToken, hashQrToken, publicQrUrl } from "./switchboard-qr";

const storage = new ObjectStorageService();

type LabelActor = { userId: number | null; name: string | null };
type CreateLabelOptions = {
  switchboardId: number;
  sourceDocumentId?: number | null;
  mode: "manual" | "automatic";
  actor: LabelActor;
  requestBaseUrl?: string;
};

export function buildSwitchboardLabelSnapshot(
  board: typeof switchboardsTable.$inferSelect,
  settings: typeof billingSettingsTable.$inferSelect | null,
): SwitchboardLabelSnapshot {
  return {
    designation: board.designation,
    serialNumber: board.serialNumber ?? "",
    productionDate: board.productionDate ?? "",
    typeDesignation: board.typeDesignation ?? "",
    manufacturer: board.manufacturer,
    standards: board.standards,
    networkSystem: board.networkSystem ?? "",
    ratedVoltage: board.ratedVoltage ?? "",
    ratedFrequency: board.ratedFrequency ?? "",
    ratedCurrent: board.ratedCurrent ?? "",
    dimensions: board.dimensions,
    weight: board.weight,
    ipRating: board.ipRating ?? "",
    ikRating: board.ikRating,
    companyAddress: settings?.supplierAddress,
    companyPhone: settings?.supplierPhone,
  };
}

function workflowError(message: string, code: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

export async function createSwitchboardLabelVersion(options: CreateLabelOptions) {
  if (options.mode === "automatic" && options.sourceDocumentId) {
    const [existing] = await db.select().from(switchboardLabelVersionsTable)
      .where(and(eq(switchboardLabelVersionsTable.switchboardId, options.switchboardId), eq(switchboardLabelVersionsTable.sourceDocumentId, options.sourceDocumentId)))
      .orderBy(desc(switchboardLabelVersionsTable.version)).limit(1);
    if (existing) return { label: existing, created: false, qrActivated: false };
  }

  const [[board], [settings]] = await Promise.all([
    db.select().from(switchboardsTable).where(eq(switchboardsTable.id, options.switchboardId)),
    db.select().from(billingSettingsTable).where(eq(billingSettingsTable.id, 1)),
  ]);
  if (!board) throw workflowError("Rozvaděč nebyl nalezen.", "switchboard_not_found", 404);

  const now = new Date();
  let token: string;
  let qrPatch: Pick<typeof switchboardsTable.$inferInsert, "qrTokenHash" | "qrTokenCiphertext" | "qrTokenPrefix" | "qrEnabled" | "qrExpiresAt"> | null = null;
  if (board.qrEnabled && board.qrTokenCiphertext && (!board.qrExpiresAt || board.qrExpiresAt > now)) {
    token = decryptQrToken(board.qrTokenCiphertext);
  } else if (options.mode === "automatic" && !board.qrTokenHash && !board.qrTokenCiphertext) {
    token = createQrToken();
    qrPatch = {
      qrTokenHash: hashQrToken(token),
      qrTokenCiphertext: encryptQrToken(token),
      qrTokenPrefix: token.slice(0, 8),
      qrEnabled: true,
      qrExpiresAt: null,
    };
  } else if (board.qrExpiresAt && board.qrExpiresAt <= now) {
    throw workflowError("QR přístup rozvaděče vypršel. Obnovte jej před vytvořením štítku.", "qr_expired");
  } else {
    throw workflowError("Nejprve aktivujte QR přístup rozvaděče.", "qr_inactive");
  }

  const snapshot = buildSwitchboardLabelSnapshot(board, settings ?? null);
  const missing = validateLabelSnapshot(snapshot);
  if (missing.length) {
    throw Object.assign(workflowError("Typový štítek nelze vytvořit, chybí povinné potvrzené údaje.", "label_fields_missing"), { missingFields: missing });
  }

  const output = await generateSwitchboardLabel(snapshot, publicQrUrl(token, options.requestBaseUrl));
  const nonce = randomUUID();
  const pdfPath = `/objects/switchboards/${board.id}/labels/${nonce}.pdf`;
  const pngPath = `/objects/switchboards/${board.id}/labels/${nonce}.png`;
  let keepFiles = false;
  try {
    await Promise.all([
      storage.putPrivateObject(pdfPath, output.pdf, "application/pdf"),
      storage.putPrivateObject(pngPath, output.png, "image/png"),
    ]);
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${board.id}, 8403)`);
      if (options.mode === "automatic" && options.sourceDocumentId) {
        const [existing] = await tx.select().from(switchboardLabelVersionsTable)
          .where(and(eq(switchboardLabelVersionsTable.switchboardId, board.id), eq(switchboardLabelVersionsTable.sourceDocumentId, options.sourceDocumentId)))
          .orderBy(desc(switchboardLabelVersionsTable.version)).limit(1);
        if (existing) return { label: existing, created: false, qrActivated: false };
      }
      const [currentBoard] = await tx.select({ qrTokenHash: switchboardsTable.qrTokenHash, qrTokenCiphertext: switchboardsTable.qrTokenCiphertext })
        .from(switchboardsTable).where(eq(switchboardsTable.id, board.id));
      if (!currentBoard) throw workflowError("Rozvaděč nebyl nalezen.", "switchboard_not_found", 404);
      if (qrPatch) {
        if (currentBoard.qrTokenHash || currentBoard.qrTokenCiphertext) throw workflowError("QR přístup se během generování změnil. Opakujte akci.", "qr_changed", 409);
        await tx.update(switchboardsTable).set({ ...qrPatch, updatedAt: now }).where(eq(switchboardsTable.id, board.id));
      } else if (currentBoard.qrTokenHash !== board.qrTokenHash) {
        throw workflowError("QR přístup se během generování změnil. Opakujte akci.", "qr_changed", 409);
      }
      const [{ value }] = await tx.select({ value: max(switchboardLabelVersionsTable.version) }).from(switchboardLabelVersionsTable).where(eq(switchboardLabelVersionsTable.switchboardId, board.id));
      const autoApproved = options.mode === "automatic";
      const [created] = await tx.insert(switchboardLabelVersionsTable).values({
        switchboardId: board.id,
        version: Number(value ?? 0) + 1,
        sourceDocumentId: options.sourceDocumentId ?? null,
        inputSnapshot: snapshot,
        pdfStoragePath: pdfPath,
        pngStoragePath: pngPath,
        qrTarget: `/q/board/${(qrPatch?.qrTokenPrefix ?? board.qrTokenPrefix) ?? "unknown"}...`,
        status: autoApproved ? "approved" : "draft",
        generatorVersion: SWITCHBOARD_LABEL_GENERATOR_VERSION,
        createdByUserId: options.actor.userId,
        approvedByUserId: autoApproved ? options.actor.userId : null,
        approvedAt: autoApproved ? now : null,
      }).returning();
      const eventBase = { switchboardId: board.id, entityType: "switchboard_label_version", entityId: created.id, actorUserId: options.actor.userId, actorName: options.actor.name };
      await tx.insert(switchboardEventsTable).values({ ...eventBase, eventType: "label_generated", payload: { version: created.version, sourceDocumentId: options.sourceDocumentId ?? null, generatorVersion: SWITCHBOARD_LABEL_GENERATOR_VERSION, qrTokenPrefix: qrPatch?.qrTokenPrefix ?? board.qrTokenPrefix, trigger: options.mode } });
      if (autoApproved) await tx.insert(switchboardEventsTable).values({ ...eventBase, eventType: "label_approved", payload: { version: created.version, trigger: "automatic", validation: "all_required_fields_valid_and_confident" } });
      if (qrPatch) await tx.insert(switchboardEventsTable).values({ switchboardId: board.id, eventType: "qr_token_created", entityType: "switchboard", entityId: board.id, payload: { tokenPrefix: qrPatch.qrTokenPrefix, trigger: "automatic_label_workflow" }, actorName: "System" });
      return { label: created, created: true, qrActivated: !!qrPatch };
    });
    keepFiles = result.created;
    return result;
  } finally {
    if (!keepFiles) await Promise.allSettled([storage.deletePrivateObject(pdfPath), storage.deletePrivateObject(pngPath)]);
  }
}

export async function latestCompletedDboDocumentId(switchboardId: number): Promise<number | null> {
  const [source] = await db.select({ id: switchboardDocumentsTable.id }).from(switchboardDocumentsTable)
    .where(and(eq(switchboardDocumentsTable.switchboardId, switchboardId), eq(switchboardDocumentsTable.documentType, "schrack_norm_dbo"), eq(switchboardDocumentsTable.processingStatus, "completed")))
    .orderBy(desc(switchboardDocumentsTable.version)).limit(1);
  return source?.id ?? null;
}
