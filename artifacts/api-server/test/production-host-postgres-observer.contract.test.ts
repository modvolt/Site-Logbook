import { describe, expect, it } from "vitest";
import {
  auditSchemaFingerprintSha256,
  canonicalAuditSchemaCatalogProjection,
  type AuditSchemaCatalogProjection,
} from "@workspace/db/audit-schema-preflight";

import {
  PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION,
  PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION,
  ProductionHostPostgresObserverError,
  collectProductionHostPostgresExport,
  observeProductionHostDockerAuthority,
  type VerifiedProductionHostDockerAuthority,
} from "../src/production-host-postgres-observer";
import { productionHostPostgresObserverTestCore as testCore } from "./support/production-host-postgres-observer-test-core";

import * as productionObserverApi from "../src/production-host-postgres-observer";

const NOW = Date.parse("2026-08-18T09:00:00.000Z");
const CONTAINER_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);
const JOURNAL = Object.freeze([
  Object.freeze({ createdAt: 1_700_000_000_000, hash: "e".repeat(64) }),
]);
const images = Object.freeze({
  api: `ghcr.io/modvolt/site-logbook-api@sha256:${"1".repeat(64)}`,
  postgres: `docker.io/library/postgres@sha256:${"2".repeat(64)}`,
  web: `ghcr.io/modvolt/site-logbook-web@sha256:${"3".repeat(64)}`,
});
const imageIds = Object.freeze({
  api: `sha256:${"4".repeat(64)}`,
  postgres: `sha256:${"5".repeat(64)}`,
  web: `sha256:${"6".repeat(64)}`,
});
const ids = Object.freeze({
  api: "c".repeat(64),
  postgres: CONTAINER_ID,
  web: "f".repeat(64),
});

const emptyCatalog = canonicalAuditSchemaCatalogProjection({
  schemaVersion: "site-logbook.audit-schema-catalog/v1",
  namespaces: [],
  tables: [],
  columns: [],
  functions: [],
  constraints: [],
  indexes: [],
  triggers: [],
} as AuditSchemaCatalogProjection);
const FINGERPRINT = auditSchemaFingerprintSha256(emptyCatalog);

describe("production host observer API surface", () => {
  it("exports no injected authority or mutable-env test seam", () => {
    expect(
      Object.hasOwn(
        productionObserverApi,
        "createProductionHostPostgresObserverTestCore",
      ),
    ).toBe(false);
    expect(
      Object.hasOwn(
        productionObserverApi,
        "PRODUCTION_HOST_POSTGRES_OBSERVER_TEST_CONFIRMATION",
      ),
    ).toBe(false);
    expect(
      Object.keys(productionObserverApi).some((key) =>
        /TestAuthority|TestCore/.test(key),
      ),
    ).toBe(false);
  });

  it("rejects neutral-field SCRAM and GitHub token values without echoing them", () => {
    const values = [
      "SCRAM-SHA-256$4096:c2FsdHNhbHQ=$c3RvcmVka2V5:c2VydmVya2V5",
      "github_pat_this_must_never_escape_1234567890",
    ];
    for (const value of values) {
      expect(() => testCore.assertSecretFree({ harmless: value })).toThrowError(
        expect.objectContaining({
          message: expect.not.stringContaining(value),
        }),
      );
    }
  });
});
interface ProductionHostDockerCommandOptions {
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}

interface DockerContainerFixture {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Labels: Record<string, string>;
  };
  Image: string;
  State: { Status: string };
  Mounts: Array<{
    Type: string;
    Name?: string;
    Destination: string;
    RW: boolean;
  }>;
  NetworkSettings: {
    Networks: Record<string, { NetworkID: string }>;
  };
}

function container(
  service: keyof typeof ids,
  overrides: Partial<DockerContainerFixture> = {},
): DockerContainerFixture {
  return {
    Id: ids[service],
    Name: `/production-${service}-1`,
    Config: {
      Image: images[service],
      Labels: {
        "com.docker.compose.project": "production",
        "com.docker.compose.service": service,
      },
    },
    Image: imageIds[service],
    State: { Status: "running" },
    Mounts:
      service === "postgres"
        ? [
            {
              Type: "volume",
              Name: "production-postgres",
              Destination: "/var/lib/postgresql/data",
              RW: true,
            },
          ]
        : [],
    NetworkSettings: {
      Networks: { production: { NetworkID: NETWORK_ID } },
    },
    ...overrides,
  };
}

