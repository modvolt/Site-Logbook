import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import {
  auditSchemaFingerprintSha256,
  canonicalAuditSchemaCatalogProjection,
  type AuditSchemaCatalogProjection,
} from "@workspace/db/audit-schema-preflight";

// @ts-ignore -- host-only Docker observer is bundled outside the API rootDir.
import { collectDockerReadOnlyExport } from "../../../../scripts/production-evidence/docker-readonly-observer.mjs";

const execFile = promisify(execFileCallback);
const POSTGRES_EXPORT_SCHEMA =
  "site-logbook.production-host-postgres-export/v2";
const DOCKER_EXPORT_SCHEMA = "site-logbook.production-host-docker-export/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DOCKER_FRESHNESS_MS = 5_000;
const MAX_DB_CLOCK_SKEW_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_JOURNAL_ROWS = 512;
const LOCAL_POSTGRES_SOCKET_DIRECTORY = "/var/run/postgresql";
const LOCAL_POSTGRES_PORT = 5432;
const CLEAN_EXEC_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const FORBIDDEN_KEY =
  /(password|passwd|secret|token|credential|private.?key|database.?url|connection.?string|access.?key|session|cookie)/i;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|SCRAM-SHA-256\$[0-9]{3,10}:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}|github_pat_|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._~+/-]+=*|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/i;
const PRODUCTION_NETWORK_SERVICES = Object.freeze(["api", "postgres", "web"]);
const COOLIFY_PROXY_PROJECT = "coolify-proxy";
const COOLIFY_PROXY_SERVICE = "traefik";
const COOLIFY_PROXY_IMAGE = "traefik:v3.6";

export const PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION =
  "OBSERVE_EXACT_SITE_LOGBOOK_PRODUCTION_DOCKER_AUTHORITY_READ_ONLY";
export const PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION =
  "OBSERVE_BOUND_SITE_LOGBOOK_PRODUCTION_POSTGRES_READ_ONLY";

type JsonObject = Record<string, unknown>;

export interface ProductionHostJournalRow {
  createdAt: number;
  hash: string;
}

export interface VerifiedProductionHostDockerAuthority {
  readonly canonical: string;
  readonly sha256: string;
  readonly observedAt: string;
  readonly composeProject: string;
  readonly postgresService: string;
  readonly containerId: string;
  readonly volumeDestination: string;
}

export interface ProductionHostDockerAuthorityRequest {
  confirmation: string;
  composeProject: string;
  postgresService: "postgres";
  expectedPostgresImage: string;
  postgresVolumeDestination: string;
  expectedNetworkServices: readonly ["api", "postgres", "web"];
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface ProductionHostPostgresObserverRequest {
  confirmation: string;
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
  expectedJournalRows: readonly ProductionHostJournalRow[];
  dockerAuthority: VerifiedProductionHostDockerAuthority;
  signal: AbortSignal;
  timeoutMs?: number;
}

interface ProductionHostDockerCommandOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProductionHostPostgresObserverTestDependencies {
  runDocker?: (
    args: readonly string[],
    options: ProductionHostDockerCommandOptions,
  ) => Promise<string>;
  now?: () => number;
}

type DockerAuthorityValidationBinding = Pick<
  ProductionHostDockerAuthorityRequest,
  | "composeProject"
  | "expectedNetworkServices"
  | "expectedPostgresImage"
  | "postgresService"
  | "postgresVolumeDestination"
>;

const verifiedDockerAuthorities = new WeakSet<object>();
const verifiedDockerAuthorityBindings = new WeakMap<
  object,
  DockerAuthorityValidationBinding
>();

export class ProductionHostPostgresObserverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProductionHostPostgresObserverError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductionHostPostgresObserverError(code, message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalProductionHostPostgresJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSecretFree(value: unknown, field = "output"): void {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_SECRET_MATERIAL",
        `${field} contains secret-shaped material.`,
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
  for (const [key, entry] of Object.entries(value as JsonObject)) {
    if (FORBIDDEN_KEY.test(key)) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_SECRET_MATERIAL",
        `${field} contains a forbidden secret field.`,
      );
    }
    assertSecretFree(entry, `${field}.${key}`);
  }
}

function objectAt(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_POSTGRES_OBSERVER_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): JsonObject {
  const object = objectAt(value, field);
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_SCHEMA_INVALID",
      `${field} does not contain the reviewed fields.`,
    );
  }
  return object;
}

function exactText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail("PRODUCTION_POSTGRES_OBSERVER_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactIdentifier(value: unknown, field: string): string {
  const text = exactText(value, field);
  if (!IDENTIFIER.test(text)) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_BINDING_INVALID",
      `${field} is invalid.`,
    );
  }
  return text;
}

function exactDigest(value: unknown, field: string): string {
  const text = exactText(value, field);
  if (!DIGEST.test(text) || /^sha256:0{64}$/.test(text)) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_BINDING_INVALID",
      `${field} is invalid.`,
    );
  }
  return text;
}

