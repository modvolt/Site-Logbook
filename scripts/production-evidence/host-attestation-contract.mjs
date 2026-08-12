import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from "node:crypto";
import {
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS,
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256,
} from "../../artifacts/api-server/src/lib/production-publisher-provenance-pinned-keys.mjs";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const KEY_ID = /^ed25519:[a-z0-9][a-z0-9._-]{2,63}$/;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_OBSERVATION_SPREAD_MS = 2 * 60_000;
const MAX_ATTESTATION_LIFETIME_MS = 15 * 60_000;

export const PRODUCTION_TARGET = Object.freeze({
  projectId: "bai77dzr0h7b5gu1jqwpriew",
  environmentId: "d5m70pb2i5s7c41n21vaokr7",
  applicationId: "ef09696arga7h9ox6ojgv7ru",
  environmentLabel: "production",
  logicalEnvironmentId: "site-logbook-production",
});

export const OBSERVATION_REQUEST_SCHEMA =
  "site-logbook.production-host-observation-request/v1";
export const COOLIFY_EXPORT_SCHEMA =
  "site-logbook.production-host-coolify-export/v1";
export const DOCKER_EXPORT_SCHEMA =
  "site-logbook.production-host-docker-export/v1";
export const POSTGRES_EXPORT_SCHEMA =
  "site-logbook.production-host-postgres-export/v1";
export const ACTIVATION_APPROVAL_SCHEMA =
  "site-logbook.production-activation-approval/v1";
export const IMAGE_PROVENANCE_SCHEMA =
  "site-logbook.production-api-image-provenance/v1";
export const HOST_ATTESTATION_SCHEMA =
  "site-logbook.production-host-attestation/v1";
export const HOST_ATTESTATION_KIND =
  "site-logbook-production-audit-0107-host-attestation";
export const HOST_RUNNER_VERSION =
  "site-logbook-production-host-evidence-runner/v1";
export const PINNED_IMAGE_PROVENANCE_KEYS =
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEYS;
export const PINNED_IMAGE_PROVENANCE_KEY_SHA256 =
  PINNED_PRODUCTION_PUBLISHER_PROVENANCE_KEY_SHA256;

export class ProductionHostEvidenceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionHostEvidenceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionHostEvidenceError(code, message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_HOST_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value;
}

function exactKeys(value, expected, field) {
  const object = objectAt(value, field);
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail(
      "PRODUCTION_HOST_SCHEMA_INVALID",
      `${field} must contain only the reviewed fields.`,
    );
  }
  return object;
}

function exactString(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail("PRODUCTION_HOST_SCHEMA_INVALID", `${field} must be exact text.`);
  }
  return value;
}

function exactArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("PRODUCTION_HOST_SCHEMA_INVALID", `${field} must be non-empty.`);
  }
  return value;
}

function exactSha(value, field) {
  const result = exactString(value, field).toLowerCase();
  if (!SHA.test(result) || /^0{40}$/.test(result)) {
    fail("PRODUCTION_HOST_SHA_INVALID", `${field} must be a Git SHA.`);
  }
  return result;
}

function exactDigest(value, field) {
  const result = exactString(value, field).toLowerCase();
  if (!DIGEST.test(result) || /^sha256:0{64}$/.test(result)) {
    fail("PRODUCTION_HOST_DIGEST_INVALID", `${field} must be SHA-256.`);
  }
  return result;
}

function exactImage(value, field) {
  const result = exactString(value, field);
  if (!IMMUTABLE_IMAGE.test(result)) {
    fail(
      "PRODUCTION_HOST_IMAGE_MUTABLE",
      `${field} must be an immutable digest reference.`,
    );
  }
  return result;
}

function exactTime(value, field) {
  const result = exactString(value, field);
  const millis = Date.parse(result);
  if (!Number.isFinite(millis) || !result.endsWith("Z")) {
    fail("PRODUCTION_HOST_TIME_INVALID", `${field} must be UTC.`);
  }
  return { text: result, millis };
}

function requireEqual(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_HOST_BINDING_INVALID",
      `${field} does not match the reviewed binding.`,
    );
  }
}

function requireHex64(value, field) {
  const result = exactString(value, field).toLowerCase();
  if (!HEX64.test(result) || /^0{64}$/.test(result)) {
    fail("PRODUCTION_HOST_TARGET_INVALID", `${field} must be 64 hex.`);
  }
  return result;
}

const FORBIDDEN_KEY =
  /(password|passwd|secret|token|credential|private.?key|database.?url|access.?key|session|cookie)/i;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._~+/-]+=*|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/i;

