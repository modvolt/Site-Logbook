import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runStagingExact0106AuditBackup,
  writeStagingExact0106AuditBackupEvidence,
} from "../run-staging-exact-0106-audit-backup.mjs";
import { AUDIT_0107 } from "../staging-audit-0107-contract.mjs";
import {
  backupGate,
  createArtifacts,
  defaultNetworkInspect,
  EXPECTED_SCHEMA_FINGERPRINT_SHA256,
  lineageConfig,
  POSTGRES_CONTAINER_ID,
  postgresInspect,
  postgresVolumeInspect,
  resolvedCompose,
  SHA,
} from "./staging-audit-0107-fixtures.mjs";

const ONE_SHOT_CONTAINER_ID = "9".repeat(64);

function setup({
  mode = "clean",
  mutateCompose,
  services = "postgres\n",
  foreignVolumeContainerId,
  foreignNetworkContainerId,
  mutateFrozenAfterCreate = false,
  mutateSourceAfterResolve = false,
  failStart = false,
  failCreate = false,
  failCleanup = false,
  mutateVolumeInspect,
  mutateNetworkInspect,
} = {}) {
  const artifacts = createArtifacts(mode);
  const compose = resolvedCompose(artifacts, "backup");
  mutateCompose?.(compose);
  const postgres = postgresInspect();
  const calls = [];
  const frozenPaths = [];
  const frozenModels = [];
  let oneShotCreated = false;
  let oneShotRemoved = false;
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes("config")) {
      const fileIndex = args.indexOf("-f");
      if (args.includes("--env-file")) {
        const stdout = JSON.stringify(compose);
        if (mutateSourceAfterResolve) {
          compose.services["exact-0106-audit-backup"].environment.S3_BUCKET =
            "mutated-after-resolution";
        }
        return { status: 0, stdout };
      }
      const frozenPath = args[fileIndex + 1];
      frozenPaths.push(frozenPath);
      return { status: 0, stdout: fs.readFileSync(frozenPath, "utf8") };
    }
    if (args[0] === "inspect" && args.includes("{{json .State}}")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          Status: "exited",
          Running: false,
          ExitCode: 0,
        }),
      };
    }
    if (args[0] === "inspect") {
      return { status: 0, stdout: JSON.stringify(postgres) };
    }
    if (args[0] === "volume") {
      const value = postgresVolumeInspect();
      mutateVolumeInspect?.(value);
      return { status: 0, stdout: JSON.stringify(value) };
    }
    if (args[0] === "network") {
      const ids = [
        POSTGRES_CONTAINER_ID,
        ...(oneShotCreated && !oneShotRemoved ? [ONE_SHOT_CONTAINER_ID] : []),
        ...(foreignNetworkContainerId ? [foreignNetworkContainerId] : []),
      ];
      const value = defaultNetworkInspect(undefined, ids);
      mutateNetworkInspect?.(value);
      return {
        status: 0,
        stdout: JSON.stringify(value),
      };
    }
    if (
      args[0] === "container" &&
      args.includes("volume=" + postgres.mounts[0].Name)
    ) {
      return {
        status: 0,
        stdout:
          [POSTGRES_CONTAINER_ID, foreignVolumeContainerId]
            .filter(Boolean)
            .join("\n") + "\n",
      };
    }
    if (
      args[0] === "container" &&
      args.some((value) => String(value).startsWith("network="))
    ) {
      return {
        status: 0,
        stdout:
          [
            POSTGRES_CONTAINER_ID,
            ...(oneShotCreated && !oneShotRemoved
              ? [ONE_SHOT_CONTAINER_ID]
              : []),
            foreignNetworkContainerId,
          ]
            .filter(Boolean)
            .join("\n") + "\n",
      };
    }
    if (args.includes("create")) {
      frozenModels.push(
        JSON.parse(fs.readFileSync(args[args.indexOf("-f") + 1], "utf8")),
      );
      oneShotCreated = true;
      if (failCreate) return { status: 1, stdout: "" };
      return { status: 0, stdout: "" };
    }
    if (args.includes("--all") && args.includes("--quiet")) {
      if (mutateFrozenAfterCreate) {
        const frozenPath = args[args.indexOf("-f") + 1];
        fs.appendFileSync(frozenPath, " ");
      }
      return { status: 0, stdout: `${ONE_SHOT_CONTAINER_ID}\n` };
    }
    if (args.includes("ps") && args.includes("--quiet")) {
      return { status: 0, stdout: `${POSTGRES_CONTAINER_ID}\n` };
    }
    if (args.includes("ps")) return { status: 0, stdout: services };
    if (args[0] === "start") {
      if (failStart) return { status: 1, stdout: "" };
      return {
        status: 0,
        stdout: `[audit-schema-exact-0106-backup] PASS ${JSON.stringify(backupGate(mode))}\n`,
      };
    }
    if (args[0] === "rm") {
      if (failCleanup) return { status: 1, stdout: "" };
      oneShotRemoved = true;
      return { status: 0, stdout: "" };
    }
    return {
      status: 1,
      stdout: "",
    };
  };
  const lineage = lineageConfig(mode);
  const times = [
    new Date("2026-08-12T10:00:00.000Z"),
    new Date("2026-08-12T10:04:00.000Z"),
  ];
  return {
    artifacts,
    calls,
    frozenPaths,
    frozenModels,
    state: {
      get oneShotRemoved() {
        return oneShotRemoved;
      },
    },
    options: {
      expectedSourceSha: SHA,
      expectedSchemaFingerprintSha256: EXPECTED_SCHEMA_FINGERPRINT_SHA256,
      confirmation: AUDIT_0107.backupConfirmation,
      lineageMode: mode,
      opaqueLegacyRowsJson: lineage.rowsJson,
      inspectDeploymentBytes: artifacts.originalInspect.bytes,
      inspectDeploymentChecksumText: artifacts.originalInspect.checksum,
      expectedInspectDeploymentSha256: artifacts.originalInspect.sha256,
      execute,
      now: () => times.shift(),
    },
  };
}

