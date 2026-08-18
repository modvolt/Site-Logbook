import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StagingBaseline0104BindingError,
  baseline0104InputsSha256,
  buildStagingBaseline0104Inputs,
  writeStagingBaseline0104Binding,
} from "../check-staging-baseline-0104-binding.mjs";

const CANDIDATE_SHA = "1c6cb0209c004d8d583c71f68132e6dbbf587b98";
const PREDECESSOR_SHA = "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const PREDECESSOR_TREE = "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c";
const CANDIDATE_IMAGE = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"a".repeat(64)}`;
const PREDECESSOR_IMAGE = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"b".repeat(64)}`;

function candidateBinding() {
  return {
    decision: "PASS",
    inspect: {
      sha256: "c".repeat(64),
      inputs: {
        schemaVersion: 1,
        sourceSha: CANDIDATE_SHA,
        imageManifestSha256: "d".repeat(64),
        provisioningManifestSha256: "e".repeat(64),
        environmentId: "site-logbook-staging",
        composeProjectName: "site-logbook-staging",
        externalAccountsEnabled: false,
        schemaAction: "inspect",
        images: {
          preflight: `ghcr.io/modvolt/site-logbook-staging-preflight@sha256:${"1".repeat(64)}`,
          mailpit: `ghcr.io/modvolt/site-logbook-staging-mailpit@sha256:${"2".repeat(64)}`,
          api: CANDIDATE_IMAGE,
          web: `ghcr.io/modvolt/site-logbook-staging-web@sha256:${"3".repeat(64)}`,
          alertReceiver: `ghcr.io/modvolt/site-logbook-staging-alert-receiver@sha256:${"4".repeat(64)}`,
        },
      },
      environment: {
        STAGING_SCHEMA_ACTION: "inspect",
        STAGING_DEPLOYMENT_INPUTS_SHA256: "c".repeat(64),
      },
    },
  };
}

function predecessor() {
  return {
    decision: "PASS",
    trusted: true,
    sourceSha: PREDECESSOR_SHA,
    sourceTree: PREDECESSOR_TREE,
    manifestSha256: "f".repeat(64),
    image: PREDECESSOR_IMAGE,
    publisherRun: { id: "123", attempt: "1" },
    manifestBase64: Buffer.from("{}\n").toString("base64"),
  };
}

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) =>
      error instanceof StagingBaseline0104BindingError && error.code === code,
  );
}

test("builds one no-production exact-0104 baseline input", () => {
  const inputs = buildStagingBaseline0104Inputs({
    candidateBinding: candidateBinding(),
    predecessor: predecessor(),
    backupEvidenceId: 77,
    backupRestoreMaxAgeHours: 24,
  });
  assert.equal(inputs.action, "apply-0104-baseline");
  assert.equal(inputs.productionTargetsTouched, false);
  assert.equal(inputs.authorizes0105, false);
  assert.equal(inputs.candidate.apiImage, CANDIDATE_IMAGE);
  assert.equal(inputs.predecessor.apiImage, PREDECESSOR_IMAGE);
  assert.equal(inputs.target.migrationCount, 104);
  assert.equal(inputs.target.latestTag, "0104_thin_sheva_callister");
  assert.match(baseline0104InputsSha256(inputs), /^[0-9a-f]{64}$/);
});

test("rejects untrusted predecessor, candidate drift, image collision and unsafe backup", () => {
  expectCode("BASELINE_BINDING_PREDECESSOR_UNTRUSTED", () =>
    buildStagingBaseline0104Inputs({
      candidateBinding: candidateBinding(),
      predecessor: { ...predecessor(), trusted: false },
      backupEvidenceId: 77,
      backupRestoreMaxAgeHours: 24,
    }),
  );
  expectCode("BASELINE_BINDING_CANDIDATE_INVALID", () =>
    buildStagingBaseline0104Inputs({
      candidateBinding: {
        ...candidateBinding(),
        inspect: {
          ...candidateBinding().inspect,
          inputs: {
            ...candidateBinding().inspect.inputs,
            externalAccountsEnabled: true,
          },
        },
      },
      predecessor: predecessor(),
      backupEvidenceId: 77,
      backupRestoreMaxAgeHours: 24,
    }),
  );
  expectCode("BASELINE_BINDING_IMAGE_COLLISION", () =>
    buildStagingBaseline0104Inputs({
      candidateBinding: candidateBinding(),
      predecessor: { ...predecessor(), image: CANDIDATE_IMAGE },
      backupEvidenceId: 77,
      backupRestoreMaxAgeHours: 24,
    }),
  );
  expectCode("BASELINE_BINDING_NUMBER_INVALID", () =>
    buildStagingBaseline0104Inputs({
      candidateBinding: candidateBinding(),
      predecessor: predecessor(),
      backupEvidenceId: 0,
      backupRestoreMaxAgeHours: 24,
    }),
  );
  expectCode("BASELINE_BINDING_NUMBER_INVALID", () =>
    buildStagingBaseline0104Inputs({
      candidateBinding: candidateBinding(),
      predecessor: predecessor(),
      backupEvidenceId: 77,
      backupRestoreMaxAgeHours: 169,
    }),
  );
});

test("writes canonical inputs, checksum and environment once", () => {
  const inputs = buildStagingBaseline0104Inputs({
    candidateBinding: candidateBinding(),
    predecessor: predecessor(),
    backupEvidenceId: 77,
    backupRestoreMaxAgeHours: 24,
  });
  const result = {
    inputs,
    inputsSha256: baseline0104InputsSha256(inputs),
    environment: { STAGING_BASELINE_0104_ACTION: "apply-0104-baseline" },
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-binding-"));
  try {
    const files = writeStagingBaseline0104Binding(directory, result);
    assert.equal(JSON.parse(fs.readFileSync(files.inputs, "utf8")).authorizes0105, false);
    assert.equal(
      fs.readFileSync(files.checksum, "utf8"),
      `${result.inputsSha256}  staging-baseline-0104-inputs.json\n`,
    );
    expectCode("BASELINE_BINDING_OUTPUT_EXISTS", () =>
      writeStagingBaseline0104Binding(directory, result),
    );
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
