import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";

import {
  auditSchemaFingerprintSha256,
  canonicalAuditSchemaCatalogProjection,
  type AuditSchemaCatalogProjection,
} from "../../lib/db/src/audit-schema-preflight.js";
import {
  PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION,
  PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION,
  collectProductionHostPostgresExport,
  observeProductionHostDockerAuthority,
} from "../../artifacts/api-server/src/production-host-postgres-observer.js";

const execFile = promisify(execFileCallback);
const OPT_IN =
  process.env.PRODUCTION_HOST_POSTGRES_OBSERVER_PG16_DISPOSABLE_CONFIRM;
const DISPOSABLE_CONFIRMATION =
  "I_CONFIRM_SELF_OWNED_DISPOSABLE_LOCAL_PG16_OBSERVER_FIXTURE";
const IMAGE =
  "docker.io/library/postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const FIXTURE_LABEL = "site-logbook-production-host-postgres-observer-pg16";
const DATABASE = "postgres_observer_fixture";
const USER = "postgres_observer_fixture_admin";
const JOURNAL = Object.freeze([
  Object.freeze({ createdAt: 1_700_000_000_000, hash: "e".repeat(64) }),
]);
const fixtureCatalog = canonicalAuditSchemaCatalogProjection({
  schemaVersion: "site-logbook.audit-schema-catalog/v1",
  namespaces: [
    {
      schema_name: "public",
      owner: "pg_database_owner",
      acl: ["pg_database_owner=UC/pg_database_owner", "=U/pg_database_owner"],
    },
  ],
  tables: [],
  columns: [],
  functions: [],
  constraints: [],
  indexes: [],
  triggers: [],
} as AuditSchemaCatalogProjection);
const FINGERPRINT = auditSchemaFingerprintSha256(fixtureCatalog);

export function assertProductionHostPostgresObserverPg16OptIn(
  confirmation: unknown,
  env: NodeJS.ProcessEnv,
): void {
  if (
    confirmation !== DISPOSABLE_CONFIRMATION ||
    (env.DOCKER_HOST ?? "") !== "" ||
    !["", "default"].includes(env.DOCKER_CONTEXT ?? "")
  ) {
    throw new Error("POSTGRES_OBSERVER_PG16_DISPOSABLE_CONFIRMATION_REQUIRED");
  }
}

function localDockerEnvironment(
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
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
    ),
    ...extra,
  };
}

