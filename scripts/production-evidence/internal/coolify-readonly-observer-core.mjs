import { randomBytes } from "node:crypto";

import {
  COOLIFY_EXPORT_SCHEMA,
  PRODUCTION_TARGET,
  assertSecretFree,
  canonicalJson,
  sha256,
} from "../host-attestation-contract.mjs";
import {
  PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING,
  PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256,
  readProductionCoolifyHostBridgeAttestation,
} from "./coolify-host-bridge-authority.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SERVER_CLOCK_SKEW_MS = 30_000;
const MAX_DEPLOYMENT_AGE_MS = 24 * 60 * 60_000;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const NONCE = /^[0-9a-f]{64}$/;
const EXPECTED_SERVICES = Object.freeze(["api", "postgres", "web"]);
const BRIDGE_SCHEMA = "site-logbook.coolify-host-bridge-attestation/v1";

export const PRODUCTION_COOLIFY_HTTPS_ORIGIN = "https://91.99.67.4:8000";
export const PRODUCTION_COOLIFY_OBSERVER_CONFIRMATION =
  "OBSERVE_FIXED_SITE_LOGBOOK_PRODUCTION_COOLIFY_READ_ONLY";

// These documented routes are retained for review and compatibility only. They
// are intentionally not used as authority because they cannot expose the
// encrypted deployment snapshot without also widening into sensitive data.
export const PRODUCTION_COOLIFY_READ_ONLY_PATHS = Object.freeze({
  application: `/api/v1/applications/${PRODUCTION_TARGET.applicationId}`,
  deployments: `/api/v1/deployments/applications/${PRODUCTION_TARGET.applicationId}?skip=0&take=10`,
});

export function productionCoolifyDeploymentReadOnlyPath(deploymentId) {
  if (typeof deploymentId !== "string" || !DEPLOYMENT_ID.test(deploymentId)) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_BINDING_INVALID",
      "Deployment id is invalid.",
    );
  }
  return `/api/v1/deployments/${deploymentId}`;
}

export class ProductionCoolifyObserverError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionCoolifyObserverError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionCoolifyObserverError(code, message);
}

function objectAt(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_COOLIFY_OBSERVER_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactKeys(value, expected, field) {
  const object = objectAt(value, field);
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_SCHEMA_INVALID",
      `${field} does not have the reviewed fields.`,
    );
  }
  return object;
}

function exactText(value, field) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail("PRODUCTION_COOLIFY_OBSERVER_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactDigest(value, field) {
  const text = exactText(value, field);
  if (!DIGEST.test(text) || /^sha256:0{64}$/.test(text)) {
    fail("PRODUCTION_COOLIFY_OBSERVER_BINDING_INVALID", `${field} is invalid.`);
  }
  return text;
}

function exactImage(value, field) {
  const text = exactText(value, field);
  if (!IMMUTABLE_IMAGE.test(text)) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_IMAGE_MUTABLE",
      `${field} must be an immutable image reference.`,
    );
  }
  return text;
}

function exactUtc(value, field) {
  const text = exactText(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || !text.endsWith("Z")) {
    fail("PRODUCTION_COOLIFY_OBSERVER_TIME_INVALID", `${field} is invalid.`);
  }
  return Object.freeze({ text, millis });
}

function exactTarget(value, field) {
  const target = exactKeys(
    value,
    ["applicationId", "environmentId", "environmentLabel", "projectId"],
    field,
  );
  for (const key of [
    "applicationId",
    "environmentId",
    "environmentLabel",
    "projectId",
  ]) {
    if (target[key] !== PRODUCTION_TARGET[key]) {
      fail(
        "PRODUCTION_COOLIFY_OBSERVER_TARGET_INVALID",
        `${field} is not the fixed production target.`,
      );
    }
  }
  return Object.freeze({ ...target });
}