test("creates isolated exact-0106 backup evidence with a distinct confirmation", () => {
  for (const mode of ["clean", "production-copy-restricted"]) {
    const fixture = setup({ mode });
    const evidence = runStagingExact0106AuditBackup(fixture.options);
    assert.equal(evidence.decision, "PASS");
    assert.equal(evidence.gate.backupId, 82);
    assert.equal(evidence.authorizes0107, false);
    assert.equal(evidence.authorizesApplicationStart, false);
    assert.equal(evidence.lineage.mode, mode);
    assert.equal(
      fixture.frozenModels[0].services["exact-0106-audit-backup"].environment
        .AUDIT_SCHEMA_EXPECTED_FINGERPRINT_SHA256,
      EXPECTED_SCHEMA_FINGERPRINT_SHA256,
    );
    assert.equal(
      evidence.runtimeIsolation.exactApprovedContainersAtObservedBoundaries,
      true,
    );
    assert.equal(evidence.runtimeIsolation.continuousIsolationInferred, false);
    assert.ok(
      fixture.calls.some(
        (args) =>
          args.includes("--profile") &&
          args.includes("exact-0106-audit-backup") &&
          args.includes("create"),
      ),
    );
    assert.ok(fixture.calls.some((args) => args[0] === "start"));
    assert.ok(
      fixture.calls.every(
        (args) =>
          !args.includes("dist/accounting-schema-exact-0105-backup.mjs"),
      ),
    );
  }
});

test("fails closed when another service runs or the resolved target drifts", () => {
  assert.throws(() =>
    runStagingExact0106AuditBackup(
      setup({ services: "postgres\napi\n" }).options,
    ),
  );
  assert.throws(() =>
    runStagingExact0106AuditBackup(
      setup({
        mutateCompose: (compose) => {
          compose.services["exact-0106-audit-backup"].environment.S3_BUCKET =
            "wrong-bucket";
        },
      }).options,
    ),
  );
});

