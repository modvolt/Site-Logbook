import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  createStagingAudit0107Binding,
  validateAudit0107TransitionInputs,
  writeStagingAudit0107Binding,
} from "../check-staging-audit-0107-binding.mjs";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import { atomicWriteExclusive } from "../staging-audit-0107-contract.mjs";
import {
  artifact,
  backupExecution,
  createArtifacts,
  inspectInputs,
  lineageConfig,
  SHA,
} from "./staging-audit-0107-fixtures.mjs";

test("derives an exact audit 0107 binding from a fresh exact-0106 backup", () => {
  for (const mode of ["clean", "production-copy-restricted"]) {
    const artifacts = createArtifacts(mode);
    const { binding, lineage } = artifacts;
    assert.equal(binding.decision, "PASS");
    assert.equal(binding.derivedInspect.backupEvidenceId, 82);
    assert.equal(binding.transition.predecessor.tag, "0106_graceful_frog_thor");
    assert.equal(
      binding.transition.target.tag,
      "0107_canonical_audit_evidence",
    );
    assert.equal(
      binding.transition.lineage.opaqueLegacyRowsSha256,
      lineage.rowsSha256,
    );
    assert.equal(
      binding.environment.STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256,
      binding.transitionSha256,
    );
    assert.equal(
      lineage.rowsSha256,
      mode === "clean"
        ? "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
        : "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201",
    );
    assert.equal(binding.environment.AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION, "");
    assert.doesNotThrow(() =>
      validateAudit0107TransitionInputs(binding.transition),
    );
  }
});

test("rejects non-frozen opaque lineage and unsafe backup evidence", () => {
  const inspect = artifact(inspectInputs(), "staging-deployment-inspect.json");
  const cases = [
    {
      mode: "production-copy-restricted",
      rowsJson: JSON.stringify([
        { createdAt: 1, hash: "f".repeat(64) },
        { createdAt: 2, hash: "e".repeat(64) },
      ]),
      backup: backupExecution(inspect.sha256, "production-copy-restricted"),
    },
    {
      mode: "clean",
      rowsJson: "[]",
      backup: backupExecution(inspect.sha256, "clean", {
        authorizes0107: true,
      }),
    },
    {
      mode: "clean",
      rowsJson: "[]",
      backup: backupExecution(inspect.sha256, "clean", {
        sizeBytes: 256 * 1024 * 1024 + 1,
      }),
    },
  ];
  for (const current of cases) {
    const backup = artifact(
      current.backup,
      "staging-exact-0106-audit-backup-execution.json",
    );
    assert.throws(() =>
      createStagingAudit0107Binding({
        expectedSourceSha: SHA,
        lineageMode: current.mode,
        opaqueLegacyRowsJson: current.rowsJson,
        originalInspectBytes: inspect.bytes,
        originalInspectChecksumText: inspect.checksum,
        expectedOriginalInspectSha256: inspect.sha256,
        backupExecutionBytes: backup.bytes,
        backupExecutionChecksumText: backup.checksum,
        expectedBackupExecutionSha256: backup.sha256,
      }),
    );
  }
});

test("rejects an old 0105/0106 artifact name or confirmation", () => {
  const artifacts = createArtifacts();
  const wrongNameChecksum = `${artifacts.backup.sha256}  staging-exact-0105-backup-execution.json\n`;
  assert.throws(() =>
    createStagingAudit0107Binding({
      expectedSourceSha: SHA,
      lineageMode: "clean",
      opaqueLegacyRowsJson: "[]",
      originalInspectBytes: artifacts.originalInspect.bytes,
      originalInspectChecksumText: artifacts.originalInspect.checksum,
      expectedOriginalInspectSha256: artifacts.originalInspect.sha256,
      backupExecutionBytes: artifacts.backup.bytes,
      backupExecutionChecksumText: wrongNameChecksum,
      expectedBackupExecutionSha256: artifacts.backup.sha256,
    }),
  );
  assert.throws(() =>
    validateAudit0107TransitionInputs({
      ...artifacts.binding.transition,
      confirmation:
        "APPLY_0106_ACCOUNTING_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING",
    }),
  );
});

test("writes canonical artifacts and a secret-free env file once", () => {
  const { binding } = createArtifacts("production-copy-restricted");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "audit-0107-binding-"),
  );
  try {
    const files = writeStagingAudit0107Binding(directory, binding);
    assert.deepEqual(Object.keys(files).sort(), [
      "staging-audit-0107-inspect.json",
      "staging-audit-0107-inspect.sha256",
      "staging-audit-0107-transition.json",
      "staging-audit-0107-transition.sha256",
      "staging-audit-0107.env",
    ]);
    assert.equal(
      fs.readFileSync(files["staging-audit-0107-transition.json"], "utf8"),
      canonicalJson(binding.transition),
    );
    const env = fs.readFileSync(files["staging-audit-0107.env"], "utf8");
    assert.match(env, /^STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256=[0-9a-f]{64}$/m);
    assert.match(env, /^AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON=\[/m);
    assert.doesNotMatch(env, /(PASSWORD|SECRET_ACCESS_KEY|KEYRING)=/);
    assert.throws(() => writeStagingAudit0107Binding(directory, binding));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("actual Compose and package surfaces keep both audit one-shots profile isolated", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const compose = parseYaml(
    fs.readFileSync(path.join(root, "docker-compose.staging.yml"), "utf8"),
  );
  const backup = compose.services["exact-0106-audit-backup"];
  const gate = compose.services["audit-schema-gate"];
  assert.deepEqual(backup.profiles, ["exact-0106-audit-backup"]);
  assert.deepEqual(gate.profiles, ["audit-0107-transition"]);
  assert.deepEqual(backup.command, [
    "node",
    "dist/audit-schema-exact-0106-backup.mjs",
  ]);
  assert.deepEqual(gate.command, ["node", "dist/audit-schema-gate.mjs"]);
  assert.equal(backup.environment.STAGING_AUDIT_SCHEMA_ACTION, "inspect");
  for (const service of [backup, gate]) {
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.equal(service.restart, "no");
    assert.equal(service.ports, undefined);
    assert.equal(service.volumes, undefined);
    assert.equal(service.depends_on, undefined);
  }
  assert.ok(
    Object.keys(backup.environment).some((key) => key.startsWith("S3_")),
  );
  assert.ok(
    Object.keys(gate.environment).every(
      (key) => !key.startsWith("S3_") && !key.startsWith("STAGING_S3_"),
    ),
  );
  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  ).scripts;
  assert.equal(
    scripts["staging:create-exact-0106-audit-backup"],
    "node ./scripts/run-staging-exact-0106-audit-backup.mjs",
  );
  assert.equal(
    scripts["staging:apply-audit-0107-transition"],
    "node ./scripts/run-staging-audit-0107-transition.mjs",
  );
});

test("exclusive evidence writer cannot clobber a target created at link time", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "audit-no-clobber-"));
  const target = path.join(directory, "evidence.json");
  const originalLink = fs.linkSync;
  try {
    fs.linkSync = (source, destination) => {
      fs.writeFileSync(destination, "winner\n", { flag: "wx" });
      return originalLink(source, destination);
    };
    assert.throws(() =>
      atomicWriteExclusive(directory, "evidence.json", "loser\n"),
    );
    assert.equal(fs.readFileSync(target, "utf8"), "winner\n");
  } finally {
    fs.linkSync = originalLink;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