function exactContainerId(value: unknown, field: string): string {
  const text = exactText(value, field);
  if (!HEX64.test(text) || /^0{64}$/.test(text)) {
    fail("PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID", `${field} is invalid.`);
  }
  return text;
}

function exactImage(value: unknown, field: string): string {
  const text = exactText(value, field);
  if (!IMMUTABLE_IMAGE.test(text)) {
    fail("PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID", `${field} is invalid.`);
  }
  return text;
}

function exactUtc(
  value: unknown,
  field: string,
): { text: string; millis: number } {
  const text = exactText(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis) || !text.endsWith("Z")) {
    fail("PRODUCTION_POSTGRES_OBSERVER_TIME_INVALID", `${field} is invalid.`);
  }
  return { text, millis };
}

function readClock(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    fail("PRODUCTION_POSTGRES_OBSERVER_TIME_INVALID", "Clock is invalid.");
  }
  if (!Number.isFinite(value)) {
    fail("PRODUCTION_POSTGRES_OBSERVER_TIME_INVALID", "Clock is invalid.");
  }
  return value;
}

function abortError(): ProductionHostPostgresObserverError {
  return new ProductionHostPostgresObserverError(
    "PRODUCTION_POSTGRES_OBSERVER_ABORTED",
    "The bounded read-only observation was aborted.",
  );
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

async function defaultRunDocker(
  args: readonly string[],
  options: ProductionHostDockerCommandOptions,
): Promise<string> {
  if (
    (process.env.DOCKER_HOST ?? "") !== "" ||
    !["", "default"].includes(process.env.DOCKER_CONTEXT ?? "")
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REMOTE_DOCKER_REJECTED",
      "Remote Docker host or context overrides are forbidden.",
    );
  }
  const dockerEnvironment = Object.fromEntries(
    [
      "PATH",
      "PATHEXT",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOME",
    ]
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const { stdout } = await execFile("docker", [...args], {
    encoding: "utf8",
    env: dockerEnvironment,
    maxBuffer: options.maxOutputBytes,
    signal: options.signal,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return stdout;
}

async function verifyDefaultLocalDockerContext(
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const options = { signal, timeoutMs, maxOutputBytes: 64 * 1024 };
  let context: string;
  let endpoint: string;
  try {
    context = (await defaultRunDocker(["context", "show"], options)).trim();
    endpoint = (
      await defaultRunDocker(
        [
          "context",
          "inspect",
          "default",
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ],
        options,
      )
    ).trim();
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (error instanceof ProductionHostPostgresObserverError) throw error;
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_LOCAL_DOCKER_UNVERIFIED",
      "The local default Docker authority could not be verified.",
    );
  }
  let parsedEndpoint: unknown;
  try {
    parsedEndpoint = JSON.parse(endpoint);
  } catch {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_LOCAL_DOCKER_UNVERIFIED",
      "The local default Docker endpoint projection is invalid.",
    );
  }
  if (
    context !== "default" ||
    (parsedEndpoint !== "unix:///var/run/docker.sock" &&
      parsedEndpoint !== "npipe:////./pipe/docker_engine")
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REMOTE_DOCKER_REJECTED",
      "Only the local default Docker engine is allowed.",
    );
  }
}

function parsePeer(value: unknown, field: string) {
  const peer = exactKeys(
    value,
    [
      "composeProject",
      "containerId",
      "image",
      "imageId",
      "name",
      "service",
      "state",
    ],
    field,
  );
  exactText(peer.name, `${field}.name`);
  const composeProject = exactText(
    peer.composeProject,
    `${field}.composeProject`,
  );
  const service = exactText(peer.service, `${field}.service`);
  const isCoolifyProxy =
    composeProject === COOLIFY_PROXY_PROJECT &&
    service === COOLIFY_PROXY_SERVICE;
  return Object.freeze({
    containerId: exactContainerId(peer.containerId, `${field}.containerId`),
    composeProject,
    service,
    state: exactText(peer.state, `${field}.state`),
    image: isCoolifyProxy
      ? exactText(peer.image, `${field}.image`)
      : exactImage(peer.image, `${field}.image`),
    imageId: exactDigest(peer.imageId, `${field}.imageId`),
  });
}

function validateRawTargetMountProjection(
  raw: string,
  args: readonly string[],
  request: Pick<
    ProductionHostDockerAuthorityRequest,
    "composeProject" | "postgresService" | "postgresVolumeDestination"
  >,
): void {
  if (args[0] !== "container" || args[1] !== "inspect") return;
  let projection: JsonObject;
  try {
    projection = objectAt(JSON.parse(raw), "dockerInspectProjection");
  } catch (error) {
    if (error instanceof ProductionHostPostgresObserverError) throw error;
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker inspect did not return the reviewed target projection.",
    );
  }
  const config = objectAt(projection.Config, "dockerInspectProjection.Config");
  const labels = objectAt(
    config.Labels,
    "dockerInspectProjection.Config.Labels",
  );
  if (
    labels["com.docker.compose.project"] !== request.composeProject ||
    labels["com.docker.compose.service"] !== request.postgresService
  ) {
    return;
  }
  if (!Array.isArray(projection.Mounts) || projection.Mounts.length !== 1) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "The Postgres target has an unreviewed bind, tmpfs, or extra mount.",
    );
  }
  const mount = objectAt(
    projection.Mounts[0],
    "dockerInspectProjection.Mounts[0]",
  );
  if (
    mount.Type !== "volume" ||
    mount.Destination !== request.postgresVolumeDestination ||
    mount.RW !== true
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "The Postgres target mount is not the sole reviewed writable volume.",
    );
  }
}