function parseImages(value, field) {
  const images = exactKeys(value, EXPECTED_SERVICES, field);
  return Object.freeze(
    Object.fromEntries(
      EXPECTED_SERVICES.map((service) => [
        service,
        exactImage(images[service], `${field}.${service}`),
      ]),
    ),
  );
}

function expectedBinding(value) {
  const expected = exactKeys(
    value,
    [
      "configurationSha256",
      "deployedNotBefore",
      "deploymentId",
      "images",
      "resolvedComposeSha256",
      "revision",
    ],
    "request.expected",
  );
  const deploymentId = exactText(
    expected.deploymentId,
    "request.expected.deploymentId",
  );
  const revision = exactText(expected.revision, "request.expected.revision");
  if (!DEPLOYMENT_ID.test(deploymentId) || !REVISION.test(revision)) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_BINDING_INVALID",
      "Deployment or revision binding is invalid.",
    );
  }
  return Object.freeze({
    deploymentId,
    revision,
    deployedNotBefore: exactUtc(
      expected.deployedNotBefore,
      "request.expected.deployedNotBefore",
    ),
    configurationSha256: exactDigest(
      expected.configurationSha256,
      "request.expected.configurationSha256",
    ),
    resolvedComposeSha256: exactDigest(
      expected.resolvedComposeSha256,
      "request.expected.resolvedComposeSha256",
    ),
    images: parseImages(expected.images, "request.expected.images"),
  });
}

function parseObserverRequest(rawRequest) {
  const request = objectAt(rawRequest, "request");
  const required = ["confirmation", "expected", "signal"].sort();
  const withTimeout = [...required, "timeoutMs"].sort();
  const actual = Object.keys(request).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(required) &&
    JSON.stringify(actual) !== JSON.stringify(withTimeout)
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_REQUEST_INVALID",
      "The request must contain only reviewed fixed inputs.",
    );
  }
  if (request.confirmation !== PRODUCTION_COOLIFY_OBSERVER_CONFIRMATION) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_DARK",
      "The explicit read-only observation confirmation is required.",
    );
  }
  if (!(request.signal instanceof AbortSignal) || request.signal.aborted) {
    throw abortError();
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_REQUEST_INVALID",
      "timeoutMs is outside the reviewed bound.",
    );
  }
  const expected = expectedBinding(request.expected);
  assertSecretFree(expected, "request.expected");
  return Object.freeze({ request, expected, timeoutMs });
}

function parseControlPlane(value, field) {
  const controlPlane = exactKeys(
    value,
    [
      "bridgeSourceSha256",
      "containerId",
      "containerImage",
      "health",
      "imageId",
      "imageRef",
      "sourceCommitSha",
      "startedAt",
      "status",
      "version",
    ],
    field,
  );
  const expected = {
    ...PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING,
    bridgeSourceSha256: PRODUCTION_COOLIFY_HOST_BRIDGE_SOURCE_SHA256,
    health: "healthy",
    status: "running",
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (controlPlane[key] !== expectedValue) {
      fail(
        "PRODUCTION_COOLIFY_OBSERVER_CONTROL_PLANE_DRIFT",
        "The Coolify control plane no longer matches the reviewed source/image/runtime binding.",
      );
    }
  }
  return Object.freeze({ ...controlPlane });
}