async function docker(
  args: readonly string[],
  env: NodeJS.ProcessEnv = localDockerEnvironment(),
): Promise<string> {
  const { stdout } = await execFile("docker", [...args], {
    encoding: "utf8",
    env,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return stdout.trim();
}

type FixtureDockerRunner = (args: readonly string[]) => Promise<string>;

interface Pg16FixtureOwnership {
  runId: string;
  containerNames: readonly string[];
  networkName: string;
  volumeName: string;
}

const CONTAINER_OR_NETWORK_ID = /^[0-9a-f]{64}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function inventoryLines(raw: string, pattern: RegExp, field: string): string[] {
  const values = raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  assert.equal(new Set(values).size, values.length, `${field} is duplicated`);
  for (const value of values) {
    assert.match(value, pattern, `${field} is non-canonical`);
  }
  return values.sort();
}

async function ownedInventory(
  kind: "container" | "network" | "volume",
  runId: string,
  runDocker: FixtureDockerRunner,
): Promise<string[]> {
  const args = [
    kind,
    "ls",
    "--quiet",
    "--filter",
    `label=com.modvolt.fixture=${FIXTURE_LABEL}`,
    "--filter",
    `label=com.modvolt.fixture-run=${runId}`,
  ];
  if (kind === "container") args.splice(2, 0, "--all", "--no-trunc");
  if (kind === "network") args.splice(2, 0, "--no-trunc");
  return inventoryLines(
    await runDocker(args),
    kind === "volume" ? VOLUME_NAME : CONTAINER_OR_NETWORK_ID,
    `${kind} cleanup inventory`,
  );
}

function parseOwnedProjection(
  raw: string,
  kind: "container" | "network" | "volume",
  runId: string,
): { id: string; name: string } {
  const value = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(value.Fixture, FIXTURE_LABEL);
  assert.equal(value.Run, runId);
  const name = String(value.Name ?? "").replace(/^\//, "");
  const id = String(kind === "volume" ? value.Name : value.Id);
  assert.match(id, kind === "volume" ? VOLUME_NAME : CONTAINER_OR_NETWORK_ID);
  assert.match(name, VOLUME_NAME);
  return { id, name };
}

export async function cleanupProductionHostPostgresObserverPg16Fixture(
  ownership: Pg16FixtureOwnership,
  runDocker: FixtureDockerRunner = docker,
): Promise<void> {
  const errors: unknown[] = [];
  const expectedNames = {
    container: new Set(ownership.containerNames),
    network: new Set([ownership.networkName]),
    volume: new Set([ownership.volumeName]),
  } as const;
  const projections = {
    container:
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Fixture":{{json (index .Config.Labels "com.modvolt.fixture")}},"Run":{{json (index .Config.Labels "com.modvolt.fixture-run")}}}',
    network:
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Fixture":{{json (index .Labels "com.modvolt.fixture")}},"Run":{{json (index .Labels "com.modvolt.fixture-run")}}}',
    volume:
      '{"Name":{{json .Name}},"Fixture":{{json (index .Labels "com.modvolt.fixture")}},"Run":{{json (index .Labels "com.modvolt.fixture-run")}}}',
  } as const;

  for (const kind of ["container", "network", "volume"] as const) {
    let resources: string[] = [];
    try {
      resources = await ownedInventory(kind, ownership.runId, runDocker);
    } catch (error) {
      errors.push(error);
      continue;
    }
    for (const resource of resources) {
      try {
        const projection = parseOwnedProjection(
          await runDocker([
            kind,
            "inspect",
            "--format",
            projections[kind],
            resource,
          ]),
          kind,
          ownership.runId,
        );
        assert.ok(
          expectedNames[kind].has(projection.name),
          `refusing unreviewed ${kind} ${projection.name}`,
        );
        await runDocker([
          kind,
          "rm",
          ...(kind === "container" ? ["--force"] : []),
          projection.id,
        ]);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  for (const kind of ["container", "network", "volume"] as const) {
    try {
      assert.deepEqual(
        await ownedInventory(kind, ownership.runId, runDocker),
        [],
        `${kind} cleanup inventory is not empty`,
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "POSTGRES_OBSERVER_PG16_FIXTURE_CLEANUP_FAILED",
    );
  }
}

async function assertLocalDefaultDockerContext(): Promise<void> {
  const context = await docker(["context", "show"]);
  assert.equal(context, "default");
  const endpoint = JSON.parse(
    await docker([
      "context",
      "inspect",
      "default",
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ]),
  );
  assert.ok(
    endpoint === "unix:///var/run/docker.sock" ||
      endpoint === "npipe:////./pipe/docker_engine",
  );
}

interface PostgresWaitOptions {
  runDocker?: FixtureDockerRunner;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
}

async function waitForPostgres(
  containerName: string,
  {
    runDocker = docker,
    now = Date.now,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    timeoutMs = 30_000,
  }: PostgresWaitOptions = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const pidOneComm = await runDocker([
        "container",
        "exec",
        containerName,
        "cat",
        "/proc/1/comm",
      ]);
      if (pidOneComm === "postgres") {
        const binding = await runDocker([
          "container",
          "exec",
          containerName,
          "psql",
          "--no-psqlrc",
          "--set=ON_ERROR_STOP=1",
          "--dbname",
          DATABASE,
          "--username",
          USER,
          "--tuples-only",
          "--no-align",
          "--field-separator=|",
          "--command",
          "SELECT current_database(), current_user;",
        ]);
        if (binding === `${DATABASE}|${USER}`) return;
      }
    } catch {
      // The image can accept sockets before entrypoint creates and hands off POSTGRES_DB.
    }
    await sleep(250);
  }
  throw new Error("POSTGRES_OBSERVER_PG16_FIXTURE_NOT_READY");
}

test("PG16 observer rejects non-opt-in, remote DOCKER_HOST and non-default context", () => {
  for (const [confirmation, env] of [
    [undefined, {}],
    ["true", {}],
    [DISPOSABLE_CONFIRMATION, { DOCKER_HOST: "tcp://production:2375" }],
    [DISPOSABLE_CONFIRMATION, { DOCKER_HOST: "ssh://production" }],
    [DISPOSABLE_CONFIRMATION, { DOCKER_CONTEXT: "remote-production" }],
  ] as const) {
    assert.throws(
      () =>
        assertProductionHostPostgresObserverPg16OptIn(
          confirmation,
          env as NodeJS.ProcessEnv,
        ),
      /POSTGRES_OBSERVER_PG16_DISPOSABLE_CONFIRMATION_REQUIRED/,
    );
  }
  assert.doesNotThrow(() =>
    assertProductionHostPostgresObserverPg16OptIn(DISPOSABLE_CONFIRMATION, {}),
  );
});

test("PG16 readiness requires the exact database and user before continuing", async () => {
  const calls: string[][] = [];
  let now = 0;
  const responses: Array<string | Error> = [
    "docker-entrypoi",
    "postgres",
    new Error("database does not exist"),
    "postgres",
    `${DATABASE}|foreign_role`,
    "postgres",
    `${DATABASE}|${USER}`,
  ];
  await waitForPostgres("fixture-postgres", {
    now: () => now,
    runDocker: async (args) => {
      calls.push([...args]);
      const response = responses.shift();
      assert.ok(response);
      if (response instanceof Error) throw response;
      return response;
    },
    sleep: async () => {
      now += 1;
    },
    timeoutMs: 4,
  });
  const pidOneProbe = [
    "container",
    "exec",
    "fixture-postgres",
    "cat",
    "/proc/1/comm",
  ];
  const bindingProbe = [
    "container",
    "exec",
    "fixture-postgres",
    "psql",
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--dbname",
    DATABASE,
    "--username",
    USER,
    "--tuples-only",
    "--no-align",
    "--field-separator=|",
    "--command",
    "SELECT current_database(), current_user;",
  ];
  assert.deepEqual(calls, [
    pidOneProbe,
    pidOneProbe,
    bindingProbe,
    pidOneProbe,
    bindingProbe,
    pidOneProbe,
    bindingProbe,
  ]);
  assert.equal(calls.flat().includes("pg_isready"), false);
});

test("PG16 readiness remains bounded when the exact binding never appears", async () => {
  let now = 0;
  let attempts = 0;
  await assert.rejects(
    () =>
      waitForPostgres("fixture-postgres", {
        now: () => now,
        runDocker: async () => {
          attempts += 1;
          throw new Error("database does not exist");
        },
        sleep: async (delayMs) => {
          now += delayMs;
        },
        timeoutMs: 500,
      }),
    /POSTGRES_OBSERVER_PG16_FIXTURE_NOT_READY/,
  );
  assert.equal(attempts, 2);
});

test("PG16 cleanup records failures, continues per resource and verifies empty inventories", async () => {
  const runId = "a".repeat(24);
  const containerId = "1".repeat(64);
  const networkId = "2".repeat(64);
  const volumeName = `sl-observer-data-${runId}`;
  const state = {
    container: new Set([containerId]),
    network: new Set([networkId]),
    volume: new Set([volumeName]),
  };
  const names = {
    container: `sl-observer-postgres-${runId}`,
    network: `sl-observer-net-${runId}`,
    volume: volumeName,
  } as const;
  const removals: string[] = [];
  const runDocker: FixtureDockerRunner = async (args) => {
    const kind = args[0] as keyof typeof state;
    if (args[1] === "ls") return [...state[kind]].join("\n");
    if (args[1] === "inspect") {
      return JSON.stringify({
        Id: kind === "volume" ? undefined : args.at(-1),
        Name: names[kind],
        Fixture: FIXTURE_LABEL,
        Run: runId,
      });
    }
    if (args[1] === "rm") {
      removals.push(kind);
      if (kind === "container") throw new Error("synthetic remove failure");
      state[kind].clear();
      return "";
    }
    throw new Error(`unexpected cleanup command: ${args.join(" ")}`);
  };

  await assert.rejects(
    cleanupProductionHostPostgresObserverPg16Fixture(
      {
        runId,
        containerNames: [names.container],
        networkName: names.network,
        volumeName,
      },
      runDocker,
    ),
    /POSTGRES_OBSERVER_PG16_FIXTURE_CLEANUP_FAILED/,
  );
  assert.deepEqual(removals, ["container", "network", "volume"]);
  assert.deepEqual([...state.network], []);
  assert.deepEqual([...state.volume], []);
  assert.deepEqual([...state.container], [containerId]);
});

test(
  "self-owns capped PG16 topology and proves Docker-authority plus docker-exec DB binding",
  { skip: OPT_IN === undefined, timeout: 240_000 },
  async () => {
    assertProductionHostPostgresObserverPg16OptIn(OPT_IN, process.env);
    await assertLocalDefaultDockerContext();
    const runId = randomBytes(12).toString("hex");
    const composeProject = `observer_${runId}`;
    const networkName = `sl-observer-net-${runId}`;
    const volumeName = `sl-observer-data-${runId}`;
    const containerNames = {
      api: `sl-observer-api-${runId}`,
      postgres: `sl-observer-postgres-${runId}`,
      web: `sl-observer-web-${runId}`,
    } as const;
    const password = randomBytes(32).toString("base64url");
    let executionError: unknown;
    let cleanupError: unknown;
    try {
      const networkId = await docker([
        "network",
        "create",
        "--driver",
        "bridge",
        "--label",
        `com.modvolt.fixture=${FIXTURE_LABEL}`,
        "--label",
        `com.modvolt.fixture-run=${runId}`,
        networkName,
      ]);
      assert.match(networkId, /^[0-9a-f]{64}$/);

      const createdVolume = await docker([
        "volume",
        "create",
        "--driver",
        "local",
        "--label",
        `com.modvolt.fixture=${FIXTURE_LABEL}`,
        "--label",
        `com.modvolt.fixture-run=${runId}`,
        volumeName,
      ]);
      assert.equal(createdVolume, volumeName);

      const inherited = localDockerEnvironment({
        POSTGRES_DB: DATABASE,
        POSTGRES_USER: USER,
        POSTGRES_PASSWORD: password,
        POSTGRES_INITDB_ARGS: "--auth-host=scram-sha-256",
      });
      const postgresId = await docker(
        [
          "run",
          "--detach",
          "--rm",
          "--name",
          containerNames.postgres,
          "--network",
          networkName,
          "--label",
          `com.modvolt.fixture=${FIXTURE_LABEL}`,
          "--label",
          `com.modvolt.fixture-run=${runId}`,
          "--label",
          `com.docker.compose.project=${composeProject}`,
          "--label",
          "com.docker.compose.service=postgres",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "DAC_OVERRIDE",
          "--cap-add",
          "FOWNER",
          "--cap-add",
          "SETGID",
          "--cap-add",
          "SETUID",
          "--pids-limit",
          "128",
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--mount",
          `type=volume,source=${volumeName},target=/var/lib/postgresql/data`,
          "--env",
          "POSTGRES_DB",
          "--env",
          "POSTGRES_USER",
          "--env",
          "POSTGRES_PASSWORD",
          "--env",
          "POSTGRES_INITDB_ARGS",
          IMAGE,
        ],
        inherited,
      );
      assert.match(postgresId, /^[0-9a-f]{64}$/);

      for (const service of ["api", "web"] as const) {
        const name = containerNames[service];
        const id = await docker([
          "run",
          "--detach",
          "--rm",
          "--name",
          name,
          "--network",
          networkName,
          "--label",
          `com.modvolt.fixture=${FIXTURE_LABEL}`,
          "--label",
          `com.modvolt.fixture-run=${runId}`,
          "--label",
          `com.docker.compose.project=${composeProject}`,
          "--label",
          `com.docker.compose.service=${service}`,
          "--cap-drop",
          "ALL",
          "--read-only",
          "--pids-limit",
          "32",
          "--memory",
          "64m",
          "--cpus",
          "0.25",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,nodev,size=8m",
          "--entrypoint",
          "/bin/sh",
          IMAGE,
          "-c",
          "sleep 180",
        ]);
        assert.match(id, /^[0-9a-f]{64}$/);
      }

      await waitForPostgres(containerNames.postgres);
      await docker([
        "container",
        "exec",
        containerNames.postgres,
        "psql",
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        "--dbname",
        DATABASE,
        "--username",
        USER,
        "--command",
        `CREATE SCHEMA drizzle;
         CREATE TABLE drizzle.__drizzle_migrations (
           id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL
         );
         INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         VALUES ('${JOURNAL[0].hash}', ${JOURNAL[0].createdAt});`,
      ]);

      const controller = new AbortController();
      const authority = await observeProductionHostDockerAuthority({
        confirmation: PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION,
        composeProject,
        postgresService: "postgres",
        expectedPostgresImage: IMAGE,
        postgresVolumeDestination: "/var/lib/postgresql/data",
        expectedNetworkServices: ["api", "postgres", "web"],
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      assert.equal(authority.containerId, postgresId);
      const artifact = await collectProductionHostPostgresExport({
        confirmation: PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION,
        databaseName: DATABASE,
        databaseUser: USER,
        schemaFingerprintSha256: FINGERPRINT,
        expectedJournalRows: JOURNAL,
        dockerAuthority: authority,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      assert.equal(artifact.value.containerId, postgresId);
      assert.equal(artifact.value.dockerExportSha256, authority.sha256);
      assert.match(artifact.value.backendProofSha256, /^sha256:[0-9a-f]{64}$/);
      assert.equal(artifact.value.databaseName, DATABASE);
      assert.equal(artifact.value.databaseUser, USER);
      assert.equal(artifact.value.schemaFingerprintSha256, FINGERPRINT);
      assert.match(artifact.value.serverVersion, /^16\./);
      assert.equal(artifact.value.readOnlyObservation, true);
    } catch (error) {
      executionError = error;
    } finally {
      try {
        await cleanupProductionHostPostgresObserverPg16Fixture({
          runId,
          containerNames: Object.values(containerNames),
          networkName,
          volumeName,
        });
      } catch (error) {
        cleanupError = error;
      }
    }
    if (executionError && cleanupError) {
      throw new AggregateError(
        [executionError, cleanupError],
        "POSTGRES_OBSERVER_PG16_EXECUTION_AND_CLEANUP_FAILED",
      );
    }
    if (executionError) throw executionError;
    if (cleanupError) throw cleanupError;
  },
);