function validateDockerArtifact(
  value: unknown,
  canonical: string,
  request: DockerAuthorityValidationBinding,
  verifiedAt: number,
): VerifiedProductionHostDockerAuthority {
  if (canonicalProductionHostPostgresJson(value) !== canonical) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority is not canonical JSON.",
    );
  }
  assertSecretFree(value, "dockerAuthority");
  const docker = exactKeys(
    value,
    [
      "composeProject",
      "network",
      "networkPeers",
      "observedAt",
      "schemaVersion",
      "targetContainer",
      "volume",
      "volumePeers",
    ],
    "dockerAuthority",
  );
  if (
    docker.schemaVersion !== DOCKER_EXPORT_SCHEMA ||
    docker.composeProject !== request.composeProject
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority target differs from the reviewed project.",
    );
  }
  const observedAt = exactUtc(docker.observedAt, "dockerAuthority.observedAt");
  if (
    observedAt.millis > verifiedAt + 1_000 ||
    verifiedAt - observedAt.millis > MAX_DOCKER_FRESHNESS_MS
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_STALE",
      "Docker authority is outside the freshness bound.",
    );
  }
  const volume = exactKeys(
    docker.volume,
    ["driver", "name"],
    "dockerAuthority.volume",
  );
  const volumeName = exactText(volume.name, "dockerAuthority.volume.name");
  if (volume.driver !== "local") {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority volume driver is not local.",
    );
  }
  const network = exactKeys(
    docker.network,
    ["driver", "id", "internal", "name"],
    "dockerAuthority.network",
  );
  const networkName = exactText(network.name, "dockerAuthority.network.name");
  const networkId = exactContainerId(network.id, "dockerAuthority.network.id");
  if (network.driver !== "bridge" || typeof network.internal !== "boolean") {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority network projection is invalid.",
    );
  }
  const target = exactKeys(
    docker.targetContainer,
    [
      "id",
      "image",
      "imageId",
      "mounts",
      "name",
      "networks",
      "service",
      "state",
    ],
    "dockerAuthority.targetContainer",
  );
  const containerId = exactContainerId(
    target.id,
    "dockerAuthority.targetContainer.id",
  );
  const targetImage = exactImage(
    target.image,
    "dockerAuthority.targetContainer.image",
  );
  const targetImageId = exactDigest(
    target.imageId,
    "dockerAuthority.targetContainer.imageId",
  );
  if (
    targetImage !== request.expectedPostgresImage ||
    target.service !== request.postgresService ||
    target.state !== "running" ||
    !Array.isArray(target.mounts) ||
    target.mounts.length !== 1 ||
    !Array.isArray(target.networks) ||
    target.networks.length !== 1
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority target is not the exact running Postgres service.",
    );
  }
  const mount = exactKeys(
    target.mounts[0],
    ["destination", "name", "readOnly", "type"],
    "dockerAuthority.targetContainer.mounts[0]",
  );
  if (
    mount.type !== "volume" ||
    mount.name !== volumeName ||
    mount.destination !== request.postgresVolumeDestination ||
    mount.readOnly !== false
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority volume mount differs from the reviewed writable target.",
    );
  }
  const attachment = exactKeys(
    target.networks[0],
    ["id", "name"],
    "dockerAuthority.targetContainer.networks[0]",
  );
  if (attachment.id !== networkId || attachment.name !== networkName) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority network attachment differs from the reviewed target.",
    );
  }
  if (
    !Array.isArray(docker.volumePeers) ||
    !Array.isArray(docker.networkPeers)
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "Docker authority peer projections are invalid.",
    );
  }
  const volumePeers = docker.volumePeers.map((peer, index) =>
    parsePeer(peer, `dockerAuthority.volumePeers[${index}]`),
  );
  const networkPeers = docker.networkPeers.map((peer, index) =>
    parsePeer(peer, `dockerAuthority.networkPeers[${index}]`),
  );
  const exactTargetPeer = (peer: (typeof volumePeers)[number]) =>
    peer.containerId === containerId &&
    peer.composeProject === request.composeProject &&
    peer.service === request.postgresService &&
    peer.state === "running" &&
    peer.image === targetImage &&
    peer.imageId === targetImageId;
  const applicationNetworkPeers = networkPeers.filter(
    (peer) => peer.composeProject === request.composeProject,
  );
  const infrastructureNetworkPeers = networkPeers.filter(
    (peer) => peer.composeProject !== request.composeProject,
  );
  const services = applicationNetworkPeers
    .map((peer) => peer.service)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    volumePeers.length !== 1 ||
    !exactTargetPeer(volumePeers[0]) ||
    applicationNetworkPeers.length !== PRODUCTION_NETWORK_SERVICES.length ||
    JSON.stringify(services) !== JSON.stringify(PRODUCTION_NETWORK_SERVICES) ||
    new Set(networkPeers.map((peer) => peer.containerId)).size !==
      networkPeers.length ||
    applicationNetworkPeers.some(
      (peer) =>
        peer.composeProject !== request.composeProject ||
        peer.state !== "running",
    ) ||
    applicationNetworkPeers.filter(exactTargetPeer).length !== 1 ||
    infrastructureNetworkPeers.length > 1 ||
    infrastructureNetworkPeers.some(
      (peer) =>
        peer.composeProject !== COOLIFY_PROXY_PROJECT ||
        peer.service !== COOLIFY_PROXY_SERVICE ||
        peer.image !== COOLIFY_PROXY_IMAGE ||
        peer.state !== "running",
    )
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_FOREIGN_PEER",
      "Docker volume or network contains an unreviewed peer.",
    );
  }
  const exportSha256 = sha256(canonical);
  return Object.freeze({
    canonical,
    sha256: exportSha256,
    observedAt: observedAt.text,
    composeProject: request.composeProject,
    postgresService: request.postgresService,
    containerId,
    volumeDestination: request.postgresVolumeDestination,
  });
}

