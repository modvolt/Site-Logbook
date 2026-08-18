import { createHash } from "node:crypto";

export const PRODUCTION_MIGRATION_PLAN_SCHEMA =
  "site-logbook.production-migration-plan/v2";
export const PRODUCTION_MIGRATION_INTENT_SCHEMA =
  "site-logbook.production-migration-intent/v1";
export const PRODUCTION_MIGRATION_STEP_RECEIPT_SCHEMA =
  "site-logbook.production-migration-step-receipt/v1";
export const PRODUCTION_MIGRATION_TRANSITION_CHAIN_SCHEMA =
  "site-logbook.production-migration-transition-chain/v1";
export const PRODUCTION_MIGRATION_INTENT_PERSISTENCE_SCHEMA =
  "site-logbook.production-migration-intent-persistence-receipt/v1";
export const PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA =
  "site-logbook.production-migration-transaction-evidence/v1";
export const PRODUCTION_MIGRATION_RESUME_COMMAND_SCHEMA =
  "site-logbook.production-migration-resume-command/v1";
export const PRODUCTION_MIGRATION_LIVE_IDENTITY_SCHEMA =
  "site-logbook.production-migration-live-identity/v1";
export const PRODUCTION_MIGRATION_ROLE_PRECONDITION_SCHEMA =
  "site-logbook.production-migration-role-precondition/v1";

export const PRODUCTION_MIGRATION_CONFIRMATION =
  "APPLY_0096_TO_0107_EXACT_MODVOLT_PRODUCTION";
export const PRODUCTION_MIGRATION_RESUME_CONFIRMATION =
  "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP";
export const PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY = 911072468;
export const PRODUCTION_MIGRATION_MAX_ARTIFACT_BYTES = 512 * 1024;
export const PRODUCTION_MIGRATION_MAX_STRING_BYTES = 16 * 1024;

export const PRODUCTION_MIGRATION_BASELINE = Object.freeze({
  knownAppliedMigrations: 97,
  latestKnownAppliedTag: "0096_far_smiling_tiger",
  knownAppliedRowsSha256:
    "sha256:fe26ddc43d40d91030a34c116695e92c54ea355f8149e245f4afabe8276693b5",
  totalJournalRows: 99,
});

export const PRODUCTION_MIGRATION_TARGET = Object.freeze({
  knownAppliedMigrations: 107,
  latestKnownAppliedTag: "0107_canonical_audit_evidence",
  knownAppliedRowsSha256:
    "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
  totalJournalRows: 109,
});

export const PRODUCTION_OPAQUE_LEGACY_ROWS = Object.freeze([
  Object.freeze({
    createdAt: 1783190993468,
    hash: "fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927",
  }),
  Object.freeze({
    createdAt: 1783261969512,
    hash: "3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa",
  }),
]);

export const PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256 =
  "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201";

const STEP_DEFINITIONS = [
  [
    97,
    1786383360000,
    "0097_session_and_api_idempotency",
    "044213e7839f6ef3a1e21eb4fb1c20e647c4aa3bdf3fa4568d5aa6d5391e4f0c",
  ],
  [
    98,
    1786383361000,
    "0098_object-upload-ledger",
    "81a242c900b84ba7737b0a04a6bd42bc8d441d4f8c3810227afc8abf6620872d",
  ],
  [
    99,
    1786383362000,
    "0099_secret_envelope_encryption",
    "b7855b69eb2d8b40611491fd227bfc6b0cffc762f88083aa609ffaf0b1a714d7",
  ],
  [
    101,
    1786383363000,
    "0101_public_access_token_lifecycle",
    "547da09b04825b7e0b9fb29f26d1838d666e0cf72b8d1e5b0d51eeffbb4510d2",
  ],
  [
    102,
    1786383364000,
    "0102_immutable_job_quote_versions",
    "fc6ca9c120602629948047a8d545fb1ae7f7992f259ec818e5b90461ac64e05f",
  ],
  [
    103,
    1786383365000,
    "0103_durable_operational_incident_outbox",
    "7f2c2091dfb98039184f87241efceccb301e0511fe7e1e6358ed462ba6fa7628",
  ],
  [
    104,
    1786383366000,
    "0104_thin_sheva_callister",
    "f35f5d418a7961ed34b5dc23bd563b83bf03cb911c74a0d0dca254f5bfef7e7a",
  ],
  [
    105,
    1786383367000,
    "0105_smooth_nitro",
    "a7ecbfc67e2d91885ac554e958d66922246ddc32383271cfc336d075acc31a71",
  ],
  [
    106,
    1786459128910,
    "0106_graceful_frog_thor",
    "697c9fe4980821769b0c053b5e7061c204fa3ded8328a5aef3f18476f5720bbd",
  ],
  [
    107,
    1786484628859,
    "0107_canonical_audit_evidence",
    "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
  ],
];

