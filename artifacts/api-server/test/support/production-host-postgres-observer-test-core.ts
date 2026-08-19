import {
  assertProductionHostPostgresSecretFreeWithTestAuthority,
  collectProductionHostPostgresExportWithTestAuthority,
  observeProductionHostDockerAuthorityWithTestAuthority,
  type ProductionHostDockerAuthorityRequest,
  type ProductionHostPostgresObserverRequest,
  type ProductionHostPostgresObserverTestDependencies,
} from "../../src/internal/production-host-postgres-observer-core";

export const productionHostPostgresObserverTestCore = Object.freeze({
  observeDocker(
    request: ProductionHostDockerAuthorityRequest,
    dependencies: ProductionHostPostgresObserverTestDependencies,
  ) {
    return observeProductionHostDockerAuthorityWithTestAuthority(
      request,
      dependencies,
    );
  },
  collectPostgres(
    request: ProductionHostPostgresObserverRequest,
    dependencies: ProductionHostPostgresObserverTestDependencies,
  ) {
    return collectProductionHostPostgresExportWithTestAuthority(
      request,
      dependencies,
    );
  },
  assertSecretFree(value: unknown) {
    assertProductionHostPostgresSecretFreeWithTestAuthority(value);
  },
});