function registerDockerAuthority(
  authority: VerifiedProductionHostDockerAuthority,
  binding: DockerAuthorityValidationBinding,
): VerifiedProductionHostDockerAuthority {
  verifiedDockerAuthorities.add(authority);
  verifiedDockerAuthorityBindings.set(
    authority,
    Object.freeze({
      composeProject: binding.composeProject,
      expectedNetworkServices: Object.freeze([
        ...binding.expectedNetworkServices,
      ]) as readonly ["api", "postgres", "web"],
      expectedPostgresImage: binding.expectedPostgresImage,
      postgresService: binding.postgresService,
      postgresVolumeDestination: binding.postgresVolumeDestination,
    }),
  );
  return authority;
}

function revalidateDockerAuthority(
  authority: VerifiedProductionHostDockerAuthority,
  verifiedAt: number,
): VerifiedProductionHostDockerAuthority {
  if (
    !authority ||
    typeof authority !== "object" ||
    !Object.isFrozen(authority) ||
    !verifiedDockerAuthorities.has(authority)
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_AUTHORITY_REQUIRED",
      "One module-issued Docker authority is required.",
    );
  }
  const binding = verifiedDockerAuthorityBindings.get(authority);
  if (!binding) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_AUTHORITY_REQUIRED",
      "The Docker authority binding is unavailable.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(authority.canonical);
  } catch {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "The Docker authority canonical payload is invalid.",
    );
  }
  const revalidated = validateDockerArtifact(
    value,
    authority.canonical,
    binding,
    verifiedAt,
  );
  if (
    revalidated.sha256 !== authority.sha256 ||
    revalidated.observedAt !== authority.observedAt ||
    revalidated.composeProject !== authority.composeProject ||
    revalidated.postgresService !== authority.postgresService ||
    revalidated.containerId !== authority.containerId ||
    revalidated.volumeDestination !== authority.volumeDestination
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_INVALID",
      "The Docker authority projection changed after issuance.",
    );
  }
  return revalidated;
}

