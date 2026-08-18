import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRODUCTION_MIGRATION_BASELINE_OBSERVATION_CONFIRMATION,
  PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_REQUEST_SCHEMA,
  PRODUCTION_MIGRATION_RUNNER_ASSEMBLY_CONFIRMATION,
  createProductionMigrationRunnerAssembly,
  runProductionMigrationBaselineObservationCli,
  runProductionMigrationRoleBootstrapCli,
  runProductionMigrationRunnerAssemblyCli,
} from "../src/production-migration-host-operator";
import { fixturePlanInput } from "../../../scripts/test/production-migration-control-plane-fixtures.mjs";

const root = resolve(import.meta.dirname, "../../..");

describe("production migration host operator boundary", () => {
  it("rejects role bootstrap before request or connection material without exact confirmation", async () => {
    let environmentReads = 0;
    const environment = new Proxy(
      {},
      {
        get() {
          environmentReads += 1;
          throw new Error("connection material must remain unread");
        },
      },
    );
    await expect(
      runProductionMigrationRoleBootstrapCli(
        [
          "--request",
          "missing.json",
          "--evidence-dir",
          "missing",
          "--confirm",
          "WRONG",
        ],
        { environment },
      ),
    ).rejects.toThrow(
      /PRODUCTION_MIGRATION_HOST_OPERATOR_CONFIRMATION_REQUIRED/,
    );
    expect(environmentReads).toBe(0);
    expect(PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_REQUEST_SCHEMA).toBe(
      "site-logbook.production-migration-role-bootstrap-request/v1",
    );
  });

  it("keeps baseline observation read-only and dark before exact confirmation", async () => {
    let environmentReads = 0;
    const environment = new Proxy(
      {},
      {
        get() {
          environmentReads += 1;
          throw new Error("connection material must remain unread");
        },
      },
    );
    await expect(
      runProductionMigrationBaselineObservationCli(
        [
          "--request",
          "missing.json",
          "--backup-plan",
          "missing-plan.json",
          "--migrations-dir",
          "missing-migrations",
          "--evidence-dir",
          "missing-evidence",
          "--confirm",
          `${PRODUCTION_MIGRATION_BASELINE_OBSERVATION_CONFIRMATION}_WRONG`,
        ],
        { environment },
      ),
    ).rejects.toThrow(
      /PRODUCTION_MIGRATION_HOST_OPERATOR_CONFIRMATION_REQUIRED/,
    );
    expect(environmentReads).toBe(0);
  });

  it("assembles an exact descriptor and role activation from fully bound inputs", () => {
    const planInput = fixturePlanInput();
    const request = {
      schemaVersion:
        "site-logbook.production-migration-runner-assembly-request/v2",
      kind: "site-logbook-production-migration-runner-assembly-request",
      sourceSha: planInput.sourceSha,
      databaseName: planInput.database.name,
      sessionUser: planInput.database.sessionUser,
      migrationRole: planInput.database.currentUser,
      runtimeRole: JSON.parse(planInput.rolePreconditionCanonical).runtimeRole,
      intentId: "d".repeat(64),
      approvalId: "approved-production-role-ceremony-20260818",
      inputs: {
        targetEvidence: "evidence/target.json",
        baselineLiveIdentity: "evidence/baseline.json",
        backupPlan: "evidence/backup-plan.json",
        backupExecutorTrace: "evidence/backup-trace.json",
        backupReceipt: "evidence/backup-receipt.json",
        backupSignatureEnvelope: "evidence/backup-signature.json",
        backupDetachedSignature: "evidence/backup-signature.bin",
        rolePrecondition: "evidence/role-precondition.json",
        roleBootstrapReceipt: "evidence/role-bootstrap-receipt.json",
      },
      confirmation: PRODUCTION_MIGRATION_RUNNER_ASSEMBLY_CONFIRMATION,
      authorizesProductionMigration: false,
      authorizesApplicationStart: false,
    };
    const artifacts = {
      targetEvidence: planInput.targetEvidenceCanonical,
      baselineLiveIdentity: planInput.baselineLiveIdentityCanonical,
      backupPlan: planInput.backupPlanCanonical,
      backupExecutorTrace: planInput.backupExecutorTraceCanonical,
      backupReceipt: planInput.backupReceiptCanonical,
      backupSignatureEnvelope: planInput.backupSignatureEnvelopeCanonical,
      backupDetachedSignature: Buffer.from(
        planInput.backupDetachedSignatureB64,
        "base64",
      ),
      rolePrecondition: planInput.rolePreconditionCanonical,
      roleBootstrapReceipt: planInput.roleBootstrapReceiptCanonical,
    };
    const backupAuthority = {
      assertInputSignature() {},
      assertPlanSignature() {},
    };
    const assembly = createProductionMigrationRunnerAssembly(
      request,
      artifacts,
      {
        backupAuthority,
      },
    );
    const descriptor = JSON.parse(assembly.descriptorCanonical);
    const activation = JSON.parse(assembly.activationCanonical);
    expect(descriptor.executionDefault).toBe("disabled");
    expect(descriptor.inputs).toEqual(request.inputs);
    expect(descriptor.roleBinding).toEqual({
      databaseName: request.databaseName,
      sessionUser: request.sessionUser,
      migrationRole: request.migrationRole,
      runtimeRole: request.runtimeRole,
    });
    expect(activation.enabled).toBe(true);
    expect(activation.approvalId).toBe(request.approvalId);
    expect(activation.authorizesApplicationStart).toBe(false);
    expect(assembly.authorizesProductionMigration).toBe(false);

    for (const invalidSignature of [
      Buffer.from(planInput.backupDetachedSignatureB64, "utf8"),
      Buffer.alloc(63),
      Buffer.alloc(65),
    ]) {
      expect(() =>
        createProductionMigrationRunnerAssembly(
          request,
          { ...artifacts, backupDetachedSignature: invalidSignature },
          { backupAuthority },
        ),
      ).toThrow(/PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID/);
    }
    expect(() =>
      createProductionMigrationRunnerAssembly(
        {
          ...request,
          schemaVersion:
            "site-logbook.production-migration-runner-assembly-request/v1",
        },
        artifacts,
        { backupAuthority },
      ),
    ).toThrow(/PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID/);
  });

  it("keeps runner assembly dark before reading any request path", async () => {
    await expect(
      runProductionMigrationRunnerAssemblyCli([
        "--request",
        "missing.json",
        "--root",
        "missing",
        "--confirm",
        `${PRODUCTION_MIGRATION_RUNNER_ASSEMBLY_CONFIRMATION}_WRONG`,
      ]),
    ).rejects.toThrow(
      /PRODUCTION_MIGRATION_HOST_OPERATOR_CONFIRMATION_REQUIRED/,
    );
  });

  it("ships the operator only in the explicit control-plane image", () => {
    const dockerfile = readFileSync(
      resolve(root, "artifacts/api-server/Dockerfile"),
      "utf8",
    );
    const runtimeMarker = dockerfile.indexOf(" AS runtime");
    const runtime = dockerfile.slice(
      dockerfile.lastIndexOf("FROM ", runtimeMarker),
      dockerfile.indexOf("FROM runtime AS control-plane"),
    );
    const controlPlane = dockerfile.slice(
      dockerfile.indexOf("FROM runtime AS control-plane"),
      dockerfile.indexOf("FROM runtime AS production"),
    );
    expect(runtime).not.toContain("production-migration-host-operator.mjs");
    expect(controlPlane).toContain(
      "test -f /app/dist/production-migration-host-operator.mjs",
    );
  });
});
