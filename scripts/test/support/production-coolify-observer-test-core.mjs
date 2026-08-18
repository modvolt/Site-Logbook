import { collectCoolifyReadOnlyExportWithTestAuthority } from "../../production-evidence/internal/coolify-readonly-observer-core.mjs";
import {
  PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING,
  PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256,
  createProductionCoolifyHostBridgeAuthorityForTest,
  productionCoolifyHostBridgeTestContract,
} from "../../production-evidence/internal/coolify-host-bridge-authority.mjs";

export const productionCoolifyObserverTestCore = Object.freeze({
  collect(rawRequest, dependencies) {
    return collectCoolifyReadOnlyExportWithTestAuthority(
      rawRequest,
      dependencies,
    );
  },
  createHostBridgeAuthority(runDocker) {
    return createProductionCoolifyHostBridgeAuthorityForTest(runDocker);
  },
  controlPlaneBinding: PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING,
  bridgeSourceSha256: PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256,
  bridgeContract: productionCoolifyHostBridgeTestContract,
});