async function observeProductionHostDockerAuthorityCore(
  request: ProductionHostDockerAuthorityRequest,
  dependencies: ProductionHostPostgresObserverTestDependencies = {},
): Promise<VerifiedProductionHostDockerAuthority> {
  const required = [
    "composeProject",
    "confirmation",
    "expectedNetworkServices",
    "expectedPostgresImage",
    "postgresService",
    "postgresVolumeDestination",
    "signal",
  ].sort();
  const withTimeout = [...required, "timeoutMs"].sort();
  const actual = Object.keys(objectAt(request, "dockerRequest")).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(required) &&
    JSON.stringify(actual) !== JSON.stringify(withTimeout)
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "Docker authority request contains an unreviewed field.",
    );
  }
  if (request.confirmation !== PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DARK",
      "Explicit Docker read-only authority confirmation is required.",
    );
  }
  if (!(request.signal instanceof AbortSignal) || request.signal.aborted) {
    throw abortError();
  }
  if (
    request.postgresService !== "postgres" ||
    JSON.stringify(request.expectedNetworkServices) !==
      JSON.stringify(PRODUCTION_NETWORK_SERVICES)
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "Docker authority must use the source-pinned production service set.",
    );
  }
  const composeProject = exactText(request.composeProject, "composeProject");
  const expectedPostgresImage = exactImage(
    request.expectedPostgresImage,
    "expectedPostgresImage",
  );
  const postgresVolumeDestination = exactText(
    request.postgresVolumeDestination,
    "postgresVolumeDestination",
  );
  if (!postgresVolumeDestination.startsWith("/")) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "Postgres volume destination must be absolute.",
    );
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "timeoutMs is outside the reviewed bound.",
    );
  }
  const runDocker = dependencies.runDocker ?? defaultRunDocker;
  const now = dependencies.now ?? (() => Date.now());
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    if (dependencies.runDocker === undefined) {
      await verifyDefaultLocalDockerContext(signal, timeoutMs);
    }
    let artifact: { value: unknown; canonical: string };
    try {
      artifact = await collectDockerReadOnlyExport(
        { composeProject, postgresService: request.postgresService },
        {
          runDocker: async (args: readonly string[]) => {
            let raw: string;
            try {
              raw = await abortable(
                runDocker(args, {
                  signal,
                  timeoutMs,
                  maxOutputBytes: MAX_OUTPUT_BYTES,
                }),
                signal,
              );
            } catch {
              if (signal.aborted) throw abortError();
              fail(
                "PRODUCTION_POSTGRES_OBSERVER_DOCKER_AUTHORITY_FAILURE",
                "The bounded host Docker authority could not be observed.",
              );
            }
            validateRawTargetMountProjection(raw, args, {
              composeProject,
              postgresService: request.postgresService,
              postgresVolumeDestination,
            });
            return raw;
          },
          now: () => readClock(now),
        },
      );
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof ProductionHostPostgresObserverError) throw error;
      throw new ProductionHostPostgresObserverError(
        "PRODUCTION_POSTGRES_OBSERVER_DOCKER_AUTHORITY_FAILURE",
        "The bounded host Docker authority could not be observed.",
      );
    }
    const verifiedAt = readClock(now);
    const binding = Object.freeze({
      composeProject,
      expectedNetworkServices: Object.freeze([
        ...request.expectedNetworkServices,
      ]) as readonly ["api", "postgres", "web"],
      expectedPostgresImage,
      postgresService: request.postgresService,
      postgresVolumeDestination,
    });
    return registerDockerAuthority(
      validateDockerArtifact(
        artifact.value,
        artifact.canonical,
        binding,
        verifiedAt,
      ),
      binding,
    );
  } finally {
    clearTimeout(timer);
  }
}

function expectedJournalRows(
  value: unknown,
): readonly ProductionHostJournalRow[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_JOURNAL_ROWS
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_JOURNAL_INVALID",
      "The reviewed journal is empty or outside its row bound.",
    );
  }
  const rows = value.map((entry, index) => {
    const row = exactKeys(
      entry,
      ["createdAt", "hash"],
      `expectedJournalRows[${index}]`,
    );
    if (
      !Number.isSafeInteger(row.createdAt) ||
      Number(row.createdAt) <= 0 ||
      typeof row.hash !== "string" ||
      !HEX64.test(row.hash)
    ) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_JOURNAL_INVALID",
        "A reviewed journal row is invalid.",
      );
    }
    return Object.freeze({ createdAt: Number(row.createdAt), hash: row.hash });
  });
  if (
    new Set(rows.map((row) => `${row.createdAt}:${row.hash}`)).size !==
    rows.length
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_JOURNAL_INVALID",
      "The reviewed journal contains a duplicate row.",
    );
  }
  return Object.freeze(rows);
}