function dockerRunner(
  options: {
    containers?: ReturnType<typeof container>[];
    mutateNetwork?: (value: Record<string, unknown>) => void;
  } = {},
) {
  const containers = options.containers ?? [
    container("api"),
    container("postgres"),
    container("web"),
  ];
  const calls: readonly string[][] = [] as string[][];
  const runDocker = async (args: readonly string[]) => {
    (calls as string[][]).push([...args]);
    if (args.join(" ") === "container ls --all --quiet --no-trunc") {
      return `${containers.map((entry) => entry.Id).join("\n")}\n`;
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return JSON.stringify(
        containers.find((entry) => entry.Id === args.at(-1)),
      );
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return JSON.stringify({ Name: "production-postgres", Driver: "local" });
    }
    if (args[0] === "network" && args[1] === "inspect") {
      const value: Record<string, unknown> = {
        Name: "production",
        Id: NETWORK_ID,
        Driver: "bridge",
        Internal: false,
        Containers: Object.fromEntries(
          containers.map((entry) => [entry.Id, { Name: entry.Name }]),
        ),
      };
      options.mutateNetwork?.(value);
      return JSON.stringify(value);
    }
    throw new Error("unexpected Docker command");
  };
  return { calls, runDocker };
}

async function authority(
  options: {
    runner?: ReturnType<typeof dockerRunner>;
    now?: () => number;
  } = {},
): Promise<VerifiedProductionHostDockerAuthority> {
  const runner = options.runner ?? dockerRunner();
  return testCore.observeDocker(
    {
      confirmation: PRODUCTION_HOST_DOCKER_AUTHORITY_CONFIRMATION,
      composeProject: "production",
      postgresService: "postgres",
      expectedPostgresImage: images.postgres,
      postgresVolumeDestination: "/var/lib/postgresql/data",
      expectedNetworkServices: ["api", "postgres", "web"],
      signal: new AbortController().signal,
    },
    {
      runDocker: async (args) => runner.runDocker(args),
      now: options.now ?? (() => NOW),
    },
  );
}

function databaseProjection(
  overrides: {
    identity?: Record<string, unknown>;
    journal?: Array<Record<string, unknown>>;
    catalog?: AuditSchemaCatalogProjection;
  } = {},
): string {
  return `${JSON.stringify({
    identity: {
      database_name: "site_logbook",
      database_user: "site_logbook_runtime",
      server_version: "16.14",
      server_version_num: 160_014,
      isolation_level: "repeatable read",
      transaction_read_only: "on",
      server_port: 5432,
      client_address: null,
      server_address: null,
      server_tcp_port: null,
      backend_pid: 1234,
      postmaster_started_at: new Date(NOW - 60_000).toISOString(),
      observed_at: new Date(NOW).toISOString(),
      ...overrides.identity,
    },
    journal:
      overrides.journal ??
      JOURNAL.map((row) => ({
        created_at: String(row.createdAt),
        hash: row.hash,
      })),
    catalog: overrides.catalog ?? emptyCatalog,
  })}\n`;
}