test("rejects every predecessor confirmation and non-frozen lineage", () => {
  const fixture = setup();
  assert.throws(() =>
    runStagingExact0106AuditBackup({
      ...fixture.options,
      confirmation:
        "CREATE_FRESH_EXACT_0105_STAGING_BACKUP_AND_RESTORE_TEST_NO_0106",
    }),
  );
  assert.throws(() =>
    runStagingExact0106AuditBackup({
      ...fixture.options,
      expectedSchemaFingerprintSha256: `sha256:${"0".repeat(63)}`,
    }),
  );
  assert.throws(() =>
    runStagingExact0106AuditBackup({
      ...fixture.options,
      lineageMode: "production-copy-restricted",
      opaqueLegacyRowsJson:
        '[{"createdAt":1,"hash":"' +
        "f".repeat(64) +
        '"},{"createdAt":2,"hash":"' +
        "e".repeat(64) +
        '"}]',
    }),
  );
});

test("rejects foreign containers sharing the approved volume or network", () => {
  assert.throws(() =>
    runStagingExact0106AuditBackup(
      setup({ foreignVolumeContainerId: "a".repeat(64) }).options,
    ),
  );
  assert.throws(() =>
    runStagingExact0106AuditBackup(
      setup({ foreignNetworkContainerId: "b".repeat(64) }).options,
    ),
  );
});

test("rejects drifted volume and network identity projections", () => {
  assert.throws(() =>
    runStagingExact0106AuditBackup(
      setup({
        mutateVolumeInspect: (value) => {
          value.driver = "foreign";
        },
      }).options,
    ),
  );
  assert.throws(() =>
    runStagingExact0106AuditBackup(
      setup({
        mutateNetworkInspect: (value) => {
          value.projectLabel = "foreign";
        },
      }).options,
    ),
  );
});

test("fails closed on frozen Compose TOCTOU mutation and always removes its private file", () => {
  const fixture = setup({ mutateFrozenAfterCreate: true });
  assert.throws(() => runStagingExact0106AuditBackup(fixture.options));
  assert.ok(fixture.state.oneShotRemoved);
  assert.ok(fixture.frozenPaths.length > 0);
  assert.ok(fixture.frozenPaths.every((value) => !fs.existsSync(value)));
});

test("never rereads mutable source Compose after freezing exact rendered bytes", () => {
  const fixture = setup({ mutateSourceAfterResolve: true });
  assert.doesNotThrow(() => runStagingExact0106AuditBackup(fixture.options));
  assert.equal(
    fixture.calls.filter(
      (args) => args.includes("config") && args.includes("--env-file"),
    ).length,
    1,
  );
});

test("cleans the exact one-shot after command failure and preserves cleanup failure", () => {
  const createFailure = setup({ failCreate: true });
  assert.throws(() => runStagingExact0106AuditBackup(createFailure.options));
  assert.equal(createFailure.state.oneShotRemoved, true);

  const commandFailure = setup({ failStart: true });
  assert.throws(() => runStagingExact0106AuditBackup(commandFailure.options));
  assert.ok(commandFailure.state.oneShotRemoved);
  assert.ok(commandFailure.frozenPaths.every((value) => !fs.existsSync(value)));

  const doubleFailure = setup({ failStart: true, failCleanup: true });
  let error;
  try {
    runStagingExact0106AuditBackup(doubleFailure.options);
    assert.fail("double failure must fail closed");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error.cleanupError);
  assert.ok(doubleFailure.frozenPaths.every((value) => !fs.existsSync(value)));
});

test("writes canonical backup evidence and checksum exclusively", () => {
  const evidence = runStagingExact0106AuditBackup(setup().options);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "exact-0106-audit-backup-"),
  );
  try {
    const files = writeStagingExact0106AuditBackupEvidence(directory, evidence);
    assert.equal(
      fs.readFileSync(files.checksum, "utf8"),
      `${files.sha256}  staging-exact-0106-audit-backup-execution.json\n`,
    );
    assert.throws(() =>
      writeStagingExact0106AuditBackupEvidence(directory, evidence),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
