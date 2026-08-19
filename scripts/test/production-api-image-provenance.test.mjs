import assert from "node:assert/strict";
import { generateKeyPairSync, sign as createSignature } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  IMAGE_PROVENANCE_SCHEMA,
  verifyProductionApiImageProvenanceArtifact,
  verifyProductionApiImageProvenanceArtifactWithTestAuthority,
} from "../production-evidence/host-attestation-contract.mjs";
import {
  PRODUCTION_API_IMAGE_PROVENANCE_CONFIRMATION,
  PRODUCTION_API_IMAGE_PROVENANCE_FILES,
  PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_KIND,
  PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_SCHEMA,
  ProductionApiImageProvenanceError,
  buildProductionPublisherCustodySpawnSpecForTest,
  runProductionApiImageProvenanceProducer,
  runProductionApiImageProvenanceProducerWithTestAuthority,
  runProductionPublisherCustodySignatureWithTestProcess,
} from "../production-evidence/production-api-image-provenance.mjs";
import {
  PRODUCTION_IMAGE_PUBLICATION_CALLER,
  PRODUCTION_IMAGE_PUBLICATION_KIND,
  PRODUCTION_IMAGE_PUBLICATION_SCHEMA,
  PRODUCTION_IMAGE_PUBLICATION_WORKFLOW,
  PRODUCTION_IMAGE_SPECS,
  canonicalJson,
  reviewedImageSetSha256,
  sealProductionImagePublicationReceipt,
  sha256,
} from "../production-evidence/production-image-publication-contract.mjs";

const SOURCE_SHA = "d563af036b25c9afd97a43a3a3af79e095008d48";
const TREE_SHA = "1".repeat(40);
const WORKFLOW_SHA = "2".repeat(40);
const PREFLIGHT_RECEIPT_SHA = `sha256:${"3".repeat(64)}`;
const COMPLETE_RUN_ID = "31540000002";
const COMPLETE_RUN_ATTEMPT = "1";
const KEY_ID = "ed25519:test-production-publisher";

function digest(value) {
  return sha256(`fixture:${value}`);
}

function imageFixture(key, stage, index) {
  const spec = PRODUCTION_IMAGE_SPECS[key];
  const imageDigest = digest(String.fromCharCode(97 + index));
  const runnableManifestDigest = digest(String.fromCharCode(100 + index));
  const configDigest = digest(String.fromCharCode(103 + index));
  const layers = [
    {
      digest: digest(String.fromCharCode(106 + index * 2)),
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      size: 1234 + index,
    },
    {
      digest: digest(String.fromCharCode(107 + index * 2)),
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      size: 2345 + index,
    },
  ];
  const filesystemProjection = {
    format: "oci-layer-manifest/v1",
    configDigest,
    layers,
    entryCount: layers.length,
  };
  return {
    component: spec.component,
    repository: spec.repository,
    image: `${spec.repository}@${imageDigest}`,
    digest: imageDigest,
    runnableManifestDigest,
    configDigest,
    sourceSha: SOURCE_SHA,
    platform: "linux/amd64",
    visibility: "private",
    published: stage === "complete",
    registryVerified: stage === "complete",
    registryEvidenceSha256:
      stage === "complete" ? digest(`registry-${key}`) : null,
    build: {
      dockerfile: spec.dockerfile,
      target: spec.target,
      buildArg: spec.buildArg,
      buildArgValue: SOURCE_SHA,
      imageProfile: spec.imageProfile,
      mutatingEntrypointsPresent: spec.mutatingEntrypointsPresent,
    },
    provenance: {
      mediaType: "application/vnd.in-toto+json",
      sha256: digest(String.fromCharCode(112 + index)),
      buildType: "https://mobyproject.org/buildkit@v1",
      vcsSource: "https://github.com/modvolt/Site-Logbook",
      vcsRevision: SOURCE_SHA,
      dockerfile: spec.dockerfile,
      target: spec.target,
      buildArg: spec.buildArg,
      buildArgValue: SOURCE_SHA,
    },
    sbom: {
      mediaType: "application/spdx+json",
      sha256: digest(String.fromCharCode(115 + index)),
      spdxVersion: "SPDX-2.3",
      packageCount: 50 + index,
      relationshipCount: 49 + index,
    },
    filesystemManifest: {
      ...filesystemProjection,
      sha256: sha256(canonicalJson(filesystemProjection)),
    },
    ociArchive: {
      sha256: digest(`archive-${key}`),
      sizeBytes: 10_000 + index,
      indexDigest: imageDigest,
    },
  };
}

