import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runStagingAudit0107Transition,
  validateStagingAudit0107Execution,
  validateStagingAudit0107TransitionArtifacts,
} from "../run-staging-audit-0107-transition.mjs";
import { verifyStagingAudit0107Execution } from "../verify-staging-audit-0107-execution.mjs";
import { AUDIT_0107 } from "../staging-audit-0107-contract.mjs";
import {
  createArtifacts,
  artifact,
  gateEvidence,
  inventory,
  POSTGRES_CONTAINER_ID,
  postgresInspect,
  resolvedCompose,
  SHA,
} from "./staging-audit-0107-fixtures.mjs";

function setup({
  mode = "clean",
  inventoryDecision = "READY_0106",
  operation = "APPLIED",
  mutateCompose,
  mutateGate,
  outputDirectory,
} = {}) {
  const artifacts = createArtifacts(mode);
  const compose = resolvedCompose(artifacts, "gate");
  mutateCompose?.(compose);
  const postgres = postgresInspect(artifacts.binding.derivedInspect);
  const output =
    outputDirectory ??
    fs.mkdtempSync(path.join(os.tmpdir(), "audit-0107-transition-"));
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
    if (args.includes("ps")) return { status: 0, stdout: "postgres\n" };
    if (args.includes("dist/audit-schema-inventory.mjs")) {
      return {
        status: 0,
        stdout: `[audit-schema-inventory] PASS ${JSON.stringify(inventory(inventoryDecision, mode))}\n`,
      };
    }
    const gate = gateEvidence(artifacts, operation);
    mutateGate?.(gate);
    return {
      status: 0,
      stdout: `[audit-schema-gate] ${operation} ${JSON.stringify(gate)}\n`,
    };
  };
  const times = [
    new Date("2026-08-12T10:03:30.000Z"),
    new Date("2026-08-12T10:04:30.000Z"),
  ];
  return {
    artifacts,
    calls,
    outputDirectory: output,
    options: {
      outputDirectory: output,
      expectedSourceSha: SHA,
      confirmation: AUDIT_0107.confirmation,
      transitionBytes: artifacts.transition.bytes,
      transitionChecksumText: artifacts.transition.checksum,
      expectedTransitionSha256: artifacts.transition.sha256,
      inspectBytes: artifacts.inspect.bytes,
      inspectChecksumText: artifacts.inspect.checksum,
      expectedInspectSha256: artifacts.inspect.sha256,
      backupExecutionBytes: artifacts.backup.bytes,
      backupExecutionChecksumText: artifacts.backup.checksum,
      expectedBackupExecutionSha256: artifacts.backup.sha256,
      execute,
      now: () => times.shift(),
    },
  };
}

function cleanup(fixture) {
  fs.rmSync(fixture.outputDirectory, { recursive: true, force: true });
}

test("writes intent before an isolated APPLIED transition and verifies execution offline", () => {
  for (const mode of ["clean", "production-copy-restricted"]) {
    const fixture = setup({ mode });
    try {
      const result = runStagingAudit0107Transition(fixture.options);
      assert.equal(result.execution.operation, "applied");
      assert.equal(result.execution.authorizesApplicationStart, false);
      assert.equal(result.execution.lineage.mode, mode);
      assert.ok(
        fs.existsSync(
          path.join(fixture.outputDirectory, "staging-audit-0107-intent.json"),
        ),
      );
      const executionBytes = fs.readFileSync(result.files.target);
      const executionChecksumText = fs.readFileSync(
        result.files.checksum,
        "utf8",
      );
      const intentBytes = fs.readFileSync(
        path.join(fixture.outputDirectory, "staging-audit-0107-intent.json"),
      );
      const intentChecksumText = fs.readFileSync(
        path.join(fixture.outputDirectory, "staging-audit-0107-intent.sha256"),
        "utf8",
      );
      const verified = verifyStagingAudit0107Execution({
        ...fixture.options,
        intentBytes,
        intentChecksumText,
        expectedIntentSha256: result.execution.intentSha256.slice(
          "sha256:".length,
        ),
        executionBytes,
        executionChecksumText,
        expectedExecutionSha256: result.files.sha256,
      });
      assert.equal(verified.decision, "PASS");
      assert.equal(verified.authorizesApplicationStart, false);
      assert.equal(verified.nextGate, "separate-audit-0107-startup-evidence");
      assert.ok(
        fixture.calls.some(
          (args) =>
            args.includes("--profile") &&
            args.includes("audit-0107-transition") &&
            args.includes("dist/audit-schema-gate.mjs"),
        ),
      );
      assert.ok(
        fixture.calls.every(
          (args) => !args.includes("dist/accounting-schema-gate.mjs"),
        ),
      );
    } finally {
      cleanup(fixture);
    }
  }
});

test("rejects first-attempt NOOP and accepts only recovery with the exact prior intent", () => {
  const firstNoop = setup({
    inventoryDecision: "ALREADY_0107",
    operation: "NOOP",
  });
  try {
    assert.throws(() => runStagingAudit0107Transition(firstNoop.options));
  } finally {
    cleanup(firstNoop);
  }

  const applied = setup();
  try {
    const initial = runStagingAudit0107Transition(applied.options);
    fs.rmSync(initial.files.target);
    fs.rmSync(initial.files.checksum);
    const recovery = setup({
      inventoryDecision: "ALREADY_0107",
      operation: "NOOP",
      outputDirectory: applied.outputDirectory,
    });
    const recovered = runStagingAudit0107Transition(recovery.options);
    assert.equal(recovered.execution.operation, "verified-noop");
  } finally {
    cleanup(applied);
  }
});

