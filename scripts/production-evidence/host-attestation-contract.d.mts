import type { Buffer } from "node:buffer";

export const OBSERVATION_REQUEST_SCHEMA: "site-logbook.production-host-observation-request/v1";

export interface ProductionApiImageProvenanceVerificationInput {
  canonical: string;
  signature: Buffer | string;
  sourceSha: string;
  expectedApiImage: string;
}

export interface ProductionApiImageProvenanceVerificationVerdict {
  sha256: string;
  sourceSha: string;
  subjectImage: string;
  publicationReceiptSha256: string;
  reviewedImageSetSha256: string;
  subjectRunnableManifestDigest: string;
  ociProvenanceSha256: string;
}

export function verifyProductionApiImageProvenanceArtifact(
  input: ProductionApiImageProvenanceVerificationInput,
): Readonly<ProductionApiImageProvenanceVerificationVerdict>;

export function verifyProductionApiImageProvenanceArtifactWithTestAuthority(
  input: ProductionApiImageProvenanceVerificationInput,
  testAuthority: Readonly<{
    trustedImageProvenanceKeys: Readonly<Record<string, string>>;
  }>,
): Readonly<ProductionApiImageProvenanceVerificationVerdict>;

export interface ProductionTargetEvidenceInput {
  request: Readonly<Record<string, unknown>>;
  imageProvenanceCanonical: string;
  imageProvenanceSignature: Buffer | string;
  coolify: Readonly<Record<string, unknown>>;
  docker: Readonly<Record<string, unknown>>;
  postgres: Readonly<Record<string, unknown>>;
}

export interface ProductionTargetEvidenceValue extends Readonly<
  Record<string, unknown>
> {
  livePostgresTarget: Readonly<
    Record<string, unknown> & { projectionSha256: string }
  >;
}

export interface ProductionTargetEvidenceArtifact {
  target: Readonly<ProductionTargetEvidenceValue>;
  canonical: string;
  sha256: string;
}

export interface ProductionTargetEvidenceTestAuthority {
  now: number;
  trustedImageProvenanceKeys: Readonly<Record<string, string>>;
}

export function createProductionTargetEvidence(
  input: ProductionTargetEvidenceInput,
): Readonly<ProductionTargetEvidenceArtifact>;

export function createProductionTargetEvidenceWithTestAuthority(
  input: ProductionTargetEvidenceInput,
  testAuthority: Readonly<ProductionTargetEvidenceTestAuthority>,
): Readonly<ProductionTargetEvidenceArtifact>;

export interface ProductionHostAttestationInput {
  targetCanonical: string;
  intentEvidenceCanonical: string;
  executionEvidenceCanonical: string;
  steadyEvidenceCanonical: string;
  releaseEvidenceCanonical: string;
  activationApprovalCanonical: string;
  keyId: string;
  currentObservation: ProductionTargetEvidenceInput;
  nonce?: string;
}

export interface ProductionHostAttestationArtifact {
  attestation: Readonly<Record<string, unknown>>;
  canonical: string;
  sha256: string;
}

export interface ProductionHostAttestationTestAuthority extends ProductionTargetEvidenceTestAuthority {
  lifetimeMs: number;
}

export function createProductionHostAttestation(
  input: ProductionHostAttestationInput,
): Readonly<ProductionHostAttestationArtifact>;

export function createProductionHostAttestationWithTestAuthority(
  input: ProductionHostAttestationInput,
  testAuthority: Readonly<ProductionHostAttestationTestAuthority>,
): Readonly<ProductionHostAttestationArtifact>;

export interface ProductionObservationVerificationInput {
  request: Readonly<Record<string, unknown>>;
  coolifyCanonical: string;
  dockerCanonical: string;
  postgresCanonical: string;
  activationIssuedAt: string;
}

export interface ProductionObservationVerificationVerdict {
  sourceSha: string;
  apiImage: string;
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
  capturedAt: string;
  coolifyObservedAt: string;
  dockerObservedAt: string;
  postgresObservedAt: string;
  desiredConfigSha256: string;
  deployedConfigSha256: string;
  resolvedComposeSha256: string;
  apiContainerId: string;
  apiContainerImage: string;
  apiContainerImageId: string;
  postgresContainerId: string;
  postgresImage: string;
  dockerExportSha256: string;
  backendProofSha256: string;
  coolifySha256: string;
  dockerSha256: string;
  postgresSha256: string;
}

export function verifyProductionObservationExports(
  input: ProductionObservationVerificationInput,
): Readonly<ProductionObservationVerificationVerdict>;
