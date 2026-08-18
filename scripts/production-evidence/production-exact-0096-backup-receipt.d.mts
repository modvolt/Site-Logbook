export interface ProductionExact0096CanonicalArtifact {
  readonly canonical: string;
  readonly sha256: string;
  readonly value: Record<string, unknown>;
}

export function parseProductionExact0096BackupExecutorTrace(
  canonical: string,
  planCanonical: string,
): ProductionExact0096CanonicalArtifact;

export function parseProductionExact0096BackupReceipt(
  canonical: string,
  planCanonical: string,
  executorTraceCanonical: string,
): ProductionExact0096CanonicalArtifact;