test("fails closed on resolved target drift, S3 surface and another running service", () => {
  const drifted = setup({
    mutateCompose: (compose) => {
      compose.services["audit-schema-gate"].profiles = ["default"];
    },
  });
  try {
    assert.throws(() => runStagingAudit0107Transition(drifted.options));
  } finally {
    cleanup(drifted);
  }

  const s3 = setup({
    mutateCompose: (compose) => {
      compose.services["audit-schema-gate"].environment.S3_BUCKET =
        "unexpected";
    },
  });
  try {
    assert.throws(() => runStagingAudit0107Transition(s3.options));
  } finally {
    cleanup(s3);
  }

  const activeApi = setup();
  activeApi.options.execute = (_command, args) => {
    if (args.includes("config")) {
      return {
        status: 0,
        stdout: JSON.stringify(resolvedCompose(activeApi.artifacts, "gate")),
      };
    }
    if (args.includes("ps") && !args.includes("--quiet")) {
      return { status: 0, stdout: "postgres\napi\n" };
    }
    return { status: 1, stdout: "" };
  };
  try {
    assert.throws(() => runStagingAudit0107Transition(activeApi.options));
  } finally {
    cleanup(activeApi);
  }
});

test("rejects tampered gate binding and predecessor confirmation", () => {
  const tampered = setup({
    mutateGate: (gate) => {
      gate.migration.sha256 = `sha256:${"f".repeat(64)}`;
    },
  });
  try {
    assert.throws(() => runStagingAudit0107Transition(tampered.options));
  } finally {
    cleanup(tampered);
  }
  const oldConfirmation = setup();
  try {
    assert.throws(() =>
      runStagingAudit0107Transition({
        ...oldConfirmation.options,
        confirmation:
          "APPLY_0106_ACCOUNTING_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING",
      }),
    );
  } finally {
    cleanup(oldConfirmation);
  }
});

test("execution validator rejects an application-start authorization bit", () => {
  const fixture = setup();
  try {
    const result = runStagingAudit0107Transition(fixture.options);
    assert.throws(() =>
      validateStagingAudit0107Execution(
        { ...result.execution, authorizesApplicationStart: true },
        {
          sourceSha: SHA,
          transitionSha256: fixture.artifacts.transition.sha256,
          inspectSha256: fixture.artifacts.inspect.sha256,
          backupExecutionSha256: fixture.artifacts.backup.sha256,
          transition: fixture.artifacts.binding.transition,
          inspect: fixture.artifacts.binding.derivedInspect,
          backup: {
            backupId: 82,
            sizeBytes: 4096,
            maxPayloadBytes: AUDIT_0107.maxPayloadBytes,
          },
          lineage: {
            ...fixture.artifacts.lineage,
            opaqueLegacyRows: fixture.artifacts.lineage.rows,
            opaqueLegacyRowsJson: fixture.artifacts.lineage.rowsJson,
            opaqueLegacyRowsSha256: fixture.artifacts.lineage.rowsSha256,
            totalJournalRows: 107,
          },
        },
      ),
    );
  } finally {
    cleanup(fixture);
  }
});

test("cross-slice markers reject broken inspect, backup and no-op bindings", () => {
  const artifacts = createArtifacts();
  const changedTransition = artifact(
    {
      ...artifacts.binding.transition,
      originalInspectInputsSha256: `sha256:${"f".repeat(64)}`,
    },
    "staging-audit-0107-transition.json",
  );
  assert.throws(() =>
    validateStagingAudit0107TransitionArtifacts({
      expectedSourceSha: SHA,
      transitionBytes: changedTransition.bytes,
      transitionChecksumText: changedTransition.checksum,
      expectedTransitionSha256: changedTransition.sha256,
      inspectBytes: artifacts.inspect.bytes,
      inspectChecksumText: artifacts.inspect.checksum,
      expectedInspectSha256: artifacts.inspect.sha256,
      backupExecutionBytes: artifacts.backup.bytes,
      backupExecutionChecksumText: artifacts.backup.checksum,
      expectedBackupExecutionSha256: artifacts.backup.sha256,
    }),
  );

  const missingTransition = setup({
    mutateGate: (gate) => {
      gate.transition = null;
    },
  });
  try {
    assert.throws(() =>
      runStagingAudit0107Transition(missingTransition.options),
    );
  } finally {
    cleanup(missingTransition);
  }
});

test("fails closed when resolved Compose changes immediately before stateful run", () => {
  const fixture = setup();
  const originalExecute = fixture.options.execute;
  let configCalls = 0;
  fixture.options.execute = (command, args) => {
    const result = originalExecute(command, args);
    if (args.includes("config") && ++configCalls === 2) {
      const changed = JSON.parse(result.stdout);
      changed.services["audit-schema-gate"].cpus = 0.5;
      return { status: 0, stdout: JSON.stringify(changed) };
    }
    return result;
  };
  try {
    assert.throws(() => runStagingAudit0107Transition(fixture.options));
  } finally {
    cleanup(fixture);
  }
});