const PREFIX_DIGESTS = [
  "fe26ddc43d40d91030a34c116695e92c54ea355f8149e245f4afabe8276693b5",
  "ea9ad9afc464ce710f541af7efbb1dcc6039b2b101e2cc4a85c9086ca94e53d8",
  "a7356d88dd638a542a10b2949a641ce0a661b68427d9f5ba4aa435e367c45dc3",
  "a3be66523ad28f3f8c7acd0696fccaaaef4c9cd757a4b2f6bedf0f98e634836a",
  "799e316a6ff3a604609878f6e59f85089a924e370526909bf9d86c232e911bf5",
  "6e5bc29f96df4bd74bf5e0d243a33f24f87aeb1ac1f6f470e5d1c071633196de",
  "063c21e11db549d6a5d63905d73f3334ab2c7a4b47ce937fb15a71f8a9af5fb0",
  "705d690803743adb0f29e1014d8f6e86e82493820c9ab027f898a31800a9f632",
  "8e020d38845dbf9beb337482e1b5905c0f00d8d64f35d7be67edd1cc6520c3d6",
  "cfbf74de83f99c3ca49fb717a6784265e8ef193e75e894aab9924fb7b80e16ee",
  "c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
];

export const PRODUCTION_MIGRATION_STEPS = Object.freeze(
  STEP_DEFINITIONS.map(([idx, when, tag, hash], index) =>
    Object.freeze({
      sequence: index + 1,
      idx,
      when,
      tag,
      sqlSha256: `sha256:${hash}`,
      knownCountBefore: 97 + index,
      knownCountAfter: 98 + index,
      knownRowsSha256Before: `sha256:${PREFIX_DIGESTS[index]}`,
      knownRowsSha256After: `sha256:${PREFIX_DIGESTS[index + 1]}`,
    }),
  ),
);

export const PRODUCTION_MIGRATION_PREFIX_STATES = Object.freeze(
  PREFIX_DIGESTS.map((digest, index) =>
    Object.freeze({
      stateIndex: index,
      knownAppliedMigrations: 97 + index,
      knownAppliedRowsSha256: `sha256:${digest}`,
      latestKnownAppliedTag:
        index === 0
          ? PRODUCTION_MIGRATION_BASELINE.latestKnownAppliedTag
          : PRODUCTION_MIGRATION_STEPS[index - 1].tag,
      missingKnownMigrationTags: Object.freeze(
        PRODUCTION_MIGRATION_STEPS.slice(index).map((step) => step.tag),
      ),
      totalJournalRows: 99 + index,
    }),
  ),
);

export class ProductionMigrationContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionMigrationContractError";
    this.code = code;
  }
}