async function request(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return {
    confirmation: PRODUCTION_HOST_POSTGRES_OBSERVER_CONFIRMATION,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: FINGERPRINT,
    expectedJournalRows: JOURNAL,
    dockerAuthority: await authority(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("production host PostgreSQL authoritative observer", () => {
  it("acquires Docker independently and binds one docker-exec backend snapshot", async () => {
    const docker = dockerRunner();
    const verified = await authority({ runner: docker });
    expect(verified.containerId).toBe(CONTAINER_ID);
    expect(verified.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.getOwnPropertySymbols(verified)).toHaveLength(0);
    expect(
      docker.calls.filter(
        (args) => args[0] === "container" && args[1] === "ls",
      ),
    ).toEqual([
      ["container", "ls", "--all", "--quiet", "--no-trunc"],
      ["container", "ls", "--all", "--quiet", "--no-trunc"],
    ]);
    expect(
      docker.calls.every(
        (args) =>
          (args[0] === "container" && ["ls", "inspect"].includes(args[1])) ||
          (args[0] === "volume" && args[1] === "inspect") ||
          (args[0] === "network" && args[1] === "inspect"),
      ),
    ).toBe(true);

    const calls: Array<{
      args: readonly string[];
      options: ProductionHostDockerCommandOptions;
    }> = [];
    let clock = NOW;
    const artifact = await testCore.collectPostgres(
      (await request({ dockerAuthority: verified })) as never,
      {
        async runDocker(args, options) {
          calls.push({ args, options });
          return databaseProjection();
        },
        now: () => clock++,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 9)).toEqual([
      "container",
      "exec",
      CONTAINER_ID,
      "/usr/bin/env",
      "-i",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "LC_ALL=C",
      "psql",
      "--no-psqlrc",
    ]);
    expect(calls[0].args).toContain("--no-psqlrc");
    expect(calls[0].args).toContain("--set=ON_ERROR_STOP=1");
    expect(calls[0].args).toContain("site_logbook");
    expect(calls[0].args).toContain("site_logbook_runtime");
    expect(calls[0].args).toContain("/var/run/postgresql");
    expect(calls[0].args).toContain("5432");
    expect(
      calls[0].args
        .slice(calls[0].args.indexOf("-i") + 1, calls[0].args.indexOf("psql"))
        .some((entry) => /^PG[A-Z_]*=/.test(entry)),
    ).toBe(false);
    const sql = calls[0].args.at(-1) ?? "";
    expect(sql).toContain(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(sql).toContain("ROLLBACK");
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("pg_get_triggerdef");
    expect(sql).not.toContain("data_directory");
    expect(artifact.value).toMatchObject({
      schemaVersion: "site-logbook.production-host-postgres-export/v2",
      containerId: CONTAINER_ID,
      dockerExportSha256: verified.sha256,
      databaseName: "site_logbook",
      databaseUser: "site_logbook_runtime",
      schemaFingerprintSha256: FINGERPRINT,
      serverVersion: "16.14",
      readOnlyObservation: true,
    });
    expect(artifact.value.backendProofSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact.canonical).not.toContain(JOURNAL[0].hash);
  });

  it("rejects caller-authored Docker JSON/digests and plain forged authority objects", async () => {
    let calls = 0;
    const forged = Object.freeze({
      canonical: "{}\n",
      sha256: `sha256:${"9".repeat(64)}`,
      observedAt: new Date(NOW).toISOString(),
      containerId: "9".repeat(64),
      volumeDestination: "/var/lib/postgresql/data",
    });
    await expect(
      testCore.collectPostgres(
        (await request({ dockerAuthority: forged })) as never,
        {
          async runDocker() {
            calls += 1;
            return databaseProjection();
          },
          now: () => NOW,
        },
      ),
    ).rejects.toThrow(/DOCKER_AUTHORITY_REQUIRED/);
    await expect(
      collectProductionHostPostgresExport({
        ...(await request()),
        dockerExportCanonical: "{}\n",
        dockerExportSha256: `sha256:${"9".repeat(64)}`,
      } as never),
    ).rejects.toThrow(/REQUEST_INVALID/);
    await expect(
      // @ts-expect-error production API deliberately has no dependency seam
      observeProductionHostDockerAuthority({}, { runDocker: async () => "" }),
    ).rejects.toThrow(/REQUEST_INVALID/);
    await expect(
      // @ts-expect-error production API deliberately has no dependency seam
      collectProductionHostPostgresExport(await request(), {
        runDocker: async () => databaseProjection(),
      }),
    ).rejects.toThrow(/REQUEST_INVALID/);
    expect(calls).toBe(0);
  });

  it("rejects stale/malformed mount-network topology and all foreign peers", async () => {
    const wrongMount = container("postgres");
    wrongMount.Mounts[0].Destination = "/foreign";
    await expect(
      authority({
        runner: dockerRunner({
          containers: [container("api"), wrongMount, container("web")],
        }),
      }),
    ).rejects.toThrow(/DOCKER_INVALID/);

    const extraBindMount = container("postgres");
    extraBindMount.Mounts.push({
      Type: "bind",
      Destination: "/var/run/postgresql",
      RW: true,
    });
    await expect(
      authority({
        runner: dockerRunner({
          containers: [container("api"), extraBindMount, container("web")],
        }),
      }),
    ).rejects.toThrow(/DOCKER_INVALID/);

    const foreign = {
      ...container("api"),
      Id: "7".repeat(64),
      Name: "/foreign-sidecar",
      Config: {
        Image: images.api,
        Labels: {
          "com.docker.compose.project": "foreign",
          "com.docker.compose.service": "sidecar",
        },
      },
    };
    await expect(
      authority({
        runner: dockerRunner({
          containers: [
            container("api"),
            container("postgres"),
            container("web"),
            foreign,
          ],
        }),
      }),
    ).rejects.toThrow(/DOCKER_FOREIGN_PEER/);

    const times = [NOW, NOW, NOW + 5_001];
    await expect(
      authority({ now: () => times.shift() ?? NOW + 5_001 }),
    ).rejects.toThrow(/DOCKER_STALE/);
  });

  it("accepts at most one exact running Coolify proxy infrastructure peer", async () => {
    const proxy: DockerContainerFixture = {
      ...container("api"),
      Id: "8".repeat(64),
      Name: "/coolify-proxy",
      Config: {
        Image: "traefik:v3.6",
        Labels: {
          "com.docker.compose.project": "coolify-proxy",
          "com.docker.compose.service": "traefik",
        },
      },
      Image: `sha256:${"8".repeat(64)}`,
      Mounts: [],
    };
    await expect(
      authority({
        runner: dockerRunner({
          containers: [
            container("api"),
            container("postgres"),
            container("web"),
            proxy,
          ],
        }),
      }),
    ).resolves.toEqual(
      expect.objectContaining({ composeProject: "production" }),
    );

    await expect(
      authority({
        runner: dockerRunner({
          containers: [
            container("api"),
            container("postgres"),
            container("web"),
            proxy,
            { ...proxy, Id: "9".repeat(64), Name: "/coolify-proxy-2" },
          ],
        }),
      }),
    ).rejects.toThrow(/DOCKER_FOREIGN_PEER/);
  });

  it("rejects DB/user/PG16/RR-RO, journal and fingerprint drift", async () => {
    const cases = [
      {
        projection: databaseProjection({
          identity: { database_name: "foreign" },
        }),
        code: /IDENTITY_INVALID/,
      },
      {
        projection: databaseProjection({
          identity: { database_user: "site_logbook_migrator" },
        }),
        code: /IDENTITY_INVALID/,
      },
      {
        projection: databaseProjection({
          identity: { server_version: "15.12", server_version_num: 150_012 },
        }),
        code: /IDENTITY_INVALID/,
      },
      {
        projection: databaseProjection({
          identity: { transaction_read_only: "off" },
        }),
        code: /IDENTITY_INVALID/,
      },
      {
        projection: databaseProjection({
          identity: { server_port: 6432 },
        }),
        code: /IDENTITY_INVALID/,
      },
      {
        projection: databaseProjection({
          identity: { data_directory: "/var/lib/postgresql/data" },
        }),
        code: /SCHEMA_INVALID/,
      },
      {
        projection: databaseProjection({
          identity: { server_address: "10.0.0.12", server_tcp_port: 5432 },
        }),
        code: /IDENTITY_INVALID/,
      },
      {
        projection: databaseProjection({
          journal: [
            { created_at: String(JOURNAL[0].createdAt), hash: "9".repeat(64) },
          ],
        }),
        code: /JOURNAL_DRIFT/,
      },
    ];
    for (const testCase of cases) {
      await expect(
        testCore.collectPostgres((await request()) as never, {
          runDocker: async () => testCase.projection,
          now: () => NOW,
        }),
      ).rejects.toThrow(testCase.code);
    }
    await expect(
      testCore.collectPostgres(
        (await request({
          schemaFingerprintSha256: `sha256:${"9".repeat(64)}`,
        })) as never,
        { runDocker: async () => databaseProjection(), now: () => NOW },
      ),
    ).rejects.toThrow(/FINGERPRINT_DRIFT/);
  });

  it("redacts Docker/DB transport errors and honors timeout abort", async () => {
    const secret = "postgres://admin:must-not-escape@production/site_logbook";
    await expect(
      testCore.collectPostgres((await request()) as never, {
        runDocker: async () => {
          throw new ProductionHostPostgresObserverError("FAKE", secret);
        },
        now: () => NOW,
      }),
    ).rejects.toSatisfy((error: Error) => {
      expect(error.message).toMatch(/DATABASE_TRANSPORT_FAILURE/);
      expect(error.message).not.toContain(secret);
      return true;
    });
    await expect(
      testCore.collectPostgres((await request({ timeoutMs: 100 })) as never, {
        runDocker: () => new Promise(() => undefined),
        now: () => NOW,
      }),
    ).rejects.toThrow(/PRODUCTION_POSTGRES_OBSERVER_ABORTED/);
  });
});