function receiptFixture(stage = "complete") {
  const currentRunId =
    stage === "preflight-only" ? "31540000001" : COMPLETE_RUN_ID;
  const preflightRunId = "31540000001";
  const publicationNonceSha256 = digest("publication-nonce");
  const images = {
    api: imageFixture("api", stage, 0),
    controlPlane: imageFixture("controlPlane", stage, 1),
    hostOperator: imageFixture("hostOperator", stage, 2),
    web: imageFixture("web", stage, 3),
  };
  const singleUseKeySha256 = sha256(
    canonicalJson({
      sourceSha: SOURCE_SHA,
      preflightRunId,
      publicationNonceSha256,
    }),
  );
  return {
    schemaVersion: PRODUCTION_IMAGE_PUBLICATION_SCHEMA,
    kind: PRODUCTION_IMAGE_PUBLICATION_KIND,
    publicationStage: stage,
    source: {
      repository: "modvolt/Site-Logbook",
      ref: "refs/heads/main",
      sha: SOURCE_SHA,
      treeSha: TREE_SHA,
      mergeParentShas: ["4".repeat(40), "5".repeat(40)],
      qualityGate: {
        workflowName: "Quality gate",
        workflowPath: ".github/workflows/quality-gate.yml",
        event: "push",
        headBranch: "main",
        headSha: SOURCE_SHA,
        runId: "31530000001",
        runAttempt: "1",
        conclusion: "success",
      },
    },
    caller: {
      repository: PRODUCTION_IMAGE_PUBLICATION_CALLER.repository,
      repositoryId: "987654321",
      workflowRef: PRODUCTION_IMAGE_PUBLICATION_CALLER.workflowRef,
      workflowSha: WORKFLOW_SHA,
      eventName: "workflow_dispatch",
      ref: "refs/heads/main",
      actor: "modvolt",
      actorId: "289280891",
      triggeringActor: "modvolt",
      runId: currentRunId,
      runAttempt: COMPLETE_RUN_ATTEMPT,
    },
    publisher: {
      repository: "modvolt/Site-Logbook",
      workflowPath: PRODUCTION_IMAGE_PUBLICATION_WORKFLOW,
      jobWorkflowRef: `modvolt/Site-Logbook/${PRODUCTION_IMAGE_PUBLICATION_WORKFLOW}@${SOURCE_SHA}`,
      sourceSha: SOURCE_SHA,
      workflowFileSha256: digest("workflow"),
    },
    chain:
      stage === "preflight-only"
        ? {
            preflightReceiptSha256: null,
            preflightRunId: null,
            preflightRunAttempt: null,
            preflightArtifactId: null,
            preflightArtifactDigest: null,
            preflightArtifactCreatedAt: null,
            preflightArtifactExpiresAt: null,
            preflightCreatedAt: null,
            publicationNonceSha256,
            singleUseKeySha256,
            reviewedImageSetSha256: reviewedImageSetSha256(images),
          }
        : {
            preflightReceiptSha256: PREFLIGHT_RECEIPT_SHA,
            preflightRunId,
            preflightRunAttempt: "1",
            preflightArtifactId: "456789",
            preflightArtifactDigest: digest("artifact"),
            preflightArtifactCreatedAt: "2026-08-18T12:01:00.000Z",
            preflightArtifactExpiresAt: "2026-08-21T12:01:00.000Z",
            preflightCreatedAt: "2026-08-18T12:00:00.000Z",
            publicationNonceSha256,
            singleUseKeySha256,
            reviewedImageSetSha256: reviewedImageSetSha256(images),
          },
    policy: {
      registryWritePermitted: stage === "complete",
      packagesVisibility: "private",
      platform: "linux/amd64",
      productionTargetsTouched: false,
      deploymentAuthorized: false,
      migrationAuthorized: false,
    },
    images,
    createdAt: "2026-08-18T12:00:00.000Z",
  };
}

