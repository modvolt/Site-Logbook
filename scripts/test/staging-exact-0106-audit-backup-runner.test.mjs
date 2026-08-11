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
  lineageConfig,
  POSTGRES_CONTAINER_ID,
  postgresInspect,
  resolvedCompose,
  SHA,
} from "./staging-audit-0107-fixtures.mjs";

function setup({
  mode = "clean",
  mutateCompose,
  services = "postgres\n",
} = {}) {
  const artifacts = createArtifacts(mode);
  const compose = resolvedCompose(artifacts, "backup");
  mutateCompose?.(compose);
  const postgres = postgresInspect();
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes("config"))
      return { status: 0, stdout: JSON.stringify(compose) };
    if (args[0] === "inspect")
      return { status: 0, stdout: JSON.stringify(postgres) };
    if (args.includes("ps") && args.includes("--quiet")) {
      return { status: 0, stdout: `${POSTGRES_CONTAINER_ID}\n` };
    }
    if (args.includes("ps")) return { status: 0, stdout: services };
    return {
      status: 0,
      stdout: `[audit-schema-exact-0106-backup] PASS ${JSON.stringify(backupGate(mode))}\n`,
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
    options: {
      expectedSourceSha: SHA,
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
    assert.ok(
      fixture.calls.some(
        (args) =>
          args.includes("--profile") &&
          args.includes("exact-0106-audit-backup") &&
          args.includes("dist/audit-schema-exact-0106-backup.mjs"),
      ),
    );
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
