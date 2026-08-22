import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  DOCKER_EXPORT_SCHEMA,
  assertSecretFree,
  canonicalJson,
} from "./host-attestation-contract.mjs";

const execFile = promisify(execFileCallback);
const MAX_DOCKER_OUTPUT_BYTES = 8 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const CONTAINER_PROJECTION_TEMPLATE = [
  '{"Id":{{json .Id}},"Name":{{json .Name}},',
  '"Config":{"Image":{{json .Config.Image}},"Labels":{',
  '"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},',
  '"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}},',
  '"Image":{{json .Image}},"State":{"Status":{{json .State.Status}}},',
  '"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}}}',
].join("");
const VOLUME_PROJECTION_TEMPLATE =
  '{"Name":{{json .Name}},"Driver":{{json .Driver}}}';
const NETWORK_PROJECTION_TEMPLATE =
  '{"Name":{{json .Name}},"Id":{{json .Id}},"Driver":{{json .Driver}},"Internal":{{json .Internal}},"Containers":{{json .Containers}}}';

function fail(message) {
  throw new Error(`PRODUCTION_HOST_DOCKER_OBSERVER_INVALID: ${message}`);
}

async function defaultRunDocker(args) {
  const { stdout } = await execFile("docker", args, {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
    timeout: 30_000,
  });
  return stdout;
}

function parseJson(raw, field) {
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${field} returned invalid JSON.`);
  }
}

function exactText(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is missing.`);
  return value;
}