export function productionMigrationFail(code, message) {
  throw new ProductionMigrationContractError(code, message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

const FORBIDDEN_KEY =
  /^(?:.*(?:password|passwd|secret|token|credential|private.?key|database.?url|access.?key|cookie).*)$/i;
const FORBIDDEN_VALUE =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|\bBearer\s+[A-Za-z0-9._~+/-]+=*|[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/i;

export function assertProductionMigrationSecretFree(value, field = "artifact") {
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.test(value)) {
      productionMigrationFail(
        "PRODUCTION_MIGRATION_SECRET_MATERIAL",
        `${field} contains forbidden secret-shaped material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertProductionMigrationSecretFree(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      productionMigrationFail(
        "PRODUCTION_MIGRATION_SECRET_MATERIAL",
        `${field} contains a forbidden secret field.`,
      );
    }
    assertProductionMigrationSecretFree(entry, `${field}.${key}`);
  }
}

export function canonicalProductionMigrationJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function productionMigrationSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function createProductionMigrationArtifact(value) {
  assertProductionMigrationSecretFree(value);
  const canonical = canonicalProductionMigrationJson(value);
  if (Buffer.byteLength(canonical) > PRODUCTION_MIGRATION_MAX_ARTIFACT_BYTES) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ARTIFACT_INVALID",
      "Artifact exceeds the reviewed size limit.",
    );
  }
  return Object.freeze({
    value: Object.freeze(value),
    canonical,
    sha256: productionMigrationSha256(canonical),
  });
}

export function exactObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_SCHEMA_INVALID",
      `${field} must contain only the reviewed fields.`,
    );
  }
  return value;
}

export function exactString(
  value,
  field,
  maximumBytes = PRODUCTION_MIGRATION_MAX_STRING_BYTES,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value) > maximumBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_SCHEMA_INVALID",
      `${field} must be exact bounded non-empty text without controls.`,
    );
  }
  assertProductionMigrationSecretFree(value, field);
  return value;
}

export function exactDigest(value, field) {
  const digest = exactString(value, field, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest) || /^sha256:0{64}$/.test(digest)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_DIGEST_INVALID",
      `${field} must be a non-zero SHA-256 digest.`,
    );
  }
  return digest;
}

export function exactSourceSha(value, field = "sourceSha") {
  const sha = exactString(value, field, 40);
  if (!/^[0-9a-f]{40}$/.test(sha) || /^0{40}$/.test(sha)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_SOURCE_INVALID",
      `${field} must be a non-zero exact Git SHA.`,
    );
  }
  return sha;
}

const LOWER_DATABASE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;

export function exactProductionMigrationDatabase(value, field = "database") {
  const database = exactObject(
    value,
    ["name", "sessionUser", "currentUser"],
    field,
  );
  for (const key of ["name", "sessionUser", "currentUser"]) {
    const identity = exactString(database[key], `${field}.${key}`, 63);
    if (!LOWER_DATABASE_IDENTIFIER.test(identity)) {
      productionMigrationFail(
        "PRODUCTION_MIGRATION_DATABASE_INVALID",
        `${field}.${key} must already be an exact lowercase PostgreSQL identifier.`,
      );
    }
  }
  if (database.sessionUser === database.currentUser) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_DATABASE_INVALID",
      `${field} must distinguish audited session user from SET ROLE migration owner.`,
    );
  }
  return Object.freeze({
    name: database.name,
    sessionUser: database.sessionUser,
    currentUser: database.currentUser,
  });
}

export function exactProductionMigrationImmutableImage(value, field) {
  const image = exactString(value, field, 512);
  if (!IMMUTABLE_IMAGE.test(image)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RUNTIME_IDENTITY_INVALID",
      `${field} must already be an exact lowercase digest-addressed image reference.`,
    );
  }
  return image;
}

export function parseProductionMigrationLiveIdentity(canonical, field) {
  const artifact = parseCanonicalProductionMigrationArtifact(canonical, field);
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "database",
      "applicationImageRef",
      "postgresImageRef",
      "runtimeBindingSha256",
      "inventory",
      "observedAt",
      "productionTargetsTouched",
      "authorizesProductionMigration",
    ],
    field,
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_LIVE_IDENTITY_SCHEMA ||
    value.kind !== "site-logbook-production-migration-live-identity" ||
    value.productionTargetsTouched !== false ||
    value.authorizesProductionMigration !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_LIVE_IDENTITY_INVALID",
      `${field} is not non-authorizing live production identity evidence.`,
    );
  }
  exactSourceSha(value.sourceSha, `${field}.sourceSha`);
  const database = exactProductionMigrationDatabase(
    value.database,
    `${field}.database`,
  );
  exactProductionMigrationImmutableImage(
    value.applicationImageRef,
    `${field}.applicationImageRef`,
  );
  exactProductionMigrationImmutableImage(
    value.postgresImageRef,
    `${field}.postgresImageRef`,
  );
  exactDigest(value.runtimeBindingSha256, `${field}.runtimeBindingSha256`);
  const state = validateProductionMigrationInventory(value.inventory);
  const observedAt = exactTimestamp(value.observedAt, `${field}.observedAt`);
  return Object.freeze({ artifact, value, database, state, observedAt });
}

export function createProductionMigrationLiveIdentity({
  sourceSha,
  database,
  applicationImageRef,
  postgresImageRef,
  runtimeBindingSha256,
  inventory,
  observedAt,
}) {
  const value = {
    schemaVersion: PRODUCTION_MIGRATION_LIVE_IDENTITY_SCHEMA,
    kind: "site-logbook-production-migration-live-identity",
    sourceSha: exactSourceSha(sourceSha),
    database: exactProductionMigrationDatabase(database),
    applicationImageRef: exactProductionMigrationImmutableImage(
      applicationImageRef,
      "applicationImageRef",
    ),
    postgresImageRef: exactProductionMigrationImmutableImage(
      postgresImageRef,
      "postgresImageRef",
    ),
    runtimeBindingSha256: exactDigest(
      runtimeBindingSha256,
      "runtimeBindingSha256",
    ),
    inventory: structuredClone(inventory),
    observedAt: new Date(
      exactTimestamp(observedAt, "observedAt"),
    ).toISOString(),
    productionTargetsTouched: false,
    authorizesProductionMigration: false,
  };
  validateProductionMigrationInventory(value.inventory);
  const artifact = createProductionMigrationArtifact(value);
  parseProductionMigrationLiveIdentity(artifact.canonical, "liveIdentity");
  return artifact;
}

export function exactTimestamp(value, field) {
  const timestamp = exactString(value, field);
  const parsed = new Date(timestamp);
  if (
    !timestamp.endsWith("Z") ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== timestamp
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      `${field} must be canonical UTC.`,
    );
  }
  return parsed.getTime();
}

export function parseCanonicalProductionMigrationArtifact(
  canonical,
  field,
  maximumBytes = PRODUCTION_MIGRATION_MAX_ARTIFACT_BYTES,
) {
  if (
    typeof canonical !== "string" ||
    Buffer.byteLength(canonical) === 0 ||
    Buffer.byteLength(canonical) > maximumBytes
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ARTIFACT_INVALID",
      `${field} is empty or too large.`,
    );
  }
  let value;
  try {
    value = JSON.parse(canonical);
  } catch {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ARTIFACT_INVALID",
      `${field} must be strict JSON.`,
    );
  }
  if (canonicalProductionMigrationJson(value) !== canonical) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ARTIFACT_INVALID",
      `${field} must be canonical JSON with one trailing LF.`,
    );
  }
  assertProductionMigrationSecretFree(value, field);
  return Object.freeze({
    value,
    canonical,
    sha256: productionMigrationSha256(canonical),
  });
}

export function validateFrozenOpaqueRows(rows, field = "opaqueLegacyRows") {
  if (!Array.isArray(rows)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_OPAQUE_DRIFT",
      `${field} must contain the two frozen rows.`,
    );
  }
  const normalized = rows.map((row, index) => {
    const value = exactObject(row, ["createdAt", "hash"], `${field}[${index}]`);
    if (
      !Number.isSafeInteger(value.createdAt) ||
      !/^[0-9a-f]{64}$/.test(value.hash) ||
      /^0{64}$/.test(value.hash)
    ) {
      productionMigrationFail(
        "PRODUCTION_MIGRATION_OPAQUE_DRIFT",
        `${field}[${index}] must preserve exact lowercase identity types.`,
      );
    }
    return {
      createdAt: value.createdAt,
      hash: value.hash,
    };
  });
  if (
    JSON.stringify(normalized) !==
      JSON.stringify(PRODUCTION_OPAQUE_LEGACY_ROWS) ||
    productionMigrationSha256(JSON.stringify(normalized)) !==
      PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_OPAQUE_DRIFT",
      "Opaque production rows changed, reordered, disappeared or were reinterpreted.",
    );
  }
  return Object.freeze(normalized);
}

export function validateProductionMigrationInventory(inventory) {
  const value = exactObject(
    inventory,
    [
      "knownAppliedMigrations",
      "knownAppliedRowsSha256",
      "latestKnownAppliedTag",
      "missingKnownMigrationTags",
      "unexpectedKnownMigrationTags",
      "opaqueLegacyRows",
      "excludedMigration0100Present",
      "totalJournalRows",
    ],
    "inventory",
  );
  if (value.excludedMigration0100Present !== false) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_0100_PRESENT",
      "Excluded migration 0100 must never be present.",
    );
  }
  if (
    !Array.isArray(value.unexpectedKnownMigrationTags) ||
    value.unexpectedKnownMigrationTags.length !== 0
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_UNEXPECTED_KNOWN",
      "Unexpected known migration tags are not admissible.",
    );
  }
  validateFrozenOpaqueRows(
    value.opaqueLegacyRows,
    "inventory.opaqueLegacyRows",
  );
  const digest = exactDigest(
    value.knownAppliedRowsSha256,
    "inventory.knownAppliedRowsSha256",
  );
  const state = PRODUCTION_MIGRATION_PREFIX_STATES.find(
    (candidate) =>
      candidate.knownAppliedMigrations === value.knownAppliedMigrations &&
      candidate.knownAppliedRowsSha256 === digest &&
      candidate.latestKnownAppliedTag === value.latestKnownAppliedTag &&
      candidate.totalJournalRows === value.totalJournalRows &&
      JSON.stringify(candidate.missingKnownMigrationTags) ===
        JSON.stringify(value.missingKnownMigrationTags),
  );
  if (!state) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_NON_PREFIX",
      "Live known lineage is not one exact reviewed prefix from 0096 through 0107.",
    );
  }
  return state;
}

export function frozenStateSummary(state) {
  return Object.freeze({
    knownAppliedMigrations: state.knownAppliedMigrations,
    knownAppliedRowsSha256: state.knownAppliedRowsSha256,
    latestKnownAppliedTag: state.latestKnownAppliedTag,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    totalJournalRows: state.totalJournalRows,
    excludedMigration0100Present: false,
  });
}
