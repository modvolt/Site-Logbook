import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMigrationInventory,
  knownMigrationRowsSha256,
  migrationReleaseBindingMatches,
  opaqueMigrationRowsSha256,
  productionRuntimeBindingMatches,
  type ExpectedMigrationIdentity,
} from "../src/lib/migration-health";
import { createProductionRuntimeBinding } from "../src/lib/production-startup-evidence";

const expected: ExpectedMigrationIdentity[] = [
  { when: 101, tag: "0001_first", hash: "a".repeat(64) },
  { when: 102, tag: "0002_second", hash: "b".repeat(64) },
];

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("migration health inventory", () => {
  it("separates exact known rows from sorted opaque identities", () => {
    const opaque = [
      { createdAt: 9002, hash: "d".repeat(64) },
      { createdAt: 9001, hash: "c".repeat(64) },
    ];
    expect(
      classifyMigrationInventory(expected, [
        { created_at: 9002, hash: "D".repeat(64) },
        { created_at: 101, hash: "A".repeat(64) },
        { created_at: 102, hash: "B".repeat(64) },
        { created_at: 9001, hash: "C".repeat(64) },
      ]),
    ).toEqual({
      knownExpectedMigrations: 2,
      knownAppliedMigrations: 2,
      knownAppliedRowsSha256: knownMigrationRowsSha256([
        { createdAt: 101, hash: "a".repeat(64) },
        { createdAt: 102, hash: "b".repeat(64) },
      ]),
      opaqueAppliedMigrations: 2,
      opaqueLegacyRowsSha256: opaqueMigrationRowsSha256(opaque),
      missingKnownMigrationTags: [],
    });
  });

  it("reproduces the frozen production-copy opaque-row digest", () => {
    expect(
      opaqueMigrationRowsSha256([
        {
          createdAt: 1783190993468,
          hash: "fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927",
        },
        {
          createdAt: 1783261969512,
          hash: "3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa",
        },
      ]),
    ).toBe(
      "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201",
    );
  });

  it("uses binary code-point ordering for canonical migration digests", () => {
    expect(
      knownMigrationRowsSha256([
        { createdAt: 7, hash: "_" },
        { createdAt: 7, hash: "$" },
        { createdAt: 7, hash: "9" },
      ]),
    ).toBe(
      "sha256:25c1e7f891c22c4c57c2f74312d6af869eec69e579446df0b750cc8c3193a6b8",
    );
  });

  it("does not let hash drift or a duplicate exact row satisfy known parity", () => {
    const result = classifyMigrationInventory(expected, [
      { created_at: 101, hash: "a".repeat(64) },
      { created_at: 101, hash: "a".repeat(64) },
      { created_at: 102, hash: "f".repeat(64) },
    ]);
    expect(result.knownAppliedMigrations).toBe(1);
    expect(result.opaqueAppliedMigrations).toBe(2);
    expect(result.missingKnownMigrationTags).toEqual(["0002_second"]);
  });

  it("rejects an ambiguous expected bundle", () => {
    expect(() =>
      classifyMigrationInventory(
        [...expected, { when: 101, tag: "duplicate", hash: "c".repeat(64) }],
        [],
      ),
    ).toThrow(/timestamps must be unique/);
  });

  it("requires an exact BUILD_SHA-bound runtime lineage in production", () => {
    const inventory = classifyMigrationInventory(expected, [
      { created_at: 101, hash: "a".repeat(64) },
      { created_at: 102, hash: "b".repeat(64) },
    ]);
    const binding = {
      schemaVersion: "site-logbook.runtime-migration-release-binding/v1",
      buildSha: "c".repeat(40),
      releaseEvidenceSha256: `sha256:${"d".repeat(64)}`,
      lineage: {
        decision: "ALREADY_0107",
        knownAppliedRowsSha256: inventory.knownAppliedRowsSha256,
        mode: "clean",
        knownExpectedMigrations: 2,
        knownAppliedMigrations: 2,
        latestKnownAppliedTag: "0002_second",
        missingKnownToPredecessor: 0,
        opaqueLegacyRowCount: 0,
        opaqueLegacyRowsSha256: opaqueMigrationRowsSha256([]),
        opaqueLegacyMeaningInferred: false,
        excludedMigration0100Present: false,
      },
    };
    const encoded = Buffer.from(JSON.stringify(binding)).toString("base64");
    expect(
      migrationReleaseBindingMatches(
        encoded,
        "c".repeat(40),
        "0002_second",
        inventory,
      ),
    ).toBe(true);
    expect(
      migrationReleaseBindingMatches(
        encoded,
        "e".repeat(40),
        "0002_second",
        inventory,
      ),
    ).toBe(false);
  });

  it("reproduces the frozen canonical-LF 0108 known-row digest", () => {
    const migrationsRoot = resolve(repositoryRoot, "lib/db/migrations");
    const journal = JSON.parse(
      readFileSync(resolve(migrationsRoot, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ when: number; tag: string }> };
    const rows = journal.entries.map((entry) => {
      const sql = readFileSync(
        resolve(migrationsRoot, `${entry.tag}.sql`),
        "utf8",
      ).replace(/\r\n/g, "\n");
      return {
        createdAt: entry.when,
        hash: createHash("sha256").update(sql).digest("hex"),
      };
    });

    expect(rows).toHaveLength(108);
    expect(knownMigrationRowsSha256(rows)).toBe(
      "sha256:2b18a1c2139f3a43b32bcf52f1bb3f7b8668cbbc5802de1788adc4b84bf90281",
    );
  });

  it("binds runtime parity to the signed exact-0108 lineage without a hard-coded count", () => {
    const inventory = {
      knownExpectedMigrations: 108,
      knownAppliedMigrations: 108,
      knownAppliedRowsSha256:
        "sha256:2b18a1c2139f3a43b32bcf52f1bb3f7b8668cbbc5802de1788adc4b84bf90281",
      opaqueAppliedMigrations: 2,
      opaqueLegacyRowsSha256:
        "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201",
      missingKnownMigrationTags: [],
    };
    const digest = `sha256:${"d".repeat(64)}`;
    const binding = createProductionRuntimeBinding({
      sourceSha: "c".repeat(40),
      apiImage: `ghcr.io/modvolt/site-logbook-api@sha256:${"a".repeat(64)}`,
      apiImageDigest: `sha256:${"a".repeat(64)}`,
      publicationReceiptSha256: digest,
      reviewedImageSetSha256: digest,
      apiRunnableManifestDigest: digest,
      apiOciProvenanceSha256: digest,
      postgresImage: `postgres@sha256:${"b".repeat(64)}`,
      targetEvidenceSha256: digest,
      releaseEvidenceSha256: digest,
      resolvedComposeSha256: digest,
      deployedConfigSha256: digest,
      desiredConfigSha256: digest,
      livePostgresTargetSha256: digest,
      databaseName: "site_logbook",
      databaseUser: "site_logbook_runtime",
      schemaFingerprintSha256: digest,
      preMigrationBackupEvidenceSha256: digest,
      backupIntegritySha256: digest,
      transitionChainSha256: digest,
      activationApprovalSha256: digest,
      invoiceSchemaProjectionSha256: digest,
      invoice0108MigrationReceiptSha256: digest,
      invoice0108RoleReceiptSha256: digest,
      lineage: {
        decision: "ALREADY_0108",
        mode: "production-copy-restricted",
        knownExpectedMigrations: 108,
        knownAppliedMigrations: 108,
        knownAppliedRowsSha256: inventory.knownAppliedRowsSha256,
        latestKnownAppliedTag: "0108_invoice_source_allocations_and_advances",
        missingKnownToPredecessor: 0,
        opaqueLegacyRowCount: 2,
        opaqueLegacyRowsSha256: inventory.opaqueLegacyRowsSha256,
        opaqueLegacyMeaningInferred: false,
        excludedMigration0100Present: false,
      },
    });
    expect(binding).toMatchObject({
      invoiceSchemaProjectionSha256: digest,
      invoice0108MigrationReceiptSha256: digest,
      invoice0108RoleReceiptSha256: digest,
    });
    expect(
      productionRuntimeBindingMatches(
        binding,
        "c".repeat(40),
        "0108_invoice_source_allocations_and_advances",
        inventory,
      ),
    ).toBe(true);
    expect(
      productionRuntimeBindingMatches(
        {
          ...binding,
          lineage: { ...binding.lineage, decision: "ALREADY_0107" },
        },
        "c".repeat(40),
        "0108_invoice_source_allocations_and_advances",
        inventory,
      ),
    ).toBe(false);
  });
});