function apiOciProvenanceFixture(image) {
  return {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [
      {
        name: `pkg:docker/${PRODUCTION_IMAGE_SPECS.api.repository}@${SOURCE_SHA}?platform=linux%2Famd64`,
        digest: {
          sha256: image.runnableManifestDigest.slice("sha256:".length),
        },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v0.2",
    predicate: {
      buildType: image.provenance.buildType,
      invocation: {
        configSource: { entryPoint: "Dockerfile" },
        parameters: {
          args: {
            [`build-arg:${image.provenance.buildArg}`]: SOURCE_SHA,
            target: image.provenance.target,
          },
          root: {
            request: {
              args: {
                "vcs:localdir:dockerfile": "artifacts/api-server",
                "vcs:revision": SOURCE_SHA,
                "vcs:source": "https://github.com/modvolt/Site-Logbook",
              },
            },
          },
        },
      },
      metadata: {
        "https://mobyproject.org/buildkit@v1#metadata": {
          vcs: {
            source: "https://github.com/modvolt/Site-Logbook",
            revision: SOURCE_SHA,
          },
        },
      },
    },
  };
}

function publicationBinding(stage = "complete", options = {}) {
  const receipt = receiptFixture(stage);
  const provenanceValue = apiOciProvenanceFixture(receipt.images.api);
  options.mutateApiOciProvenance?.(provenanceValue);
  const apiOciProvenanceRaw = Buffer.from(
    options.apiOciProvenanceRaw ?? JSON.stringify(provenanceValue),
    "utf8",
  );
  receipt.images.api.provenance.sha256 = sha256(apiOciProvenanceRaw);
  receipt.chain.reviewedImageSetSha256 = reviewedImageSetSha256(receipt.images);
  return Object.freeze({
    publication: sealProductionImagePublicationReceipt(receipt),
    apiOciProvenanceRaw,
  });
}

function publicKeyPin(publicKey) {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

async function context(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "site-logbook-api-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  await mkdir(vault, { mode: 0o700 });
  const outputParent = options.separateOutputParent
    ? join(root, "output-parent")
    : root;
  if (options.separateOutputParent) {
    await mkdir(outputParent, { mode: 0o700 });
  }
  const outputDirectory = join(
    outputParent,
    options.outputName ?? "evidence-output",
  );
  const publicationReceipt = join(root, "complete-publication-receipt.json");
  const apiOciProvenance = join(root, "api-provenance.intoto.json");
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
  const binding =
    options.binding ??
    publicationBinding(options.stage, {
      apiOciProvenanceRaw: options.apiOciProvenanceRaw,
      mutateApiOciProvenance: options.mutateApiOciProvenance,
    });
  const publication = binding.publication;
  const receiptRaw = options.receiptRaw ?? publication.canonical;
  await writeFile(publicationReceipt, receiptRaw, { mode: 0o600 });
  await writeFile(apiOciProvenance, binding.apiOciProvenanceRaw, {
    mode: 0o600,
  });
  let signerCalls = 0;
  const signer =
    options.signWithCustody ??
    (async ({ input, output }) => {
      signerCalls += 1;
      const bytes = await readFile(input);
      await writeFile(output, createSignature(null, bytes, pair.privateKey), {
        flag: "wx",
        mode: 0o600,
      });
    });
  return {
    root,
    vault,
    outputDirectory,
    outputParent,
    publicationReceipt,
    apiOciProvenance,
    publication,
    pair,
    authority: {
      trustedPublisherKeys: { [KEY_ID]: publicPem },
      expectedPublisherPublicKeySha256: publicKeyPin(pair.publicKey),
      signWithCustody: signer,
    },
    request: {
      publicationReceipt,
      publicationReceiptSha256: sha256(receiptRaw),
      apiOciProvenance,
      sourceSha: SOURCE_SHA,
      completeRunId:
        options.stage === "preflight-only" ? "31540000001" : COMPLETE_RUN_ID,
      completeRunAttempt: COMPLETE_RUN_ATTEMPT,
      apiImage: publication.receipt.images.api.image,
      apiOciProvenanceSha256: publication.receipt.images.api.provenance.sha256,
      publisherKeyId: KEY_ID,
      vault,
      outputDirectory,
      confirmation: PRODUCTION_API_IMAGE_PROVENANCE_CONFIRMATION,
    },
    signerCalls: () => signerCalls,
  };
}

function expectProducerCode(code) {
  return (error) =>
    error instanceof ProductionApiImageProvenanceError && error.code === code;
}

function fakeCustodyChild(pid = 4242) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

function closeFakeCustodyChild(child, code, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, signal);
}

test("binds the raw API subject to the publication contract repository", () => {
  assert.equal(
    PRODUCTION_IMAGE_SPECS.api.repository,
    "ghcr.io/modvolt/site-logbook-production-api",
  );
  assert.equal(
    apiOciProvenanceFixture(imageFixture("api", "complete", 0)).subject[0].name,
    `pkg:docker/ghcr.io/modvolt/site-logbook-production-api@${SOURCE_SHA}?platform=linux%2Famd64`,
  );
});

test("derives, custody-signs and durably publishes exact host-parser provenance", async (t) => {
  const fixture = await context(t);
  const result = await runProductionApiImageProvenanceProducerWithTestAuthority(
    fixture.request,
    fixture.authority,
  );
  assert.equal(fixture.signerCalls(), 1);
  assert.equal(result.productionTargetsTouched, false);
  assert.equal(result.privateMaterialPrinted, false);

  const provenanceRaw = await readFile(
    join(
      fixture.outputDirectory,
      PRODUCTION_API_IMAGE_PROVENANCE_FILES.provenance,
    ),
    "utf8",
  );
  const signature = await readFile(
    join(
      fixture.outputDirectory,
      PRODUCTION_API_IMAGE_PROVENANCE_FILES.signature,
    ),
  );
  const productionReceiptRaw = await readFile(
    join(
      fixture.outputDirectory,
      PRODUCTION_API_IMAGE_PROVENANCE_FILES.receipt,
    ),
    "utf8",
  );
  const provenance = JSON.parse(provenanceRaw);
  assert.equal(canonicalJson(provenance), provenanceRaw);
  assert.deepEqual(provenance, {
    buildProfile: "production",
    keyId: KEY_ID,
    mutatingEntrypointsPresent: false,
    ociProvenanceSha256:
      fixture.publication.receipt.images.api.provenance.sha256,
    publicationReceiptSha256: fixture.publication.sha256,
    reviewedImageSetSha256:
      fixture.publication.receipt.chain.reviewedImageSetSha256,
    schemaVersion: IMAGE_PROVENANCE_SCHEMA,
    sourceSha: SOURCE_SHA,
    subjectDigest: fixture.publication.receipt.images.api.digest,
    subjectImage: fixture.publication.receipt.images.api.image,
    subjectRunnableManifestDigest:
      fixture.publication.receipt.images.api.runnableManifestDigest,
  });
  assert.throws(
    () =>
      verifyProductionApiImageProvenanceArtifact(
        {
          canonical: provenanceRaw,
          signature,
          sourceSha: SOURCE_SHA,
          expectedApiImage: fixture.publication.receipt.images.api.image,
        },
        { trustedImageProvenanceKeys: fixture.authority.trustedPublisherKeys },
      ),
    /PRODUCTION_HOST_PROVENANCE_AUTHORITY_INVALID/,
  );
  const verified = verifyProductionApiImageProvenanceArtifactWithTestAuthority(
    {
      canonical: provenanceRaw,
      signature,
      sourceSha: SOURCE_SHA,
      expectedApiImage: fixture.publication.receipt.images.api.image,
    },
    { trustedImageProvenanceKeys: fixture.authority.trustedPublisherKeys },
  );
  assert.equal(verified.sha256, result.provenanceSha256);
  assert.equal(verified.publicationReceiptSha256, fixture.publication.sha256);
  assert.equal(
    verified.reviewedImageSetSha256,
    fixture.publication.receipt.chain.reviewedImageSetSha256,
  );
  assert.equal(
    verified.subjectRunnableManifestDigest,
    fixture.publication.receipt.images.api.runnableManifestDigest,
  );
  assert.equal(
    verified.ociProvenanceSha256,
    fixture.publication.receipt.images.api.provenance.sha256,
  );

  const productionReceipt = JSON.parse(productionReceiptRaw);
  assert.equal(canonicalJson(productionReceipt), productionReceiptRaw);
  assert.equal(
    productionReceipt.schemaVersion,
    PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_SCHEMA,
  );
  assert.equal(
    productionReceipt.kind,
    PRODUCTION_API_IMAGE_PROVENANCE_RECEIPT_KIND,
  );
  assert.equal(
    productionReceipt.publication.receiptSha256,
    fixture.publication.sha256,
  );
  assert.equal(
    productionReceipt.publication.apiOciProvenanceSha256,
    fixture.publication.receipt.images.api.provenance.sha256,
  );
  assert.equal(productionReceipt.output.provenanceSha256, verified.sha256);
  assert.equal(productionReceipt.output.signatureSha256, sha256(signature));
  assert.deepEqual(productionReceipt.policy, {
    additionalRegistryWritePerformed: false,
    applicationStartAuthorized: false,
    deploymentAuthorized: false,
    migrationAuthorized: false,
    persistenceMode: "exclusive-directory-hardlink-fsync-readback",
    privateMaterialPrinted: false,
    productionTargetsTouched: false,
  });
  for (const name of Object.values(PRODUCTION_API_IMAGE_PROVENANCE_FILES)) {
    const state = await lstat(join(fixture.outputDirectory, name));
    assert.equal(state.isFile(), true);
    assert.equal(state.nlink, 1);
  }
  assert.deepEqual((await readdir(fixture.root)).sort(), [
    "api-provenance.intoto.json",
    "complete-publication-receipt.json",
    "evidence-output",
    "vault",
  ]);
});

test("is default-dark and production entrypoint refuses authority injection", async (t) => {
  const fixture = await context(t);
  await assert.rejects(
    runProductionApiImageProvenanceProducerWithTestAuthority(
      { ...fixture.request, confirmation: "YES" },
      fixture.authority,
    ),
    expectProducerCode("PRODUCTION_API_PROVENANCE_DARK"),
  );
  assert.equal(fixture.signerCalls(), 0);
  await assert.rejects(
    runProductionApiImageProvenanceProducer(fixture.request, fixture.authority),
    expectProducerCode("PRODUCTION_API_PROVENANCE_AUTHORITY_INVALID"),
  );
});

test("default custody process uses exact purpose, sanitized env and bounded tree close", async (t) => {
  const request = {
    vault: "C:\\reviewed-vault",
    input: "C:\\reviewed-stage\\input.json",
    output: "C:\\reviewed-stage\\signature.raw",
  };
  const hostileEnvironment = {
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\safe-temp",
    TMP: "C:\\safe-temp",
    USERPROFILE: "C:\\Users\\operator",
    NODE_OPTIONS: "--require C:\\attacker.js",
    NODE_PATH: "C:\\attacker-modules",
    GH_TOKEN: "ghp_fixture_token_that_must_not_cross",
    DATABASE_URL: "postgres://fixture:fixture@example.invalid/db",
    PATH: "C:\\unreviewed-bin",
  };
  const spec = buildProductionPublisherCustodySpawnSpecForTest(
    request,
    hostileEnvironment,
  );
  assert.deepEqual(spec.args.slice(1), [
    "sign",
    "--vault",
    request.vault,
    "--purpose",
    "publisher-provenance",
    "--input",
    request.input,
    "--output",
    request.output,
  ]);
  assert.deepEqual(spec.options.env, {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\safe-temp",
    TMP: "C:\\safe-temp",
    USERPROFILE: "C:\\Users\\operator",
  });
  for (const forbidden of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "GH_TOKEN",
    "DATABASE_URL",
    "PATH",
  ]) {
    assert.equal(Object.hasOwn(spec.options.env, forbidden), false);
  }

  await t.test("success path uses the reviewed spawn spec", async () => {
    const child = fakeCustodyChild();
    let captured;
    const run = runProductionPublisherCustodySignatureWithTestProcess(request, {
      sourceEnvironment: hostileEnvironment,
      spawnChild: (command, args, options) => {
        captured = { command, args, options };
        setImmediate(() => closeFakeCustodyChild(child, 0));
        return child;
      },
      terminateTree: async () => assert.fail("must not terminate success"),
      timeoutMs: 100,
      terminationTimeoutMs: 100,
    });
    await run;
    assert.deepEqual(captured.args, spec.args);
    assert.deepEqual(captured.options.env, spec.options.env);
  });

  await t.test("timeout waits for tree close before rejecting", async () => {
    const child = fakeCustodyChild(4243);
    let terminated = false;
    let closed = false;
    await assert.rejects(
      runProductionPublisherCustodySignatureWithTestProcess(request, {
        sourceEnvironment: hostileEnvironment,
        spawnChild: () => child,
        terminateTree: async (target) => {
          terminated = true;
          setTimeout(() => {
            closed = true;
            closeFakeCustodyChild(target, null, "SIGKILL");
          }, 20);
          return true;
        },
        timeoutMs: 10,
        terminationTimeoutMs: 200,
      }),
      expectProducerCode("PRODUCTION_API_PROVENANCE_CUSTODY_FAILED"),
    );
    assert.equal(terminated, true);
    assert.equal(closed, true);
  });

  await t.test("output overflow terminates and awaits the tree", async () => {
    const child = fakeCustodyChild(4244);
    let terminated = false;
    await assert.rejects(
      runProductionPublisherCustodySignatureWithTestProcess(request, {
        sourceEnvironment: hostileEnvironment,
        spawnChild: () => {
          setImmediate(() => child.stdout.write(Buffer.alloc(20 * 1024, 1)));
          return child;
        },
        terminateTree: async (target) => {
          terminated = true;
          setImmediate(() => closeFakeCustodyChild(target, null, "SIGKILL"));
          return true;
        },
        timeoutMs: 200,
        terminationTimeoutMs: 200,
      }),
      expectProducerCode("PRODUCTION_API_PROVENANCE_CUSTODY_FAILED"),
    );
    assert.equal(terminated, true);
  });

  await t.test(
    "tree-kill failure closes only the parent and stays explicitly unverified",
    async () => {
      const child = fakeCustodyChild(4245);
      let parentKillCalls = 0;
      let failure;
      child.kill = () => {
        parentKillCalls += 1;
        setImmediate(() => closeFakeCustodyChild(child, null, "SIGKILL"));
        return true;
      };
      await assert.rejects(
        runProductionPublisherCustodySignatureWithTestProcess(request, {
          sourceEnvironment: hostileEnvironment,
          spawnChild: () => child,
          terminateTree: async () => false,
          timeoutMs: 10,
          terminationTimeoutMs: 200,
        }),
        (error) => {
          failure = error;
          return expectProducerCode(
            "PRODUCTION_API_PROVENANCE_CUSTODY_TREE_TERMINATION_UNVERIFIED",
          )(error);
        },
      );
      assert.equal(parentKillCalls, 1);
      assert.doesNotMatch(failure.message, /process tree was terminated/u);
    },
  );
});

test("requires exact complete receipt, source, run, image and OCI provenance bindings", async (t) => {
  const mutations = [
    [
      "receipt digest",
      (request) => (request.publicationReceiptSha256 = digest("wrong")),
    ],
    ["source", (request) => (request.sourceSha = "a".repeat(40))],
    ["run id", (request) => (request.completeRunId = "999")],
    ["run attempt", (request) => (request.completeRunAttempt = "2")],
    [
      "image",
      (request) =>
        (request.apiImage =
          "ghcr.io/modvolt/site-logbook-production-api@sha256:" +
          "b".repeat(64)),
    ],
    [
      "OCI provenance",
      (request) =>
        (request.apiOciProvenanceSha256 = digest("wrong-provenance")),
    ],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (nested) => {
      const fixture = await context(nested, {
        outputName: `out-${label.replaceAll(" ", "-")}`,
      });
      const request = structuredClone(fixture.request);
      mutate(request);
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          request,
          fixture.authority,
        ),
        /PRODUCTION_(?:API_PROVENANCE|IMAGE)_/,
      );
      assert.equal(fixture.signerCalls(), 0);
      await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
    });
  }
});

