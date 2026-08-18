export const OBSERVATION_REQUEST_SCHEMA: "site-logbook.production-host-observation-request/v1";

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