function parseChallenge(value, expected, field, localNow) {
  const challenge = exactKeys(
    value,
    ["expiresAt", "issuedAt", "nonce", "ordinal", "serverTime"],
    field,
  );
  const issuedAt = exactUtc(challenge.issuedAt, `${field}.issuedAt`);
  const expiresAt = exactUtc(challenge.expiresAt, `${field}.expiresAt`);
  const serverTime = exactUtc(challenge.serverTime, `${field}.serverTime`);
  if (
    challenge.nonce !== expected.nonce ||
    challenge.ordinal !== expected.ordinal ||
    challenge.issuedAt !== expected.issuedAt ||
    challenge.expiresAt !== expected.expiresAt ||
    !NONCE.test(challenge.nonce) ||
    expiresAt.millis <= issuedAt.millis ||
    expiresAt.millis - issuedAt.millis > 90_000 ||
    serverTime.millis < issuedAt.millis - MAX_SERVER_CLOCK_SKEW_MS ||
    serverTime.millis > expiresAt.millis ||
    Math.abs(serverTime.millis - localNow) > MAX_SERVER_CLOCK_SKEW_MS
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_REPLAY",
      "The Coolify bridge challenge is stale, replayed or invalid.",
    );
  }
  return Object.freeze({
    nonce: challenge.nonce,
    ordinal: challenge.ordinal,
    issuedAt: issuedAt.text,
    expiresAt: expiresAt.text,
    serverTime: serverTime.text,
  });
}

function parseBridgeControlPlane(value, field) {
  const controlPlane = exactKeys(value, ["sourceCommitSha", "version"], field);
  if (
    controlPlane.version !== PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.version ||
    controlPlane.sourceCommitSha !==
      PRODUCTION_COOLIFY_CONTROL_PLANE_BINDING.sourceCommitSha
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_CONTROL_PLANE_DRIFT",
      "The bridge did not attest the reviewed Coolify source version.",
    );
  }
  return Object.freeze({ ...controlPlane });
}

function parseDeployment(value, field, localNow) {
  const deployment = exactKeys(
    value,
    ["deployedAt", "deploymentId", "pullRequestId", "revision", "status"],
    field,
  );
  const deploymentId = exactText(
    deployment.deploymentId,
    `${field}.deploymentId`,
  );
  const revision = exactText(deployment.revision, `${field}.revision`);
  const deployedAt = exactUtc(deployment.deployedAt, `${field}.deployedAt`);
  if (
    !DEPLOYMENT_ID.test(deploymentId) ||
    !REVISION.test(revision) ||
    deployment.status !== "finished" ||
    deployment.pullRequestId !== 0 ||
    deployedAt.millis > localNow + MAX_SERVER_CLOCK_SKEW_MS ||
    localNow - deployedAt.millis > MAX_DEPLOYMENT_AGE_MS
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_REPLAY",
      "The deployment identity, terminal state or timestamp is stale or invalid.",
    );
  }
  return Object.freeze({
    deploymentId,
    revision,
    deployedAt,
    status: deployment.status,
    pullRequestId: deployment.pullRequestId,
  });
}

function parseConfiguration(value, field) {
  const configuration = exactKeys(
    value,
    ["deployedSha256", "desiredSha256", "storedSnapshotSha256"],
    field,
  );
  return Object.freeze({
    desiredSha256: exactDigest(
      configuration.desiredSha256,
      `${field}.desiredSha256`,
    ),
    deployedSha256: exactDigest(
      configuration.deployedSha256,
      `${field}.deployedSha256`,
    ),
    storedSnapshotSha256: exactDigest(
      configuration.storedSnapshotSha256,
      `${field}.storedSnapshotSha256`,
    ),
  });
}

function parseResolvedCompose(value, field) {
  const compose = exactKeys(
    value,
    ["deployedSha256", "desiredSha256", "images"],
    field,
  );
  return Object.freeze({
    desiredSha256: exactDigest(compose.desiredSha256, `${field}.desiredSha256`),
    deployedSha256: exactDigest(
      compose.deployedSha256,
      `${field}.deployedSha256`,
    ),
    images: parseImages(compose.images, `${field}.images`),
  });
}