function containerProjection(container) {
  const labels = container.Config?.Labels ?? {};
  return {
    containerId: exactText(container.Id, "container.Id"),
    name: exactText(container.Name, "container.Name").replace(/^\//, ""),
    composeProject: exactText(
      labels["com.docker.compose.project"],
      "container.composeProject",
    ),
    service: exactText(
      labels["com.docker.compose.service"],
      "container.service",
    ),
    state: exactText(container.State?.Status, "container.state"),
    image: exactText(container.Config?.Image, "container.image"),
    imageId: exactText(container.Image, "container.imageId"),
  };
}

async function listAllContainerIds(runDocker) {
  const ids = (
    await runDocker(["container", "ls", "--all", "--quiet", "--no-trunc"])
  )
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (ids.some((id) => !HEX64.test(id))) {
    fail("docker container ls returned a non-canonical container id.");
  }
  return ids.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function inspectAllContainers(runDocker, ids) {
  const containers = [];
  for (const id of ids) {
    const inspected = parseJson(
      await runDocker([
        "container",
        "inspect",
        "--format",
        CONTAINER_PROJECTION_TEMPLATE,
        id,
      ]),
      "docker container inspect",
    );
    if (
      !inspected ||
      typeof inspected !== "object" ||
      Array.isArray(inspected)
    ) {
      fail("docker container inspect did not return one projected container.");
    }
    containers.push(inspected);
  }
  return containers;
}

/**
 * Acquires only Docker inventory with read-only `ls` and `inspect` verbs.
 * Coolify and PostgreSQL remain explicit, credential-free raw exports.
 */
export async function collectDockerReadOnlyExport(
  request,
  { runDocker = defaultRunDocker, now = () => Date.now() } = {},
) {
  assertSecretFree(request, "request");
  const composeProject = exactText(
    request.composeProject,
    "request.composeProject",
  );
  const postgresService = exactText(
    request.postgresService,
    "request.postgresService",
  );
  const startedAt = now();
  const initialIds = await listAllContainerIds(runDocker);
  const containers = await inspectAllContainers(runDocker, initialIds);
  const targets = containers.filter((container) => {
    const labels = container.Config?.Labels ?? {};
    return (
      labels["com.docker.compose.project"] === composeProject &&
      labels["com.docker.compose.service"] === postgresService
    );
  });
  if (targets.length !== 1) {
    fail("exactly one reviewed Postgres service container is required.");
  }
  const target = targets[0];
  const targetPeer = containerProjection(target);
  const mounts = Array.isArray(target.Mounts) ? target.Mounts : [];
  const volumeMounts = mounts.filter((mount) => mount.Type === "volume");
  if (volumeMounts.length !== 1) {
    fail("the Postgres target must have exactly one named volume mount.");
  }
  const volumeName = exactText(volumeMounts[0].Name, "target.volumeName");
  const targetNetworks = Object.entries(target.NetworkSettings?.Networks ?? {});
  if (targetNetworks.length !== 1) {
    fail("the Postgres target must have exactly one network attachment.");
  }
  const [networkName, targetNetwork] = targetNetworks[0];
  const networkId = exactText(targetNetwork.NetworkID, "target.networkId");
  if (!DOCKER_NAME.test(volumeName) || !DOCKER_NAME.test(networkName)) {
    fail("Docker volume or network name is not canonical.");
  }
  if (!HEX64.test(networkId)) {
    fail("Docker network id is not canonical.");
  }

  const volumeInspect = parseJson(
    await runDocker([
      "volume",
      "inspect",
      "--format",
      VOLUME_PROJECTION_TEMPLATE,
      volumeName,
    ]),
    "docker volume inspect",
  );
  if (
    !volumeInspect ||
    typeof volumeInspect !== "object" ||
    Array.isArray(volumeInspect)
  ) {
    fail("docker volume inspect did not return one projected volume.");
  }
  const networkInspect = parseJson(
    await runDocker([
      "network",
      "inspect",
      "--format",
      NETWORK_PROJECTION_TEMPLATE,
      networkName,
    ]),
    "docker network inspect",
  );
  if (
    !networkInspect ||
    typeof networkInspect !== "object" ||
    Array.isArray(networkInspect)
  ) {
    fail("docker network inspect did not return one projected network.");
  }
  if (networkInspect.Id !== networkId) {
    fail("target attachment and inspected network id differ.");
  }
  const attachedNetworkIds = Object.keys(networkInspect.Containers ?? {}).sort(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );
  const projectedNetworkIds = containers
    .filter((container) =>
      Object.values(container.NetworkSettings?.Networks ?? {}).some(
        (network) => network.NetworkID === networkId,
      ),
    )
    .map((container) => container.Id)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    JSON.stringify(attachedNetworkIds) !== JSON.stringify(projectedNetworkIds)
  ) {
    fail("network peer membership changed during the bounded observation.");
  }
  const hasVolume = (container) =>
    (container.Mounts ?? []).some(
      (mount) => mount.Type === "volume" && mount.Name === volumeName,
    );
  const hasNetwork = (container) =>
    Object.values(container.NetworkSettings?.Networks ?? {}).some(
      (network) => network.NetworkID === networkId,
    );
  const relevantContainers = (items) =>
    items.filter((container) => hasVolume(container) || hasNetwork(container));
  const initialRelevantContainers = relevantContainers(containers);
  const finalIds = await listAllContainerIds(runDocker);
  const finalContainers = await inspectAllContainers(runDocker, finalIds);
  if (
    canonicalJson(relevantContainers(finalContainers)) !==
    canonicalJson(initialRelevantContainers)
  ) {
    fail("the relevant Docker container projection changed during observation.");
  }
  const finalNetworkInspect = parseJson(
    await runDocker([
      "network",
      "inspect",
      "--format",
      NETWORK_PROJECTION_TEMPLATE,
      networkName,
    ]),
    "final docker network inspect",
  );
  if (canonicalJson(finalNetworkInspect) !== canonicalJson(networkInspect)) {
    fail("the Docker network projection changed during observation.");
  }
  const completedAt = now();
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    completedAt < startedAt ||
    completedAt - startedAt > 60_000
  ) {
    fail("Docker observation exceeded its reviewed 60 second bound.");
  }

  const byContainerId = (left, right) => {
    const a = left.containerId;
    const b = right.containerId;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const result = {
    schemaVersion: DOCKER_EXPORT_SCHEMA,
    observedAt: new Date(completedAt).toISOString(),
    composeProject,
    targetContainer: {
      id: targetPeer.containerId,
      name: targetPeer.name,
      service: targetPeer.service,
      image: exactText(target.Config?.Image, "target.image"),
      imageId: exactText(target.Image, "target.imageId"),
      state: targetPeer.state,
      mounts: volumeMounts.map((mount) => ({
        type: mount.Type,
        name: mount.Name,
        destination: mount.Destination,
        readOnly: mount.RW === false,
      })),
      networks: [{ name: networkName, id: networkId }],
    },
    volume: {
      name: exactText(volumeInspect.Name, "volume.name"),
      driver: exactText(volumeInspect.Driver, "volume.driver"),
    },
    network: {
      name: exactText(networkInspect.Name, "network.name"),
      id: exactText(networkInspect.Id, "network.id"),
      driver: exactText(networkInspect.Driver, "network.driver"),
      internal: networkInspect.Internal === true,
    },
    volumePeers: containers
      .filter(hasVolume)
      .map(containerProjection)
      .sort(byContainerId),
    networkPeers: containers
      .filter(hasNetwork)
      .map(containerProjection)
      .sort(byContainerId),
  };
  assertSecretFree(result, "dockerExport");
  return Object.freeze({
    value: Object.freeze(result),
    canonical: canonicalJson(result),
  });
}