const POSTGRES_OBSERVATION_SQL = String.raw`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object(
  'identity', (SELECT row_to_json(identity_row) FROM (
    SELECT current_database()::text AS database_name,
           current_user::text AS database_user,
           current_setting('data_directory')::text AS data_directory,
           current_setting('server_version')::text AS server_version,
           current_setting('server_version_num')::integer AS server_version_num,
           current_setting('transaction_isolation')::text AS isolation_level,
           current_setting('transaction_read_only')::text AS transaction_read_only,
           current_setting('port')::integer AS server_port,
           inet_client_addr()::text AS client_address,
           inet_server_addr()::text AS server_address,
           inet_server_port()::integer AS server_tcp_port,
           pg_backend_pid()::integer AS backend_pid,
           to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS postmaster_started_at,
           to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at
  ) identity_row),
  'journal', (SELECT COALESCE(json_agg(row_to_json(journal_row)), '[]'::json) FROM (
    SELECT created_at::text AS created_at, hash::text AS hash
      FROM drizzle.__drizzle_migrations ORDER BY id
  ) journal_row),
  'catalog', json_build_object(
    'schemaVersion', 'site-logbook.audit-schema-catalog/v1',
    'namespaces', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name,
             pg_get_userbyid(n.nspowner) AS owner,
             COALESCE(to_jsonb(n.nspacl), '[]'::jsonb) AS acl
        FROM pg_namespace n WHERE n.nspname = 'public' ORDER BY n.nspname
    ) q),
    'tables', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             c.relkind::text AS relation_kind, c.relpersistence::text AS persistence,
             pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS row_security,
             c.relforcerowsecurity AS force_row_security,
             c.relreplident::text AS replica_identity,
             COALESCE(to_jsonb(c.reloptions), '[]'::jsonb) AS reloptions,
             COALESCE(to_jsonb(c.relacl), '[]'::jsonb) AS acl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
       ORDER BY n.nspname, c.relname
    ) q),
    'columns', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             a.attnum AS ordinal, a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             NOT a.attnotnull AS nullable,
             pg_get_expr(d.adbin, d.adrelid, true) AS default_expression,
             a.attidentity::text AS identity_kind,
             a.attgenerated::text AS generated_kind,
             a.attstorage::text AS storage_kind,
             a.attcompression::text AS compression_kind,
             CASE WHEN a.attcollation = 0 THEN NULL
                  ELSE quote_ident(cn.nspname) || '.' || quote_ident(co.collname) END AS collation,
             COALESCE(to_jsonb(a.attoptions), '[]'::jsonb) AS options,
             COALESCE(to_jsonb(a.attacl), '[]'::jsonb) AS acl
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        LEFT JOIN pg_collation co ON co.oid = a.attcollation
        LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
         AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY n.nspname, c.relname, a.attnum
    ) q),
    'functions', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name, p.proname AS function_name,
             pg_get_function_identity_arguments(p.oid) AS identity_arguments,
             pg_get_functiondef(p.oid) AS definition,
             pg_get_function_result(p.oid) AS return_type,
             l.lanname AS language, p.prokind::text AS function_kind,
             p.provolatile::text AS volatility, p.proparallel::text AS parallel_safety,
             p.prosecdef AS security_definer, p.proleakproof AS leakproof,
             p.proisstrict AS strict, p.proretset AS returns_set,
             pg_get_userbyid(p.proowner) AS owner,
             COALESCE(to_jsonb(p.proconfig), '[]'::jsonb) AS configuration,
             COALESCE(to_jsonb(p.proacl), '[]'::jsonb) AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = 'public'
         AND (p.proname LIKE 'audit\_%' ESCAPE '\'
           OR p.proname LIKE 'guard_audit\_%' ESCAPE '\'
           OR p.proname LIKE 'deny_audit\_%' ESCAPE '\')
       ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
    ) q),
    'constraints', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             con.conname AS constraint_name, con.contype::text AS constraint_type,
             con.convalidated AS validated, con.condeferrable AS deferrable,
             con.condeferred AS initially_deferred, con.connoinherit AS no_inherit,
             CASE WHEN con.conindid = 0 THEN NULL ELSE con.conindid::regclass::text END AS backing_index,
             pg_get_constraintdef(con.oid, true) AS definition
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
         AND con.contype <> 't'
       ORDER BY n.nspname, c.relname, con.conname
    ) q),
    'indexes', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             i.relname AS index_name, x.indisunique AS unique_index,
             x.indisprimary AS primary_index, x.indisvalid AS valid,
             x.indisready AS ready, x.indislive AS live,
             x.indisreplident AS replica_identity,
             pg_get_indexdef(i.oid) AS definition,
             pg_get_userbyid(i.relowner) AS owner, am.amname AS access_method,
             COALESCE(to_jsonb(i.reloptions), '[]'::jsonb) AS reloptions,
             COALESCE(to_jsonb(i.relacl), '[]'::jsonb) AS acl
        FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_class c ON c.oid = x.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_am am ON am.oid = i.relam
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
       ORDER BY n.nspname, c.relname, i.relname
    ) q),
    'triggers', (SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json) FROM (
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             t.tgname AS trigger_name, t.tgenabled::text AS enabled,
             pn.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS function_identity,
             (con.oid IS NOT NULL) AS constraint_trigger,
             COALESCE(con.condeferrable, false) AS deferrable,
             COALESCE(con.condeferred, false) AS initially_deferred,
             pg_get_triggerdef(t.oid, true) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace pn ON pn.oid = p.pronamespace
        LEFT JOIN pg_constraint con ON con.oid = t.tgconstraint
       WHERE n.nspname = 'public'
         AND c.relname = ANY (ARRAY['audit_chain_heads','audit_events','audit_export_outbox'])
         AND NOT t.tgisinternal
       ORDER BY n.nspname, c.relname, t.tgname
    ) q)
  )
)::text;
ROLLBACK;`;