test("rejects preflight-only, noncanonical and internally drifted publication inputs", async (t) => {
  await t.test("preflight-only", async (nested) => {
    const fixture = await context(nested, { stage: "preflight-only" });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      /PRODUCTION_IMAGE_BINDING_INVALID/,
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("noncanonical", async (nested) => {
    const canonical = sealProductionImagePublicationReceipt(
      receiptFixture("complete"),
    ).canonical;
    const fixture = await context(nested, { receiptRaw: `${canonical}\n` });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      /PRODUCTION_IMAGE_ARTIFACT_INVALID/,
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("four-image drift", async (nested) => {
    const binding = publicationBinding();
    const value = structuredClone(binding.publication.receipt);
    value.images.web.sourceSha = "a".repeat(40);
    const raw = canonicalJson(value);
    const fixture = await context(nested, { binding, receiptRaw: raw });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      /PRODUCTION_IMAGE_BINDING_INVALID/,
    );
    assert.equal(fixture.signerCalls(), 0);
  });
});

test("requires the exact raw API OCI provenance bytes and semantics", async (t) => {
  await t.test(
    "growth after open is bounded at limit plus one",
    async (nested) => {
      const fixture = await context(nested);
      let hookCalls = 0;
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          fixture.request,
          {
            ...fixture.authority,
            testHooks: {
              beforeInputRead: async ({ field, maxBytes }) => {
                if (field !== "publicationReceipt") return;
                hookCalls += 1;
                await writeFile(
                  fixture.publicationReceipt,
                  Buffer.alloc(maxBytes + 2, 0x20),
                  { flag: "a" },
                );
              },
            },
          },
        ),
        expectProducerCode("PRODUCTION_API_PROVENANCE_INPUT_INVALID"),
      );
      assert.equal(hookCalls, 1);
      assert.equal(fixture.signerCalls(), 0);
      await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
    },
  );

  await t.test("byte digest drift", async (nested) => {
    const fixture = await context(nested);
    await writeFile(fixture.apiOciProvenance, '{"tampered":true}', {
      mode: 0o600,
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_BINDING_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("invalid JSON", async (nested) => {
    const fixture = await context(nested, {
      apiOciProvenanceRaw: "not-json",
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test(
    "duplicate decoded key hiding secret material",
    async (nested) => {
      const provenance = apiOciProvenanceFixture(
        receiptFixture("complete").images.api,
      );
      const validRaw = JSON.stringify(provenance);
      const duplicateRaw = validRaw.replace(
        '"metadata":{',
        '"metadata":{"note":"DATABASE_URL=postgres://fixture:fixture@example.invalid/db","note":"reviewed",',
      );
      assert.notEqual(duplicateRaw, validRaw);
      const fixture = await context(nested, {
        apiOciProvenanceRaw: duplicateRaw,
      });
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          fixture.request,
          fixture.authority,
        ),
        expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
      );
      assert.equal(fixture.signerCalls(), 0);
    },
  );

  await t.test("build argument drift", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        value.predicate.invocation.parameters.args["build-arg:BUILD_SHA"] =
          "a".repeat(40);
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("runnable subject drift", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        value.subject[0].digest.sha256 = "b".repeat(64);
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("missing runnable subject name", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        delete value.subject[0].name;
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("foreign runnable subject name", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        value.subject[0].name = `pkg:docker/ghcr.io/modvolt/site-logbook-web@${SOURCE_SHA}?platform=linux%2Famd64`;
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("ambiguous subjects", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        value.subject.push(structuredClone(value.subject[0]));
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  const semanticDrifts = [
    [
      "build type",
      (value) =>
        (value.predicate.buildType = "https://example.invalid/builder"),
    ],
    [
      "target",
      (value) =>
        (value.predicate.invocation.parameters.args.target = "development"),
    ],
    [
      "Dockerfile directory",
      (value) =>
        (value.predicate.invocation.parameters.root.request.args[
          "vcs:localdir:dockerfile"
        ] = "artifacts/stavba"),
    ],
    [
      "VCS source",
      (value) =>
        (value.predicate.invocation.parameters.root.request.args["vcs:source"] =
          "https://github.com/example/foreign"),
    ],
    [
      "VCS revision",
      (value) =>
        (value.predicate.invocation.parameters.root.request.args[
          "vcs:revision"
        ] = "c".repeat(40)),
    ],
  ];
  for (const [label, mutateApiOciProvenance] of semanticDrifts) {
    await t.test(`${label} drift`, async (nested) => {
      const fixture = await context(nested, { mutateApiOciProvenance });
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          fixture.request,
          fixture.authority,
        ),
        expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_INVALID"),
      );
      assert.equal(fixture.signerCalls(), 0);
    });
  }

  await t.test("forbidden secret key", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        value.predicate.metadata.token = "redacted-fixture";
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_SECRET_MATERIAL"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("secret-shaped neutral value", async (nested) => {
    const fixture = await context(nested, {
      mutateApiOciProvenance: (value) => {
        value.predicate.metadata.note =
          "DATABASE_URL=postgres://fixture-user:fixture-pass@example.invalid/db";
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OCI_SECRET_MATERIAL"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });
});

test("rejects an untrusted key, a wrong pin and an invalid detached signature", async (t) => {
  await t.test("untrusted key id", async (nested) => {
    const fixture = await context(nested);
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        { ...fixture.request, publisherKeyId: "ed25519:other-publisher" },
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_KEY_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("wrong public-key pin", async (nested) => {
    const fixture = await context(nested);
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        {
          ...fixture.authority,
          expectedPublisherPublicKeySha256: digest("wrong-key"),
        },
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_BINDING_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("wrong signature", async (nested) => {
    let calls = 0;
    const fixture = await context(nested, {
      signWithCustody: async ({ output }) => {
        calls += 1;
        await writeFile(output, Buffer.alloc(64, 7), {
          flag: "wx",
          mode: 0o600,
        });
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID"),
    );
    assert.equal(calls, 1);
    await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
    assert.deepEqual((await readdir(fixture.root)).sort(), [
      "api-provenance.intoto.json",
      "complete-publication-receipt.json",
      "vault",
    ]);
  });

  await t.test("short signature", async (nested) => {
    let calls = 0;
    const fixture = await context(nested, {
      signWithCustody: async ({ output }) => {
        calls += 1;
        await writeFile(output, Buffer.alloc(63, 5), {
          flag: "wx",
          mode: 0o600,
        });
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID"),
    );
    assert.equal(calls, 1);
    await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
  });

  await t.test("empty signature", async (nested) => {
    let calls = 0;
    const fixture = await context(nested, {
      signWithCustody: async ({ output }) => {
        calls += 1;
        await writeFile(output, Buffer.alloc(0), {
          flag: "wx",
          mode: 0o600,
        });
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_SIGNATURE_INVALID"),
    );
    assert.equal(calls, 1);
    await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
  });

  await t.test(
    "oversized signer output leaves no staging residue",
    async (nested) => {
      const fixture = await context(nested, {
        signWithCustody: async ({ output }) => {
          await writeFile(output, Buffer.alloc(65, 4), {
            flag: "wx",
            mode: 0o600,
          });
        },
      });
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          fixture.request,
          fixture.authority,
        ),
        expectProducerCode("PRODUCTION_API_PROVENANCE_INPUT_INVALID"),
      );
      await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
      assert.deepEqual((await readdir(fixture.root)).sort(), [
        "api-provenance.intoto.json",
        "complete-publication-receipt.json",
        "vault",
      ]);
    },
  );

  await t.test(
    "multiply-linked signer output removes only the owned staging link",
    async (nested) => {
      const fixture = await context(nested);
      const peer = join(fixture.root, "peer-signature.raw");
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          fixture.request,
          {
            ...fixture.authority,
            signWithCustody: async ({ output }) => {
              await writeFile(output, Buffer.alloc(64, 6), {
                flag: "wx",
                mode: 0o600,
              });
              await link(output, peer);
            },
          },
        ),
        expectProducerCode("PRODUCTION_API_PROVENANCE_INPUT_INVALID"),
      );
      assert.deepEqual(await readFile(peer), Buffer.alloc(64, 6));
      await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
      assert.deepEqual((await readdir(fixture.root)).sort(), [
        "api-provenance.intoto.json",
        "complete-publication-receipt.json",
        "peer-signature.raw",
        "vault",
      ]);
    },
  );

  await t.test("custody exception", async (nested) => {
    let calls = 0;
    const fixture = await context(nested, {
      signWithCustody: async () => {
        calls += 1;
        throw new ProductionApiImageProvenanceError(
          "PRODUCTION_API_PROVENANCE_CUSTODY_FAILED",
          "fixture failure without output",
        );
      },
    });
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_CUSTODY_FAILED"),
    );
    assert.equal(calls, 1);
    await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
  });
});

test("never clobbers a pre-existing output directory or file", async (t) => {
  await t.test("directory", async (nested) => {
    const fixture = await context(nested);
    await mkdir(fixture.outputDirectory);
    const sentinel = join(fixture.outputDirectory, "sentinel.txt");
    await writeFile(sentinel, "preserve-me");
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OUTPUT_EXISTS"),
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve-me");
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("file", async (nested) => {
    const fixture = await context(nested);
    await writeFile(fixture.outputDirectory, "preserve-file");
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_OUTPUT_EXISTS"),
    );
    assert.equal(
      await readFile(fixture.outputDirectory, "utf8"),
      "preserve-file",
    );
    assert.equal(fixture.signerCalls(), 0);
  });
});

test("detects ancestor aliases, directory races and peer replacements without blind cleanup", async (t) => {
  await t.test(
    "output-parent junction into the custody vault",
    async (nested) => {
      const fixture = await context(nested);
      const alias = join(fixture.root, "vault-output-alias");
      try {
        await symlink(
          fixture.vault,
          alias,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        if (process.platform === "win32" && error?.code === "EPERM") {
          nested.diagnostic(
            "Windows junction creation is unavailable; the ancestry walk remains covered by file-link tests.",
          );
          return;
        }
        throw error;
      }
      await assert.rejects(
        runProductionApiImageProvenanceProducerWithTestAuthority(
          {
            ...fixture.request,
            outputDirectory: join(alias, "evidence-output"),
          },
          fixture.authority,
        ),
        expectProducerCode("PRODUCTION_API_PROVENANCE_PATH_INVALID"),
      );
      assert.equal(fixture.signerCalls(), 0);
    },
  );

  await t.test("output parent identity replacement", async (nested) => {
    const fixture = await context(nested, { separateOutputParent: true });
    const movedParent = join(fixture.root, "moved-output-parent");
    const sentinel = join(fixture.outputParent, "peer-sentinel.txt");
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        {
          ...fixture.authority,
          testHooks: {
            beforeFinalDirectoryCreate: async () => {
              await rename(fixture.outputParent, movedParent);
              await mkdir(fixture.outputParent, { mode: 0o700 });
              await writeFile(sentinel, "preserve-peer-parent");
            },
          },
        },
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_PATH_INVALID"),
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve-peer-parent");
    assert.equal(fixture.signerCalls(), 1);
  });

  await t.test("sequential stage write failure", async (nested) => {
    const fixture = await context(nested);
    let writes = 0;
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        {
          ...fixture.authority,
          testHooks: {
            beforeStageOutputWrite: async () => {
              writes += 1;
              if (writes === 2) throw new Error("injected stage write failure");
            },
          },
        },
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED"),
    );
    assert.equal(writes, 2);
    await assert.rejects(lstat(fixture.outputDirectory), { code: "ENOENT" });
    assert.deepEqual((await readdir(fixture.root)).sort(), [
      "api-provenance.intoto.json",
      "complete-publication-receipt.json",
      "vault",
    ]);
  });

  await t.test("final pathname replacement", async (nested) => {
    const fixture = await context(nested);
    const preservedOriginal = join(fixture.root, "preserved-original.json");
    const replacement = "peer-owned-replacement";
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        {
          ...fixture.authority,
          testHooks: {
            beforeFinalValidation: async ({ outputDirectory, files }) => {
              const target = join(outputDirectory, files.provenance);
              await rename(target, preservedOriginal);
              await writeFile(target, replacement, {
                flag: "wx",
                mode: 0o600,
              });
            },
          },
        },
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_PERSISTENCE_FAILED"),
    );
    assert.equal(
      await readFile(
        join(
          fixture.outputDirectory,
          PRODUCTION_API_IMAGE_PROVENANCE_FILES.provenance,
        ),
        "utf8",
      ),
      replacement,
    );
    assert.equal((await lstat(preservedOriginal)).isFile(), true);
  });
});

test("rejects symlinked and multiply-linked inputs before custody signing", async (t) => {
  await t.test("publication receipt symlink", async (nested) => {
    const fixture = await context(nested);
    const symlinkPath = join(fixture.root, "publication-link.json");
    try {
      await symlink(fixture.publicationReceipt, symlinkPath, "file");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        nested.diagnostic(
          "Windows symlink privilege is unavailable; code path remains covered by lstat validation.",
        );
        return;
      }
      throw error;
    }
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        { ...fixture.request, publicationReceipt: symlinkPath },
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_PATH_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("API OCI provenance symlink", async (nested) => {
    const fixture = await context(nested);
    const symlinkPath = join(fixture.root, "api-provenance-link.json");
    try {
      await symlink(fixture.apiOciProvenance, symlinkPath, "file");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        nested.diagnostic(
          "Windows symlink privilege is unavailable; code path remains covered by lstat validation.",
        );
        return;
      }
      throw error;
    }
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        { ...fixture.request, apiOciProvenance: symlinkPath },
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_PATH_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("API OCI provenance hard link", async (nested) => {
    const fixture = await context(nested);
    await link(
      fixture.apiOciProvenance,
      join(fixture.root, "api-provenance-second-link.json"),
    );
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_INPUT_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });

  await t.test("publication receipt hard link", async (nested) => {
    const fixture = await context(nested);
    await link(
      fixture.publicationReceipt,
      join(fixture.root, "publication-second-link.json"),
    );
    await assert.rejects(
      runProductionApiImageProvenanceProducerWithTestAuthority(
        fixture.request,
        fixture.authority,
      ),
      expectProducerCode("PRODUCTION_API_PROVENANCE_INPUT_INVALID"),
    );
    assert.equal(fixture.signerCalls(), 0);
  });
});