function parseCycle(value, expectedChallenge, localNow) {
  const envelope = exactKeys(
    value,
    ["bridge", "controlPlane"],
    "bridgeEnvelope",
  );
  const controlPlane = parseControlPlane(
    envelope.controlPlane,
    "bridgeEnvelope.controlPlane",
  );
  const bridge = exactKeys(
    envelope.bridge,
    [
      "challenge",
      "configuration",
      "controlPlane",
      "deployment",
      "pendingChanges",
      "resolvedCompose",
      "schemaVersion",
      "target",
    ],
    "bridgeAttestation",
  );
  if (bridge.schemaVersion !== BRIDGE_SCHEMA) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_SCHEMA_INVALID",
      "The Coolify bridge schema is not reviewed.",
    );
  }
  if (bridge.pendingChanges !== false) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_DRIFT",
      "Coolify reports unapplied production configuration changes.",
    );
  }
  const result = Object.freeze({
    challenge: parseChallenge(
      bridge.challenge,
      expectedChallenge,
      "bridgeAttestation.challenge",
      localNow,
    ),
    controlPlane,
    bridgeControlPlane: parseBridgeControlPlane(
      bridge.controlPlane,
      "bridgeAttestation.controlPlane",
    ),
    target: exactTarget(bridge.target, "bridgeAttestation.target"),
    pendingChanges: false,
    deployment: parseDeployment(
      bridge.deployment,
      "bridgeAttestation.deployment",
      localNow,
    ),
    configuration: parseConfiguration(
      bridge.configuration,
      "bridgeAttestation.configuration",
    ),
    resolvedCompose: parseResolvedCompose(
      bridge.resolvedCompose,
      "bridgeAttestation.resolvedCompose",
    ),
  });
  assertSecretFree(result, "coolifyBridgeAttestation");
  return result;
}

function stableCycle(cycle) {
  return Object.freeze({
    controlPlane: cycle.controlPlane,
    bridgeControlPlane: cycle.bridgeControlPlane,
    target: cycle.target,
    pendingChanges: cycle.pendingChanges,
    deployment: Object.freeze({
      ...cycle.deployment,
      deployedAt: cycle.deployment.deployedAt.text,
    }),
    configuration: cycle.configuration,
    resolvedCompose: cycle.resolvedCompose,
  });
}

function deriveConfig(cycle, expected) {
  const { configuration, deployment, resolvedCompose } = cycle;
  if (
    configuration.desiredSha256 !== configuration.deployedSha256 ||
    configuration.deployedSha256 !== configuration.storedSnapshotSha256 ||
    resolvedCompose.desiredSha256 !== resolvedCompose.deployedSha256 ||
    deployment.deploymentId !== expected.deploymentId ||
    deployment.revision !== expected.revision ||
    deployment.deployedAt.millis < expected.deployedNotBefore.millis ||
    configuration.desiredSha256 !== expected.configurationSha256 ||
    resolvedCompose.desiredSha256 !== expected.resolvedComposeSha256 ||
    canonicalJson(resolvedCompose.images) !== canonicalJson(expected.images)
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_DRIFT",
      "Authoritative deployment or configuration drift was observed.",
    );
  }
  return Object.freeze({
    configurationSha256: configuration.desiredSha256,
    resolvedComposeSha256: resolvedCompose.desiredSha256,
    images: resolvedCompose.images,
  });
}

function abortError() {
  return new ProductionCoolifyObserverError(
    "PRODUCTION_COOLIFY_OBSERVER_ABORTED",
    "The bounded read-only observation was aborted.",
  );
}

function abortable(operation, signal) {
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(operation).then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function readClock(now) {
  let value;
  try {
    value = now();
  } catch {
    fail("PRODUCTION_COOLIFY_OBSERVER_TIME_INVALID", "Clock is invalid.");
  }
  if (!Number.isFinite(value)) {
    fail("PRODUCTION_COOLIFY_OBSERVER_TIME_INVALID", "Clock is invalid.");
  }
  return value;
}

function createChallenge(startedAt, timeoutMs, random) {
  let bytes;
  try {
    bytes = random(32);
  } catch {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_AUTHORITY_UNAVAILABLE",
      "The fresh challenge source is unavailable.",
    );
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_AUTHORITY_UNAVAILABLE",
      "The fresh challenge source is invalid.",
    );
  }
  return Object.freeze({
    nonce: Buffer.from(bytes).toString("hex"),
    issuedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(
      startedAt + timeoutMs + MAX_SERVER_CLOCK_SKEW_MS,
    ).toISOString(),
  });
}