function parseDatabaseProjection(raw: string): {
  identity: JsonObject;
  journal: readonly ProductionHostJournalRow[];
  catalog: AuditSchemaCatalogProjection;
} {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") < 2 ||
    Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DATABASE_INVALID",
      "The exact container database projection is unavailable.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DATABASE_INVALID",
      "The exact container database projection is invalid.",
    );
  }
  const projection = exactKeys(
    parsed,
    ["catalog", "identity", "journal"],
    "databaseProjection",
  );
  const identity = exactKeys(
    projection.identity,
    [
      "backend_pid",
      "client_address",
      "data_directory",
      "database_name",
      "database_user",
      "isolation_level",
      "observed_at",
      "postmaster_started_at",
      "server_address",
      "server_port",
      "server_tcp_port",
      "server_version",
      "server_version_num",
      "transaction_read_only",
    ],
    "databaseProjection.identity",
  );
  if (!Array.isArray(projection.journal)) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_JOURNAL_INVALID",
      "The live journal projection is invalid.",
    );
  }
  const journal = projection.journal.map((entry, index) => {
    const row = exactKeys(
      entry,
      ["created_at", "hash"],
      `databaseProjection.journal[${index}]`,
    );
    const createdAt = Number(row.created_at);
    if (
      typeof row.created_at !== "string" ||
      !/^[1-9][0-9]*$/.test(row.created_at) ||
      !Number.isSafeInteger(createdAt) ||
      typeof row.hash !== "string" ||
      !HEX64.test(row.hash)
    ) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_JOURNAL_INVALID",
        "The live journal contains an invalid row.",
      );
    }
    return Object.freeze({ createdAt, hash: row.hash });
  });
  let catalog: AuditSchemaCatalogProjection;
  try {
    catalog = canonicalAuditSchemaCatalogProjection(
      projection.catalog as unknown as AuditSchemaCatalogProjection,
    );
  } catch {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DATABASE_INVALID",
      "The live audit catalog projection is invalid.",
    );
  }
  return { identity, journal, catalog };
}

function validateIdentity(
  identity: JsonObject,
  input: {
    containerId: string;
    databaseName: string;
    databaseUser: string;
    dockerExportSha256: string;
    now: number;
    volumeDestination: string;
  },
): { serverVersion: string; backendProofSha256: string } {
  const observedAt = exactUtc(identity.observed_at, "identity.observed_at");
  const postmasterStartedAt = exactUtc(
    identity.postmaster_started_at,
    "identity.postmaster_started_at",
  );
  if (
    identity.client_address !== null ||
    identity.server_address !== null ||
    identity.server_tcp_port !== null ||
    identity.data_directory !== input.volumeDestination ||
    identity.database_name !== input.databaseName ||
    identity.database_user !== input.databaseUser ||
    typeof identity.server_version_num !== "number" ||
    !Number.isSafeInteger(identity.server_version_num) ||
    Math.floor(identity.server_version_num / 10_000) !== 16 ||
    typeof identity.server_version !== "string" ||
    !/^16(?:\.[0-9]+)+(?:[-+~.A-Za-z0-9]*)?$/.test(identity.server_version) ||
    identity.isolation_level !== "repeatable read" ||
    identity.transaction_read_only !== "on" ||
    identity.server_port !== LOCAL_POSTGRES_PORT ||
    typeof identity.backend_pid !== "number" ||
    !Number.isSafeInteger(identity.backend_pid) ||
    identity.backend_pid <= 0 ||
    Math.abs(observedAt.millis - input.now) > MAX_DB_CLOCK_SKEW_MS ||
    postmasterStartedAt.millis > observedAt.millis ||
    postmasterStartedAt.millis > input.now + MAX_DB_CLOCK_SKEW_MS
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_IDENTITY_INVALID",
      "The exact container backend does not match DB/current_user/PG16/RR-RO/port.",
    );
  }
  return {
    serverVersion: identity.server_version,
    backendProofSha256: sha256(
      canonicalProductionHostPostgresJson({
        containerId: input.containerId,
        dockerExportSha256: input.dockerExportSha256,
        transport: {
          cleanEnvironment: true,
          dataDirectory: input.volumeDestination,
          host: LOCAL_POSTGRES_SOCKET_DIRECTORY,
          port: LOCAL_POSTGRES_PORT,
          unixSocket: true,
        },
        identity,
      }),
    ),
  };
}

