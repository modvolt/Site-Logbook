import {
  canonicalAccountingExportIntentJson,
  createAccountingReasonArtifactExportIntent,
  type AccountingExportIntentV1,
} from "./accounting-persistence-contract";
import {
  canonicalAccountingReasonArtifactJson,
  verifyAccountingReasonArtifactBinding,
  type AccountingReasonArtifactV1,
} from "./accounting-reason-artifact-contract";

/**
 * Restricted reason persistence surface for an already-open caller-owned
 * transaction. The lifecycle event must be persisted first in that same
 * transaction; the reason artifact and its dedicated restricted outbox intent
 * then either both commit or both roll back with the domain mutation.
 */
export interface AccountingReasonArtifactPersistenceTransactionV1 {
  loadReasonArtifactById(
    artifactId: string,
  ): Promise<AccountingReasonArtifactV1 | null>;
  insertReasonArtifact(artifact: AccountingReasonArtifactV1): Promise<void>;
  loadExportIntentById(
    intentId: string,
  ): Promise<AccountingExportIntentV1 | null>;
  insertExportIntent(intent: AccountingExportIntentV1): Promise<void>;
}

export async function appendAccountingReasonArtifactInTransaction(
  transaction: AccountingReasonArtifactPersistenceTransactionV1,
  artifactValue: unknown,
  lifecycleEventValue: unknown,
): Promise<{
  artifact: AccountingReasonArtifactV1;
  intent: AccountingExportIntentV1;
  replay: boolean;
}> {
  const artifact = verifyAccountingReasonArtifactBinding(
    artifactValue,
    lifecycleEventValue,
  );
  const intent = createAccountingReasonArtifactExportIntent(artifact);
  const [existingArtifact, existingIntent] = await Promise.all([
    transaction.loadReasonArtifactById(artifact.artifactId),
    transaction.loadExportIntentById(intent.intentId),
  ]);

  if (existingArtifact !== null) {
    if (
      canonicalAccountingReasonArtifactJson(existingArtifact) !==
      canonicalAccountingReasonArtifactJson(artifact)
    ) {
      throw new Error(
        "Reason-artifact replay does not match persisted canonical evidence.",
      );
    }
    if (
      existingIntent === null ||
      canonicalAccountingExportIntentJson(existingIntent) !==
        canonicalAccountingExportIntentJson(intent)
    ) {
      throw new Error(
        "Reason-artifact replay is missing its exact restricted export intent.",
      );
    }
    return {
      artifact: existingArtifact,
      intent: existingIntent,
      replay: true,
    };
  }
  if (existingIntent !== null) {
    throw new Error(
      "Restricted reason export intent exists without its reason artifact.",
    );
  }

  await transaction.insertReasonArtifact(artifact);
  await transaction.insertExportIntent(intent);
  return { artifact, intent, replay: false };
}