async function readAuthority(readAttestation, request, signal) {
  try {
    return await abortable(
      readAttestation({ challenge: request, signal }),
      signal,
    );
  } catch (error) {
    if (
      signal.aborted ||
      error?.name === "AbortError" ||
      error?.code === "ABORT_ERR"
    ) {
      throw abortError();
    }
    throw new ProductionCoolifyObserverError(
      "PRODUCTION_COOLIFY_OBSERVER_TRANSPORT_FAILURE",
      "The source/image-pinned read-only Coolify host authority could not be read.",
    );
  }
}

async function observationCycle(
  readAttestation,
  challenge,
  ordinal,
  signal,
  now,
) {
  const expectedChallenge = Object.freeze({ ...challenge, ordinal });
  const raw = await readAuthority(readAttestation, expectedChallenge, signal);
  return parseCycle(raw, expectedChallenge, readClock(now));
}

async function collectCoolifyReadOnlyExportCore(
  rawRequest,
  {
    readAttestation,
    now = () => Date.now(),
    random = (size) => randomBytes(size),
  },
) {
  const { request, expected, timeoutMs } = parseObserverRequest(rawRequest);
  if (
    typeof readAttestation !== "function" ||
    typeof now !== "function" ||
    typeof random !== "function"
  ) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_AUTHORITY_UNAVAILABLE",
      "The Coolify host authority is unavailable.",
    );
  }
  const startedAt = readClock(now);
  const challenge = createChallenge(startedAt, timeoutMs, random);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    const first = await observationCycle(
      readAttestation,
      challenge,
      1,
      signal,
      now,
    );
    const second = await observationCycle(
      readAttestation,
      challenge,
      2,
      signal,
      now,
    );
    if (
      canonicalJson(stableCycle(first)) !== canonicalJson(stableCycle(second))
    ) {
      fail(
        "PRODUCTION_COOLIFY_OBSERVER_RACE",
        "The authoritative Coolify projection changed between fresh observations.",
      );
    }
    const config = deriveConfig(second, expected);
    const completedAt = readClock(now);
    if (
      !Number.isFinite(completedAt) ||
      completedAt < startedAt ||
      completedAt - startedAt > timeoutMs
    ) {
      fail(
        "PRODUCTION_COOLIFY_OBSERVER_TIME_INVALID",
        "The observation exceeded its reviewed time bound.",
      );
    }
    const result = Object.freeze({
      schemaVersion: COOLIFY_EXPORT_SCHEMA,
      observedAt: new Date(completedAt).toISOString(),
      projectId: PRODUCTION_TARGET.projectId,
      environmentId: PRODUCTION_TARGET.environmentId,
      environmentLabel: PRODUCTION_TARGET.environmentLabel,
      applicationId: PRODUCTION_TARGET.applicationId,
      pendingChanges: false,
      desiredConfig: config,
      deployedConfig: config,
    });
    assertSecretFree(result, "coolifyExport");
    const canonical = canonicalJson(result);
    return Object.freeze({
      value: result,
      canonical,
      sha256: sha256(canonical),
    });
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCoolifyReadOnlyExport(rawRequest) {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_COOLIFY_OBSERVER_REQUEST_INVALID",
      "The production observer does not accept transport, command or clock dependencies.",
    );
  }
  return collectCoolifyReadOnlyExportCore(rawRequest, {
    readAttestation: readProductionCoolifyHostBridgeAttestation,
  });
}

export function collectCoolifyReadOnlyExportWithTestAuthority(
  rawRequest,
  dependencies,
) {
  return collectCoolifyReadOnlyExportCore(rawRequest, dependencies);
}