async function collectProductionHostPostgresExportCore(
  request: ProductionHostPostgresObserverRequest,
  dependencies: ProductionHostPostgresObserverTestDependencies = {},
) {
  const required = [
    "confirmation",
    "databaseName",
    "databaseUser",
    "dockerAuthority",
    "expectedJournalRows",
    "schemaFingerprintSha256",
    "signal",
  ].sort();
  const withTimeout = [...required, "timeoutMs"].sort();
  const actual = Object.keys(objectAt(request, "request")).sort();
  if (
    JSON.stringify(actual) !== JSON.stringify(required) &&
    JSON.stringify(actual) !== JSON.stringify(withTimeout)
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "The request contains an unreviewed field.",
    );
  }
  if (request.confirmation !== PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DARK",
      "The explicit read-only observation confirmation is required.",
    );
  }
  if (!(request.signal instanceof AbortSignal) || request.signal.aborted) {
    throw abortError();
  }
  const databaseName = exactIdentifier(request.databaseName, "databaseName");
  const databaseUser = exactIdentifier(request.databaseUser, "databaseUser");
  const expectedFingerprint = exactDigest(
    request.schemaFingerprintSha256,
    "schemaFingerprintSha256",
  );
  const reviewedJournal = expectedJournalRows(request.expectedJournalRows);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > DEFAULT_TIMEOUT_MS
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "timeoutMs is outside the reviewed bound.",
    );
  }
  const runDocker = dependencies.runDocker ?? defaultRunDocker;
  const now = dependencies.now ?? (() => Date.now());
  const startedAt = readClock(now);
  const dockerAuthority = revalidateDockerAuthority(
    request.dockerAuthority,
    startedAt,
  );
  const dockerObservedAt = exactUtc(
    dockerAuthority.observedAt,
    "dockerAuthority.observedAt",
  );
  if (
    dockerObservedAt.millis > startedAt + 1_000 ||
    startedAt - dockerObservedAt.millis > MAX_DOCKER_FRESHNESS_MS
  ) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_DOCKER_STALE",
      "Docker authority expired before the DB observation.",
    );
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  timer.unref?.();
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    if (dependencies.runDocker === undefined) {
      await verifyDefaultLocalDockerContext(signal, timeoutMs);
    }
    const args = Object.freeze([
      "container",
      "exec",
      dockerAuthority.containerId,
      "/usr/bin/env",
      "-i",
      `PATH=${CLEAN_EXEC_PATH}`,
      "LC_ALL=C",
      "psql",
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--dbname",
      databaseName,
      "--username",
      databaseUser,
      "--host",
      LOCAL_POSTGRES_SOCKET_DIRECTORY,
      "--port",
      String(LOCAL_POSTGRES_PORT),
      "--command",
      POSTGRES_OBSERVATION_SQL,
    ]);
    let raw: string;
    try {
      raw = await abortable(
        runDocker(args, {
          signal,
          timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        }),
        signal,
      );
    } catch {
      if (signal.aborted) throw abortError();
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_DATABASE_TRANSPORT_FAILURE",
        "The exact container PostgreSQL read-only projection could not be read.",
      );
    }
    const projection = parseDatabaseProjection(raw);
    const measuredAt = readClock(now);
    const identity = validateIdentity(projection.identity, {
      containerId: dockerAuthority.containerId,
      databaseName,
      databaseUser,
      dockerExportSha256: dockerAuthority.sha256,
      now: measuredAt,
      volumeDestination: dockerAuthority.volumeDestination,
    });
    if (
      canonicalProductionHostPostgresJson(projection.journal) !==
      canonicalProductionHostPostgresJson(reviewedJournal)
    ) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_JOURNAL_DRIFT",
        "The live migration journal differs from the exact reviewed lineage.",
      );
    }
    const fingerprint = auditSchemaFingerprintSha256(projection.catalog);
    if (fingerprint !== expectedFingerprint) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_FINGERPRINT_DRIFT",
        "The live audit schema fingerprint differs from the reviewed binding.",
      );
    }
    const completedAt = readClock(now);
    if (
      !Number.isFinite(completedAt) ||
      completedAt < startedAt ||
      completedAt - startedAt > timeoutMs
    ) {
      fail(
        "PRODUCTION_POSTGRES_OBSERVER_TIME_INVALID",
        "The read-only observation exceeded its reviewed time bound.",
      );
    }
    const value = Object.freeze({
      schemaVersion: POSTGRES_EXPORT_SCHEMA,
      observedAt: new Date(completedAt).toISOString(),
      containerId: dockerAuthority.containerId,
      dockerExportSha256: dockerAuthority.sha256,
      backendProofSha256: identity.backendProofSha256,
      databaseName,
      databaseUser,
      schemaFingerprintSha256: fingerprint,
      serverVersion: identity.serverVersion,
      readOnlyObservation: true as const,
    });
    assertSecretFree(value, "postgresExport");
    const canonical = canonicalProductionHostPostgresJson(value);
    return Object.freeze({ value, canonical, sha256: sha256(canonical) });
  } finally {
    clearTimeout(timer);
  }
}

export async function observeProductionHostDockerAuthority(
  request: ProductionHostDockerAuthorityRequest,
): Promise<VerifiedProductionHostDockerAuthority> {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "The production Docker observer does not accept command or clock dependencies.",
    );
  }
  return observeProductionHostDockerAuthorityCore(request);
}

export async function collectProductionHostPostgresExport(
  request: ProductionHostPostgresObserverRequest,
) {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_POSTGRES_OBSERVER_REQUEST_INVALID",
      "The production PostgreSQL observer does not accept command or clock dependencies.",
    );
  }
  return collectProductionHostPostgresExportCore(request);
}

export function observeProductionHostDockerAuthorityWithTestAuthority(
  request: ProductionHostDockerAuthorityRequest,
  dependencies: ProductionHostPostgresObserverTestDependencies,
) {
  return observeProductionHostDockerAuthorityCore(request, dependencies);
}

export function collectProductionHostPostgresExportWithTestAuthority(
  request: ProductionHostPostgresObserverRequest,
  dependencies: ProductionHostPostgresObserverTestDependencies,
) {
  return collectProductionHostPostgresExportCore(request, dependencies);
}

export function assertProductionHostPostgresSecretFreeWithTestAuthority(
  value: unknown,
): void {
  assertSecretFree(value, "testProjection");
}