export function assertSecretFree(value, field = "input") {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) {
      fail(
        "PRODUCTION_HOST_SECRET_MATERIAL",
        `${field} contains forbidden secret-shaped material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretFree(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      fail(
        "PRODUCTION_HOST_SECRET_MATERIAL",
        `${field} contains a forbidden secret field.`,
      );
    }
    assertSecretFree(entry, `${field}.${key}`);
  }
}

function parseRequest(value) {
  assertSecretFree(value, "request");
  const request = exactKeys(
    value,
    [
      "schemaVersion",
      "sourceSha",
      "expectedApiImage",
      "databaseName",
      "databaseUser",
      "schemaFingerprintSha256",
      "composeProject",
      "postgresService",
      "postgresVolumeDestination",
      "expectedNetworkServices",
    ],
    "request",
  );
  requireEqual(
    request.schemaVersion,
    OBSERVATION_REQUEST_SCHEMA,
    "request.schemaVersion",
  );
  const sourceSha = exactSha(request.sourceSha, "request.sourceSha");
  const expectedNetworkServices = exactArray(
    request.expectedNetworkServices,
    "request.expectedNetworkServices",
  ).map((entry, index) =>
    exactString(entry, `request.expectedNetworkServices[${index}]`),
  );
  const sortedServices = [...expectedNetworkServices].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    new Set(expectedNetworkServices).size !== expectedNetworkServices.length ||
    JSON.stringify(expectedNetworkServices) !==
      JSON.stringify(sortedServices) ||
    JSON.stringify(expectedNetworkServices) !==
      JSON.stringify(["api", "postgres", "web"])
  ) {
    fail(
      "PRODUCTION_HOST_SCHEMA_INVALID",
      "request.expectedNetworkServices must be the exact binary-sorted production runtime service set.",
    );
  }
  const postgresService = exactString(
    request.postgresService,
    "request.postgresService",
  );
  if (!expectedNetworkServices.includes(postgresService)) {
    fail(
      "PRODUCTION_HOST_SCHEMA_INVALID",
      "The Postgres service must be an expected network peer.",
    );
  }
  return {
    sourceSha,
    expectedApiImage: exactImage(
      request.expectedApiImage,
      "request.expectedApiImage",
    ),
    databaseName: exactString(request.databaseName, "request.databaseName"),
    databaseUser: exactString(request.databaseUser, "request.databaseUser"),
    schemaFingerprintSha256: exactDigest(
      request.schemaFingerprintSha256,
      "request.schemaFingerprintSha256",
    ),
    composeProject: exactString(
      request.composeProject,
      "request.composeProject",
    ),
    postgresService,
    postgresVolumeDestination: exactString(
      request.postgresVolumeDestination,
      "request.postgresVolumeDestination",
    ),
    expectedNetworkServices,
  };
}

function parseImageProvenanceArtifact(
  raw,
  signature,
  request,
  trustedImageProvenanceKeys,
) {
  const provenance = parseCanonicalArtifact(raw, "imageProvenance");
  exactKeys(
    provenance,
    [
      "schemaVersion",
      "keyId",
      "subjectImage",
      "subjectDigest",
      "sourceSha",
      "buildProfile",
      "mutatingEntrypointsPresent",
    ],
    "imageProvenance",
  );
  requireEqual(
    provenance.schemaVersion,
    IMAGE_PROVENANCE_SCHEMA,
    "imageProvenance.schemaVersion",
  );
  const keyId = exactString(provenance.keyId, "imageProvenance.keyId");
  const publicKeyPem = trustedImageProvenanceKeys[keyId];
  if (!publicKeyPem) {
    fail(
      "PRODUCTION_HOST_PROVENANCE_KEY_UNTRUSTED",
      "Image provenance key id is not source-pinned.",
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail(
      "PRODUCTION_HOST_PROVENANCE_KEY_INVALID",
      "Pinned image provenance public key is invalid.",
    );
  }
  const signatureBytes = Buffer.isBuffer(signature)
    ? signature
    : Buffer.from(exactString(signature, "imageProvenanceSignature"), "base64");
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    signatureBytes.length !== 64 ||
    !verifySignature(null, Buffer.from(raw, "utf8"), publicKey, signatureBytes)
  ) {
    fail(
      "PRODUCTION_HOST_PROVENANCE_SIGNATURE_INVALID",
      "Detached image provenance signature verification failed.",
    );
  }
  const subjectImage = exactImage(
    provenance.subjectImage,
    "imageProvenance.subjectImage",
  );
  requireEqual(
    subjectImage,
    request.expectedApiImage,
    "imageProvenance.subjectImage",
  );
  requireEqual(
    exactDigest(provenance.subjectDigest, "imageProvenance.subjectDigest"),
    `sha256:${subjectImage.split("@sha256:")[1]}`,
    "imageProvenance.subjectDigest",
  );
  requireEqual(
    exactSha(provenance.sourceSha, "imageProvenance.sourceSha"),
    request.sourceSha,
    "imageProvenance.sourceSha",
  );
  requireEqual(
    provenance.buildProfile,
    "production",
    "imageProvenance.buildProfile",
  );
  requireEqual(
    provenance.mutatingEntrypointsPresent,
    false,
    "imageProvenance.mutatingEntrypointsPresent",
  );
  return { sha256: sha256(raw) };
}

const IMAGE_KEYS = ["api", "postgres", "web"];

function parseCoolifyConfig(value, field) {
  const config = exactKeys(
    value,
    ["configurationSha256", "resolvedComposeSha256", "images"],
    field,
  );
  const images = exactKeys(config.images, IMAGE_KEYS, `${field}.images`);
  const parsedImages = Object.fromEntries(
    IMAGE_KEYS.map((key) => [
      key,
      exactImage(images[key], `${field}.images.${key}`),
    ]),
  );
  return {
    configurationSha256: exactDigest(
      config.configurationSha256,
      `${field}.configurationSha256`,
    ),
    resolvedComposeSha256: exactDigest(
      config.resolvedComposeSha256,
      `${field}.resolvedComposeSha256`,
    ),
    images: parsedImages,
  };
}

function parseCoolify(value, request) {
  assertSecretFree(value, "coolifyExport");
  const coolify = exactKeys(
    value,
    [
      "schemaVersion",
      "observedAt",
      "projectId",
      "environmentId",
      "environmentLabel",
      "applicationId",
      "pendingChanges",
      "desiredConfig",
      "deployedConfig",
    ],
    "coolifyExport",
  );
  requireEqual(
    coolify.schemaVersion,
    COOLIFY_EXPORT_SCHEMA,
    "coolifyExport.schemaVersion",
  );
  for (const key of [
    "projectId",
    "environmentId",
    "environmentLabel",
    "applicationId",
  ]) {
    requireEqual(coolify[key], PRODUCTION_TARGET[key], `coolifyExport.${key}`);
  }
  requireEqual(coolify.pendingChanges, false, "coolifyExport.pendingChanges");
  const desired = parseCoolifyConfig(
    coolify.desiredConfig,
    "coolifyExport.desiredConfig",
  );
  const deployed = parseCoolifyConfig(
    coolify.deployedConfig,
    "coolifyExport.deployedConfig",
  );
  requireEqual(
    canonicalJson(desired),
    canonicalJson(deployed),
    "coolifyExport.desiredConfig",
  );
  requireEqual(
    deployed.images.api,
    request.expectedApiImage,
    "coolifyExport.deployedConfig.images.api",
  );
  return {
    observedAt: exactTime(coolify.observedAt, "coolifyExport.observedAt"),
    desired,
    deployed,
  };
}

function parsePeer(value, field) {
  const peer = exactKeys(
    value,
    [
      "containerId",
      "name",
      "composeProject",
      "service",
      "state",
      "image",
      "imageId",
    ],
    field,
  );
  return {
    containerId: requireHex64(peer.containerId, `${field}.containerId`),
    name: exactString(peer.name, `${field}.name`),
    composeProject: exactString(peer.composeProject, `${field}.composeProject`),
    service: exactString(peer.service, `${field}.service`),
    state: exactString(peer.state, `${field}.state`),
    image: exactImage(peer.image, `${field}.image`),
    imageId: exactDigest(peer.imageId, `${field}.imageId`),
  };
}

function parseDocker(value, request, coolify) {
  assertSecretFree(value, "dockerExport");
  const docker = exactKeys(
    value,
    [
      "schemaVersion",
      "observedAt",
      "composeProject",
      "targetContainer",
      "volume",
      "network",
      "volumePeers",
      "networkPeers",
    ],
    "dockerExport",
  );
  requireEqual(
    docker.schemaVersion,
    DOCKER_EXPORT_SCHEMA,
    "dockerExport.schemaVersion",
  );
  requireEqual(
    docker.composeProject,
    request.composeProject,
    "dockerExport.composeProject",
  );
  const target = exactKeys(
    docker.targetContainer,
    [
      "id",
      "name",
      "service",
      "image",
      "imageId",
      "state",
      "mounts",
      "networks",
    ],
    "dockerExport.targetContainer",
  );
  const targetId = requireHex64(target.id, "dockerExport.targetContainer.id");
  requireEqual(
    target.service,
    request.postgresService,
    "dockerExport.targetContainer.service",
  );
  requireEqual(target.state, "running", "dockerExport.targetContainer.state");
  const targetImage = exactImage(
    target.image,
    "dockerExport.targetContainer.image",
  );
  requireEqual(
    targetImage,
    coolify.deployed.images.postgres,
    "dockerExport.targetContainer.image",
  );
  const imageId = exactDigest(
    target.imageId,
    "dockerExport.targetContainer.imageId",
  );
  const volume = exactKeys(
    docker.volume,
    ["name", "driver"],
    "dockerExport.volume",
  );
  const volumeName = exactString(volume.name, "dockerExport.volume.name");
  requireEqual(volume.driver, "local", "dockerExport.volume.driver");
  const network = exactKeys(
    docker.network,
    ["name", "id", "driver", "internal"],
    "dockerExport.network",
  );
  const networkName = exactString(network.name, "dockerExport.network.name");
  const networkId = requireHex64(network.id, "dockerExport.network.id");
  requireEqual(network.driver, "bridge", "dockerExport.network.driver");
  if (typeof network.internal !== "boolean") {
    fail(
      "PRODUCTION_HOST_SCHEMA_INVALID",
      "dockerExport.network.internal must be boolean.",
    );
  }

  const mounts = exactArray(
    target.mounts,
    "dockerExport.targetContainer.mounts",
  ).map((entry, index) => {
    const mount = exactKeys(
      entry,
      ["type", "name", "destination", "readOnly"],
      `dockerExport.targetContainer.mounts[${index}]`,
    );
    if (typeof mount.readOnly !== "boolean") {
      fail(
        "PRODUCTION_HOST_SCHEMA_INVALID",
        `dockerExport.targetContainer.mounts[${index}].readOnly must be boolean.`,
      );
    }
    return mount;
  });
  if (
    mounts.length !== 1 ||
    mounts[0].type !== "volume" ||
    mounts[0].name !== volumeName ||
    mounts[0].destination !== request.postgresVolumeDestination ||
    mounts[0].readOnly !== false
  ) {
    fail(
      "PRODUCTION_HOST_TARGET_INVALID",
      "The Postgres data volume mount does not match the reviewed target.",
    );
  }
  const networks = exactArray(
    target.networks,
    "dockerExport.targetContainer.networks",
  ).map((entry, index) =>
    exactKeys(
      entry,
      ["name", "id"],
      `dockerExport.targetContainer.networks[${index}]`,
    ),
  );
  if (
    networks.length !== 1 ||
    networks[0].name !== networkName ||
    networks[0].id !== networkId
  ) {
    fail(
      "PRODUCTION_HOST_TARGET_INVALID",
      "The Postgres network attachment does not match the reviewed target.",
    );
  }

  const volumePeers = exactArray(
    docker.volumePeers,
    "dockerExport.volumePeers",
  ).map((peer, index) => parsePeer(peer, `dockerExport.volumePeers[${index}]`));
  if (
    volumePeers.length !== 1 ||
    volumePeers[0].containerId !== targetId ||
    volumePeers[0].composeProject !== request.composeProject ||
    volumePeers[0].service !== request.postgresService ||
    volumePeers[0].image !== targetImage ||
    volumePeers[0].imageId !== imageId
  ) {
    fail(
      "PRODUCTION_HOST_FOREIGN_PEER",
      "The Postgres volume has an unapproved or missing peer.",
    );
  }

  const networkPeers = exactArray(
    docker.networkPeers,
    "dockerExport.networkPeers",
  ).map((peer, index) =>
    parsePeer(peer, `dockerExport.networkPeers[${index}]`),
  );
  const services = networkPeers
    .map((peer) => peer.service)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    networkPeers.some(
      (peer) =>
        peer.composeProject !== request.composeProject ||
        peer.state !== "running",
    ) ||
    new Set(services).size !== services.length ||
    JSON.stringify(services) !==
      JSON.stringify(request.expectedNetworkServices) ||
    !networkPeers.some(
      (peer) =>
        peer.containerId === targetId &&
        peer.image === targetImage &&
        peer.imageId === imageId,
    )
  ) {
    fail(
      "PRODUCTION_HOST_FOREIGN_PEER",
      "The production network peer set is not the exact reviewed set.",
    );
  }
  const imageKeyByService = {
    api: "api",
    postgres: "postgres",
    web: "web",
  };
  for (const peer of networkPeers) {
    const imageKey = imageKeyByService[peer.service];
    if (!imageKey || peer.image !== coolify.deployed.images[imageKey]) {
      fail(
        "PRODUCTION_HOST_TARGET_INVALID",
        `The ${peer.service} peer image does not match deployed Coolify state.`,
      );
    }
  }

  return {
    observedAt: exactTime(docker.observedAt, "dockerExport.observedAt"),
    target: {
      containerId: targetId,
      image: targetImage,
      imageId,
      volumeName,
      networkName,
      networkId,
    },
  };
}

function parsePostgres(value, request, docker) {
  assertSecretFree(value, "postgresExport");
  const postgres = exactKeys(
    value,
    [
      "schemaVersion",
      "observedAt",
      "containerId",
      "databaseName",
      "databaseUser",
      "schemaFingerprintSha256",
      "serverVersion",
      "readOnlyObservation",
    ],
    "postgresExport",
  );
  requireEqual(
    postgres.schemaVersion,
    POSTGRES_EXPORT_SCHEMA,
    "postgresExport.schemaVersion",
  );
  requireEqual(
    requireHex64(postgres.containerId, "postgresExport.containerId"),
    docker.target.containerId,
    "postgresExport.containerId",
  );
  requireEqual(
    postgres.databaseName,
    request.databaseName,
    "postgresExport.databaseName",
  );
  requireEqual(
    postgres.databaseUser,
    request.databaseUser,
    "postgresExport.databaseUser",
  );
  requireEqual(
    exactDigest(
      postgres.schemaFingerprintSha256,
      "postgresExport.schemaFingerprintSha256",
    ),
    request.schemaFingerprintSha256,
    "postgresExport.schemaFingerprintSha256",
  );
  requireEqual(
    postgres.readOnlyObservation,
    true,
    "postgresExport.readOnlyObservation",
  );
  exactString(postgres.serverVersion, "postgresExport.serverVersion");
  return {
    observedAt: exactTime(postgres.observedAt, "postgresExport.observedAt"),
  };
}

function validateObservationTimes(times, now) {
  const millis = times.map((time) => time.millis);
  const latest = Math.max(...millis);
  const earliest = Math.min(...millis);
  if (latest > now + MAX_CLOCK_SKEW_MS) {
    fail(
      "PRODUCTION_HOST_TIME_INVALID",
      "An observation is too far in the future.",
    );
  }
  if (latest - earliest > MAX_OBSERVATION_SPREAD_MS) {
    fail(
      "PRODUCTION_HOST_TIME_INVALID",
      "The Coolify, Docker and PostgreSQL observations are not one bounded snapshot.",
    );
  }
  if (now - earliest > MAX_ATTESTATION_LIFETIME_MS) {
    fail("PRODUCTION_HOST_TIME_INVALID", "The host observations are stale.");
  }
  return new Date(latest).toISOString();
}

export function createProductionTargetEvidence(
  {
    request: rawRequest,
    imageProvenanceCanonical,
    imageProvenanceSignature,
    coolify: rawCoolify,
    docker: rawDocker,
    postgres: rawPostgres,
  },
  {
    now = Date.now(),
    trustedImageProvenanceKeys = PINNED_IMAGE_PROVENANCE_KEYS,
  } = {},
) {
  const request = parseRequest(rawRequest);
  const imageProvenance = parseImageProvenanceArtifact(
    imageProvenanceCanonical,
    imageProvenanceSignature,
    request,
    trustedImageProvenanceKeys,
  );
  const coolify = parseCoolify(rawCoolify, request);
  const docker = parseDocker(rawDocker, request, coolify);
  const postgres = parsePostgres(rawPostgres, request, docker);
  const capturedAt = validateObservationTimes(
    [coolify.observedAt, docker.observedAt, postgres.observedAt],
    now,
  );
  const projection = {
    containerId: docker.target.containerId,
    image: docker.target.image,
    imageId: docker.target.imageId,
    networkId: docker.target.networkId,
    networkName: docker.target.networkName,
    volumeName: docker.target.volumeName,
  };
  const target = {
    schemaVersion: 1,
    kind: "site-logbook-production-audit-0107-target",
    logicalEnvironmentId: PRODUCTION_TARGET.logicalEnvironmentId,
    coolify: {
      projectId: PRODUCTION_TARGET.projectId,
      environmentId: PRODUCTION_TARGET.environmentId,
      environmentLabel: PRODUCTION_TARGET.environmentLabel,
      applicationId: PRODUCTION_TARGET.applicationId,
      pendingChanges: false,
      deployedConfigSha256: coolify.deployed.configurationSha256,
      desiredConfigSha256: coolify.desired.configurationSha256,
      resolvedComposeSha256: coolify.deployed.resolvedComposeSha256,
    },
    build: {
      sourceSha: request.sourceSha,
      provenanceSourceSha: request.sourceSha,
      provenanceEvidenceSha256: imageProvenance.sha256,
      apiImage: coolify.deployed.images.api,
      apiImageDigest: `sha256:${coolify.deployed.images.api.split("@sha256:")[1]}`,
      imageProfile: "production",
      mutatingEntrypointsPresent: false,
    },
    database: {
      name: request.databaseName,
      user: request.databaseUser,
    },
    livePostgresTarget: {
      ...projection,
      projectionSha256: sha256(canonicalJson(projection)),
    },
    schemaFingerprintSha256: request.schemaFingerprintSha256,
    capturedAt,
  };
  assertSecretFree(target, "targetEvidence");
  const canonical = canonicalJson(target);
  if (Buffer.byteLength(canonical) > MAX_JSON_BYTES) {
    fail("PRODUCTION_HOST_ARTIFACT_INVALID", "Target evidence is too large.");
  }
  return Object.freeze({
    target: Object.freeze(target),
    canonical,
    sha256: sha256(canonical),
  });
}

function parseCanonicalArtifact(raw, field) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_JSON_BYTES) {
    fail(
      "PRODUCTION_HOST_ARTIFACT_INVALID",
      `${field} is invalid or too large.`,
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_HOST_ARTIFACT_INVALID", `${field} must be JSON.`);
  }
  if (canonicalJson(value) !== raw) {
    fail(
      "PRODUCTION_HOST_ARTIFACT_INVALID",
      `${field} must be canonical JSON with one trailing LF.`,
    );
  }
  assertSecretFree(value, field);
  return objectAt(value, field);
}

function stableTarget(target) {
  const copy = structuredClone(target);
  delete copy.capturedAt;
  return copy;
}

function parseReleaseArtifacts(
  targetEvidenceCanonical,
  intentEvidenceCanonical,
  executionEvidenceCanonical,
  steadyEvidenceCanonical,
  releaseCanonical,
  activationApprovalCanonical,
) {
  const target = parseCanonicalArtifact(
    targetEvidenceCanonical,
    "targetEvidence",
  );
  const intent = parseCanonicalArtifact(
    intentEvidenceCanonical,
    "intentEvidence",
  );
  const execution = parseCanonicalArtifact(
    executionEvidenceCanonical,
    "executionEvidence",
  );
  const steady = parseCanonicalArtifact(
    steadyEvidenceCanonical,
    "steadyEvidence",
  );
  const release = exactKeys(
    parseCanonicalArtifact(releaseCanonical, "releaseEvidence"),
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "targetEvidenceSha256",
      "intentEvidenceSha256",
      "executionEvidenceSha256",
      "steadyEvidenceSha256",
      "confirmation",
      "activationApprovalSha256",
      "approvedAt",
      "operator",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    "releaseEvidence",
  );
  requireEqual(release.schemaVersion, 1, "releaseEvidence.schemaVersion");
  requireEqual(
    release.kind,
    "site-logbook-production-audit-0107-release-evidence",
    "releaseEvidence.kind",
  );
  requireEqual(
    release.confirmation,
    "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    "releaseEvidence.confirmation",
  );
  requireEqual(
    release.productionTargetsTouched,
    true,
    "releaseEvidence.productionTargetsTouched",
  );
  requireEqual(
    release.authorizesApplicationStart,
    true,
    "releaseEvidence.authorizesApplicationStart",
  );
  exactDigest(
    release.intentEvidenceSha256,
    "releaseEvidence.intentEvidenceSha256",
  );
  exactDigest(
    release.executionEvidenceSha256,
    "releaseEvidence.executionEvidenceSha256",
  );
  exactDigest(
    release.steadyEvidenceSha256,
    "releaseEvidence.steadyEvidenceSha256",
  );
  exactTime(release.approvedAt, "releaseEvidence.approvedAt");
  exactString(release.operator, "releaseEvidence.operator");
  const targetEvidenceSha256 = sha256(targetEvidenceCanonical);
  const sourceSha = exactSha(release.sourceSha, "releaseEvidence.sourceSha");
  requireEqual(
    exactSha(target.build?.sourceSha, "targetEvidence.build.sourceSha"),
    sourceSha,
    "targetEvidence.build.sourceSha",
  );
  for (const [field, value, canonical] of [
    ["intentEvidenceSha256", intent, intentEvidenceCanonical],
    ["executionEvidenceSha256", execution, executionEvidenceCanonical],
    ["steadyEvidenceSha256", steady, steadyEvidenceCanonical],
  ]) {
    requireEqual(release[field], sha256(canonical), `releaseEvidence.${field}`);
    requireEqual(value.sourceSha, sourceSha, `${field}.sourceSha`);
    requireEqual(
      value.targetEvidenceSha256,
      targetEvidenceSha256,
      `${field}.targetEvidenceSha256`,
    );
  }
  requireEqual(
    release.targetEvidenceSha256,
    targetEvidenceSha256,
    "releaseEvidence.targetEvidenceSha256",
  );

  const approval = exactKeys(
    parseCanonicalArtifact(
      activationApprovalCanonical,
      "activationApprovalEvidence",
    ),
    [
      "schemaVersion",
      "sourceSha",
      "targetEvidenceSha256",
      "confirmation",
      "approvedAt",
      "operator",
    ],
    "activationApprovalEvidence",
  );
  requireEqual(
    approval.schemaVersion,
    ACTIVATION_APPROVAL_SCHEMA,
    "activationApprovalEvidence.schemaVersion",
  );
  requireEqual(
    approval.confirmation,
    "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START",
    "activationApprovalEvidence.confirmation",
  );
  requireEqual(
    approval.sourceSha,
    release.sourceSha,
    "activationApprovalEvidence.sourceSha",
  );
  requireEqual(
    approval.targetEvidenceSha256,
    release.targetEvidenceSha256,
    "activationApprovalEvidence.targetEvidenceSha256",
  );
  requireEqual(
    approval.approvedAt,
    release.approvedAt,
    "activationApprovalEvidence.approvedAt",
  );
  requireEqual(
    approval.operator,
    release.operator,
    "activationApprovalEvidence.operator",
  );
  const approvalSha256 = sha256(activationApprovalCanonical);
  requireEqual(
    exactDigest(
      release.activationApprovalSha256,
      "releaseEvidence.activationApprovalSha256",
    ),
    approvalSha256,
    "releaseEvidence.activationApprovalSha256",
  );
  return {
    sourceSha,
    targetEvidenceSha256,
    releaseEvidenceSha256: sha256(releaseCanonical),
    activationApprovalSha256: approvalSha256,
  };
}

export function deriveProductionReleaseBinding(
  targetEvidenceCanonical,
  intentEvidenceCanonical,
  executionEvidenceCanonical,
  steadyEvidenceCanonical,
  releaseEvidenceCanonical,
  activationApprovalCanonical,
) {
  return Object.freeze(
    parseReleaseArtifacts(
      targetEvidenceCanonical,
      intentEvidenceCanonical,
      executionEvidenceCanonical,
      steadyEvidenceCanonical,
      releaseEvidenceCanonical,
      activationApprovalCanonical,
    ),
  );
}

export function createProductionHostAttestation(
  {
    targetCanonical,
    intentEvidenceCanonical,
    executionEvidenceCanonical,
    steadyEvidenceCanonical,
    releaseEvidenceCanonical,
    activationApprovalCanonical,
    keyId: rawKeyId,
    currentObservation,
    nonce = randomBytes(16).toString("hex"),
  },
  {
    now = Date.now(),
    lifetimeMs = 10 * 60_000,
    trustedImageProvenanceKeys = PINNED_IMAGE_PROVENANCE_KEYS,
  } = {},
) {
  const target = parseCanonicalArtifact(targetCanonical, "targetEvidence");
  const targetEvidenceSha256 = sha256(targetCanonical);
  const releaseBinding = parseReleaseArtifacts(
    targetCanonical,
    intentEvidenceCanonical,
    executionEvidenceCanonical,
    steadyEvidenceCanonical,
    releaseEvidenceCanonical,
    activationApprovalCanonical,
  );
  const keyId = exactString(rawKeyId, "keyId");
  if (!KEY_ID.test(keyId)) {
    fail("PRODUCTION_HOST_KEY_INVALID", "keyId is invalid.");
  }
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    fail("PRODUCTION_HOST_NONCE_INVALID", "nonce must be 128-bit hex.");
  }
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs <= 0 ||
    lifetimeMs > MAX_ATTESTATION_LIFETIME_MS
  ) {
    fail(
      "PRODUCTION_HOST_TIME_INVALID",
      "Attestation lifetime exceeds the reviewed maximum.",
    );
  }
  requireEqual(
    releaseBinding.targetEvidenceSha256,
    targetEvidenceSha256,
    "releaseBinding.targetEvidenceSha256",
  );
  requireEqual(
    releaseBinding.sourceSha,
    target.build?.sourceSha,
    "releaseBinding.sourceSha",
  );
  const current = createProductionTargetEvidence(currentObservation, {
    now,
    trustedImageProvenanceKeys,
  });
  requireEqual(
    canonicalJson(stableTarget(current.target)),
    canonicalJson(stableTarget(target)),
    "currentObservation",
  );
  const observedAt = current.target.capturedAt;
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + lifetimeMs).toISOString();
  const attestation = {
    schemaVersion: HOST_ATTESTATION_SCHEMA,
    kind: HOST_ATTESTATION_KIND,
    runnerVersion: HOST_RUNNER_VERSION,
    keyId,
    sourceSha: releaseBinding.sourceSha,
    logicalEnvironmentId: PRODUCTION_TARGET.logicalEnvironmentId,
    coolify: {
      projectId: PRODUCTION_TARGET.projectId,
      environmentId: PRODUCTION_TARGET.environmentId,
      applicationId: PRODUCTION_TARGET.applicationId,
      environmentLabel: PRODUCTION_TARGET.environmentLabel,
    },
    targetEvidenceSha256,
    releaseEvidenceSha256: releaseBinding.releaseEvidenceSha256,
    activationApprovalSha256: releaseBinding.activationApprovalSha256,
    observedState: {
      deployedConfigSha256: target.coolify.deployedConfigSha256,
      desiredConfigSha256: target.coolify.desiredConfigSha256,
      resolvedComposeSha256: target.coolify.resolvedComposeSha256,
      apiImage: target.build.apiImage,
      postgresImage: target.livePostgresTarget.image,
      livePostgresTargetSha256: target.livePostgresTarget.projectionSha256,
      databaseName: target.database.name,
      databaseUser: target.database.user,
      schemaFingerprintSha256: target.schemaFingerprintSha256,
    },
    observedAt,
    issuedAt,
    expiresAt,
    nonce,
  };
  assertSecretFree(attestation, "hostAttestation");
  const canonical = canonicalJson(attestation);
  return Object.freeze({
    attestation: Object.freeze(attestation),
    canonical,
    sha256: sha256(canonical),
  });
}

export function verifyDetachedHostAttestation(
  {
    attestationCanonical,
    signature,
    publicKeyPem,
    expectedPublicKeySha256,
    expectedKeyId,
    expectedBinding,
    expectedTargetCanonical,
  },
  { now = Date.now() } = {},
) {
  const attestation = exactKeys(
    parseCanonicalArtifact(attestationCanonical, "hostAttestation"),
    [
      "schemaVersion",
      "kind",
      "runnerVersion",
      "keyId",
      "sourceSha",
      "logicalEnvironmentId",
      "coolify",
      "targetEvidenceSha256",
      "releaseEvidenceSha256",
      "activationApprovalSha256",
      "observedState",
      "observedAt",
      "issuedAt",
      "expiresAt",
      "nonce",
    ],
    "hostAttestation",
  );
  const keyId = exactString(expectedKeyId, "expectedKeyId");
  requireEqual(attestation.keyId, keyId, "hostAttestation.keyId");
  const signatureBytes = Buffer.isBuffer(signature)
    ? signature
    : Buffer.from(exactString(signature, "signature"), "base64");
  if (signatureBytes.length !== 64) {
    fail(
      "PRODUCTION_HOST_SIGNATURE_INVALID",
      "The Ed25519 detached signature must be 64 bytes.",
    );
  }
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    fail("PRODUCTION_HOST_KEY_INVALID", "The public key is invalid.");
  }
  requireEqual(
    sha256(publicKey.export({ type: "spki", format: "der" })),
    exactDigest(expectedPublicKeySha256, "expectedPublicKeySha256"),
    "publicKeySha256",
  );
  if (
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verifySignature(
      null,
      Buffer.from(attestationCanonical, "utf8"),
      publicKey,
      signatureBytes,
    )
  ) {
    fail(
      "PRODUCTION_HOST_SIGNATURE_INVALID",
      "Detached host attestation signature verification failed.",
    );
  }
  requireEqual(
    attestation.schemaVersion,
    HOST_ATTESTATION_SCHEMA,
    "hostAttestation.schemaVersion",
  );
  requireEqual(
    attestation.runnerVersion,
    HOST_RUNNER_VERSION,
    "hostAttestation.runnerVersion",
  );
  requireEqual(
    attestation.logicalEnvironmentId,
    PRODUCTION_TARGET.logicalEnvironmentId,
    "hostAttestation.logicalEnvironmentId",
  );
  const binding = {
    sourceSha: exactSha(expectedBinding.sourceSha, "expectedBinding.sourceSha"),
    targetEvidenceSha256: exactDigest(
      expectedBinding.targetEvidenceSha256,
      "expectedBinding.targetEvidenceSha256",
    ),
    releaseEvidenceSha256: exactDigest(
      expectedBinding.releaseEvidenceSha256,
      "expectedBinding.releaseEvidenceSha256",
    ),
    activationApprovalSha256: exactDigest(
      expectedBinding.activationApprovalSha256,
      "expectedBinding.activationApprovalSha256",
    ),
  };
  for (const key of Object.keys(binding)) {
    requireEqual(attestation[key], binding[key], `hostAttestation.${key}`);
  }
  const coolify = exactKeys(
    attestation.coolify,
    ["projectId", "environmentId", "applicationId", "environmentLabel"],
    "hostAttestation.coolify",
  );
  for (const key of [
    "projectId",
    "environmentId",
    "applicationId",
    "environmentLabel",
  ]) {
    requireEqual(
      coolify[key],
      PRODUCTION_TARGET[key],
      `hostAttestation.coolify.${key}`,
    );
  }
  const target = parseCanonicalArtifact(
    expectedTargetCanonical,
    "expectedTargetEvidence",
  );
  requireEqual(
    sha256(expectedTargetCanonical),
    binding.targetEvidenceSha256,
    "expectedTargetEvidenceSha256",
  );
  const observedState = exactKeys(
    attestation.observedState,
    [
      "deployedConfigSha256",
      "desiredConfigSha256",
      "resolvedComposeSha256",
      "apiImage",
      "postgresImage",
      "livePostgresTargetSha256",
      "databaseName",
      "databaseUser",
      "schemaFingerprintSha256",
    ],
    "hostAttestation.observedState",
  );
  const expectedObservedState = {
    deployedConfigSha256: target.coolify.deployedConfigSha256,
    desiredConfigSha256: target.coolify.desiredConfigSha256,
    resolvedComposeSha256: target.coolify.resolvedComposeSha256,
    apiImage: target.build.apiImage,
    postgresImage: target.livePostgresTarget.image,
    livePostgresTargetSha256: target.livePostgresTarget.projectionSha256,
    databaseName: target.database.name,
    databaseUser: target.database.user,
    schemaFingerprintSha256: target.schemaFingerprintSha256,
  };
  requireEqual(
    canonicalJson(observedState),
    canonicalJson(expectedObservedState),
    "hostAttestation.observedState",
  );
  requireEqual(attestation.kind, HOST_ATTESTATION_KIND, "hostAttestation.kind");
  const issuedAt = exactTime(attestation.issuedAt, "hostAttestation.issuedAt");
  const observedAt = exactTime(
    attestation.observedAt,
    "hostAttestation.observedAt",
  );
  const expiresAt = exactTime(
    attestation.expiresAt,
    "hostAttestation.expiresAt",
  );
  if (
    observedAt.millis > issuedAt.millis ||
    issuedAt.millis > now + MAX_CLOCK_SKEW_MS ||
    expiresAt.millis <= issuedAt.millis ||
    expiresAt.millis - issuedAt.millis > MAX_ATTESTATION_LIFETIME_MS ||
    now > expiresAt.millis ||
    now - observedAt.millis > MAX_ATTESTATION_LIFETIME_MS
  ) {
    fail(
      "PRODUCTION_HOST_ATTESTATION_EXPIRED",
      "The host attestation is stale, expired or temporally invalid.",
    );
  }
  if (
    !/^[0-9a-f]{32}$/.test(
      exactString(attestation.nonce, "hostAttestation.nonce"),
    )
  ) {
    fail("PRODUCTION_HOST_NONCE_INVALID", "nonce must be 128-bit hex.");
  }
  return Object.freeze({
    value: Object.freeze(attestation),
    sha256: sha256(attestationCanonical),
  });
}
