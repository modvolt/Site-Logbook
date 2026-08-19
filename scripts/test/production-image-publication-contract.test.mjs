import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  PRODUCTION_IMAGE_PUBLICATION_CALLER,
  PRODUCTION_IMAGE_PUBLICATION_KIND,
  PRODUCTION_IMAGE_PUBLICATION_SCHEMA,
  PRODUCTION_IMAGE_PUBLICATION_WORKFLOW,
  PRODUCTION_IMAGE_SECRET_SCAN_SCOPE,
  PRODUCTION_IMAGE_SPECS,
  ProductionImagePublicationError,
  canonicalJson,
  classifyExactLookupStatus,
  parseStrictSecretFreeJson,
  parseProductionImagePublicationReceipt,
  publishReviewedOciLayout,
  publishReviewedOciSet,
  recheckExactProductionSource,
  reviewedImageSetSha256,
  sealProductionImagePublicationReceipt,
  sha256,
  verifyReviewedOciLayout,
} from "../production-evidence/production-image-publication-contract.mjs";

const SOURCE_SHA = "d563af036b25c9afd97a43a3a3af79e095008d48";
const TREE_SHA = "1".repeat(40);
const WORKFLOW_SHA = "2".repeat(40);
const PREFLIGHT_RECEIPT_SHA = `sha256:${"3".repeat(64)}`;

function digest(character) {
  return sha256(`fixture:${character}`);
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

function receiptFixture(stage = "preflight-only") {
  const currentRunId =
    stage === "preflight-only" ? "31540000001" : "31540000002";
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
      runAttempt: "1",
    },
    publisher: {
      repository: "modvolt/Site-Logbook",
      workflowPath: PRODUCTION_IMAGE_PUBLICATION_WORKFLOW,
      jobWorkflowRef: `modvolt/Site-Logbook/${PRODUCTION_IMAGE_PUBLICATION_WORKFLOW}@${SOURCE_SHA}`,
      sourceSha: SOURCE_SHA,
      workflowFileSha256: digest("6"),
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

function changed(stage, mutate) {
  const receipt = structuredClone(receiptFixture(stage));
  mutate(receipt);
  return receipt;
}

function replaceFilesystemLayers(image, layers) {
  const filesystemProjection = {
    format: image.filesystemManifest.format,
    configDigest: image.configDigest,
    layers: structuredClone(layers),
    entryCount: layers.length,
  };
  image.filesystemManifest = {
    ...filesystemProjection,
    sha256: sha256(canonicalJson(filesystemProjection)),
  };
}

function expectCode(value, code) {
  assert.throws(
    () => sealProductionImagePublicationReceipt(value),
    (error) =>
      error instanceof ProductionImagePublicationError && error.code === code,
  );
}

function ociLayoutFixture(options = {}) {
  const imageKey = options.imageKey ?? "api";
  const spec = PRODUCTION_IMAGE_SPECS[imageKey];
  const rawTarget = options.rawTarget ?? spec.target;
  const rawBuildArgValue = options.rawBuildArgValue ?? SOURCE_SHA;
  const rawDockerfileDirectory =
    options.rawDockerfileDirectory ??
    dirname(spec.dockerfile).replaceAll("\\", "/");
  const fixtureRoot = mkdtempSync(
    join(tmpdir(), "site-logbook-production-oci-"),
  );
  const root = join(fixtureRoot, "layout");
  mkdirSync(root);
  const blobRoot = join(root, "blobs", "sha256");
  mkdirSync(blobRoot, { recursive: true });
  const writeBlob = (value) => {
    const bytes = Buffer.isBuffer(value)
      ? value
      : Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    const blobDigest = sha256(bytes);
    writeFileSync(join(blobRoot, blobDigest.slice(7)), bytes);
    return { digest: blobDigest, size: bytes.length };
  };

  const configValue = {
    architecture: "amd64",
    os: "linux",
    config: {
      Labels: {
        "org.opencontainers.image.source":
          "https://github.com/modvolt/Site-Logbook",
        "org.opencontainers.image.revision": SOURCE_SHA,
        "org.opencontainers.image.url": `https://github.com/modvolt/Site-Logbook/commit/${SOURCE_SHA}`,
      },
      Env: [`${spec.buildArg}=${SOURCE_SHA}`],
    },
  };
  if (options.configSecret) {
    configValue.config.Labels["deployment-token"] = "fixture-redacted";
  }
  if (options.configNeutralValue) {
    configValue.config.Labels["review-note"] = options.configNeutralValue;
  }
  const config = writeBlob(configValue);
  const layer = writeBlob(
    Buffer.from(options.layerPayload ?? "reviewed-root-filesystem", "utf8"),
  );
  const overlayLayer = options.duplicateFilesystemLayer
    ? writeBlob(Buffer.from("reviewed-root-filesystem-overlay", "utf8"))
    : null;
  const provisionalRunnableDigest = digest("provisional-runnable");
  const provenanceValue = {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [
      {
        name:
          options.rawSubjectName ??
          `pkg:docker/${spec.repository}@${SOURCE_SHA}?platform=linux%2Famd64`,
        digest: { sha256: provisionalRunnableDigest.slice(7) },
      },
    ],
    predicateType: "https://slsa.dev/provenance/v0.2",
    predicate: {
      buildType: "https://mobyproject.org/buildkit@v1",
      invocation: {
        configSource: { entryPoint: "Dockerfile" },
        parameters: {
          args: {
            [`build-arg:${spec.buildArg}`]: rawBuildArgValue,
            target: rawTarget,
          },
          root: {
            request: {
              args: {
                "vcs:localdir:dockerfile": rawDockerfileDirectory,
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
  if (options.omitProvenanceSubjectName) {
    delete provenanceValue.subject[0].name;
  }
  if (options.extraProvenanceSubject) {
    provenanceValue.subject.push(structuredClone(provenanceValue.subject[0]));
  }
  if (options.omitProvenanceSubject) {
    delete provenanceValue.subject;
  }
  if (options.provenanceNeutralValue) {
    provenanceValue.predicate.metadata["review-note"] =
      options.provenanceNeutralValue;
  }
  if (options.provenanceSecretKey) {
    provenanceValue.predicate.metadata[options.provenanceSecretKey] = "safe";
  }
  const sbomValue = {
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType: "https://spdx.dev/Document",
    predicate: {
      spdxVersion: "SPDX-2.3",
      packages: [{ SPDXID: "SPDXRef-Package", name: "fixture" }],
      relationships: [
        {
          spdxElementId: "SPDXRef-DOCUMENT",
          relationshipType: "DESCRIBES",
          relatedSpdxElement: "SPDXRef-Package",
        },
      ],
    },
  };
  let provenance = writeBlob(provenanceValue);
  const sbom = writeBlob(sbomValue);
  const extraAttestationLayer = options.extraAttestationLayer
    ? writeBlob({
        _type: "https://in-toto.io/Statement/v0.1",
        predicateType: "https://example.invalid/unreviewed",
        predicate: { reviewed: false },
      })
    : null;
  const attestationConfig = writeBlob({
    architecture: "unknown",
    os: "unknown",
  });

  const layerDescriptor = {
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
    ...layer,
  };
  const runnableLayers = options.duplicateFilesystemLayer
    ? [
        layerDescriptor,
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          ...overlayLayer,
        },
        layerDescriptor,
      ]
    : [layerDescriptor];
  const runnableValue = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      ...config,
    },
    layers: runnableLayers,
  };
  const runnable = writeBlob(runnableValue);
  for (const subject of provenanceValue.subject ?? []) {
    subject.digest.sha256 =
      options.rawSubjectDigest ?? runnable.digest.slice(7);
  }
  rmSync(join(blobRoot, provenance.digest.slice(7)));
  provenance = writeBlob(
    options.provenanceRawTransform
      ? Buffer.from(
          options.provenanceRawTransform(
            `${JSON.stringify(provenanceValue)}\n`,
          ),
          "utf8",
        )
      : provenanceValue,
  );
  const attestationValue = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      ...attestationConfig,
    },
    layers: [
      {
        mediaType: "application/vnd.in-toto+json",
        annotations: {
          "in-toto.io/predicate-type": "https://slsa.dev/provenance/v0.2",
        },
        ...provenance,
      },
      {
        mediaType: "application/vnd.in-toto+json",
        annotations: {
          "in-toto.io/predicate-type": "https://spdx.dev/Document",
        },
        ...sbom,
      },
      ...(extraAttestationLayer
        ? [
            {
              mediaType: "application/vnd.in-toto+json",
              annotations: {
                "in-toto.io/predicate-type":
                  "https://example.invalid/unreviewed",
              },
              ...extraAttestationLayer,
            },
          ]
        : []),
    ],
  };
  const attestation = writeBlob(attestationValue);
  const runnableDescriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: options.runnablePlatform ?? {
      os: "linux",
      architecture: "amd64",
    },
    ...runnable,
  };
  const attestationDescriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    platform: options.attestationPlatform ?? {
      os: "unknown",
      architecture: "unknown",
    },
    annotations: {
      "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest":
        options.attestationReferenceDigest ?? runnable.digest,
    },
    ...attestation,
  };
  const indexValue = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      runnableDescriptor,
      attestationDescriptor,
      ...(options.extraRunnableDescriptor ? [runnableDescriptor] : []),
      ...(options.extraAttestationDescriptor ? [attestationDescriptor] : []),
    ],
  };
  const index = writeBlob(indexValue);
  const indexDigest = index.digest;
  const layoutRootDescriptor = {
    mediaType:
      options.layoutRootMediaType ?? "application/vnd.oci.image.index.v1+json",
    digest: options.layoutRootDigest ?? index.digest,
    size: index.size + (options.layoutRootSizeDelta ?? 0),
    annotations: {
      "io.containerd.image.name":
        options.layoutRootImageName ?? `${spec.repository}:${SOURCE_SHA}`,
      "org.opencontainers.image.ref.name":
        options.layoutRootRefName ?? SOURCE_SHA,
    },
  };
  const layoutIndexValue = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      ...(options.omitLayoutRoot ? [] : [layoutRootDescriptor]),
      ...(options.extraLayoutRoot ? [layoutRootDescriptor] : []),
    ],
    ...(options.layoutSecretValue
      ? { annotations: { reviewNote: options.layoutSecretValue } }
      : {}),
  };
  let layoutIndexText = JSON.stringify(
    options.legacyFlatLayout ? indexValue : layoutIndexValue,
  );
  if (options.duplicateLayoutKey) {
    layoutIndexText = layoutIndexText.replace(
      '"schemaVersion":2',
      '"schemaVersion":2,"schema\\u0056ersion":2',
    );
  }
  writeFileSync(
    join(root, "index.json"),
    Buffer.from(`${layoutIndexText}\n`, "utf8"),
  );
  if (options.missingRootIndexBlob) {
    rmSync(join(blobRoot, index.digest.slice(7)));
  } else if (options.corruptRootIndexBlob) {
    writeFileSync(
      join(blobRoot, index.digest.slice(7)),
      Buffer.from("corrupt-root-index", "utf8"),
    );
  }
  writeFileSync(join(root, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}\n');
  const archivePath = join(fixtureRoot, "reviewed.oci.tar");
  const archiveBytes = Buffer.from("exact-reviewed-archive", "utf8");
  writeFileSync(archivePath, archiveBytes);

  const imageIndex = { api: 0, controlPlane: 1, hostOperator: 2, web: 3 }[
    imageKey
  ];
  const image = imageFixture(imageKey, "preflight-only", imageIndex);
  image.digest = indexDigest;
  image.image = `${image.repository}@${indexDigest}`;
  image.runnableManifestDigest = runnable.digest;
  image.configDigest = config.digest;
  image.provenance.sha256 = provenance.digest;
  image.sbom.sha256 = sbom.digest;
  image.sbom.packageCount = 1;
  image.sbom.relationshipCount = 1;
  replaceFilesystemLayers(
    image,
    runnableLayers.map(({ digest, mediaType, size }) => ({
      digest,
      mediaType,
      size,
    })),
  );
  image.ociArchive = {
    sha256: sha256(archiveBytes),
    sizeBytes: archiveBytes.length,
    indexDigest,
  };
  return { fixtureRoot, root, archivePath, image };
}

async function requestBytes(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array)
    return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function registryFixture(
  layout,
  {
    digestStatus = 404,
    corruptExistingRoot = false,
    redirectBlobs = false,
  } = {},
) {
  const calls = [];
  const remoteBlobs = new Map();
  const remoteManifests = new Map();
  const blobRoot = join(layout.root, "blobs", "sha256");
  const indexBytes = readFileSync(
    join(blobRoot, layout.image.digest.slice("sha256:".length)),
  );
  const index = JSON.parse(indexBytes);
  if (digestStatus === 200) {
    for (const name of Object.values(index.manifests).map((entry) =>
      entry.digest.slice(7),
    )) {
      const bytes = readFileSync(join(blobRoot, name));
      remoteManifests.set(`sha256:${name}`, bytes);
    }
  }

  const populateBlobs = () => {
    const names = new Set();
    const visit = (value) => {
      if (typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value)) {
        names.add(value.slice(7));
      } else if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(visit);
      }
    };
    visit(index);
    for (const name of [...names]) {
      const path = join(blobRoot, name);
      let bytes;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      remoteBlobs.set(`sha256:${name}`, bytes);
      try {
        visit(JSON.parse(bytes));
      } catch {
        // Filesystem layers are intentionally opaque.
      }
    }
    let previous = -1;
    while (previous !== names.size) {
      previous = names.size;
      for (const name of [...names]) {
        const path = join(blobRoot, name);
        let bytes;
        try {
          bytes = readFileSync(path);
        } catch {
          continue;
        }
        remoteBlobs.set(`sha256:${name}`, bytes);
        try {
          visit(JSON.parse(bytes));
        } catch {
          // Filesystem layers are intentionally opaque.
        }
      }
    }
  };
  if (digestStatus === 200) {
    remoteBlobs.set(layout.image.digest, indexBytes);
    populateBlobs();
  }
  remoteManifests.set(
    layout.image.digest,
    corruptExistingRoot
      ? Buffer.from("not-the-reviewed-index", "utf8")
      : indexBytes,
  );
  if (digestStatus !== 200) remoteManifests.delete(layout.image.digest);

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      authorizationPresent: Boolean(options.headers?.Authorization),
    });
    if (url.href.startsWith("https://ghcr.io/token?")) {
      return new Response(
        JSON.stringify({ token: "fixture-bearer-token-1234567890" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.hostname === "objects.example.test") {
      assert.equal(options.headers?.Authorization, undefined);
      const blobDigest = decodeURIComponent(
        url.pathname.slice("/blob/".length),
      );
      const bytes = remoteBlobs.get(blobDigest);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes, { status: 200 });
    }
    const repositoryPath = layout.image.repository.slice("ghcr.io/".length);
    const prefix = `/v2/${repositoryPath}/`;
    assert.ok(
      url.pathname.startsWith(prefix),
      `unexpected registry path ${url.pathname}`,
    );
    const suffix = url.pathname.slice(prefix.length);
    if (suffix.startsWith("manifests/")) {
      const reference = decodeURIComponent(suffix.slice("manifests/".length));
      if (method === "GET") {
        if (
          reference === layout.image.digest &&
          digestStatus !== 200 &&
          !remoteManifests.has(reference)
        ) {
          if (digestStatus === "network") {
            throw new Error("fixture network failure");
          }
          if (digestStatus === 404) return new Response(null, { status: 404 });
          return new Response(null, { status: digestStatus });
        }
        const bytes = remoteManifests.get(reference);
        if (!bytes) return new Response(null, { status: 404 });
        return new Response(bytes, {
          status: 200,
          headers: { "docker-content-digest": reference },
        });
      }
      assert.equal(method, "PUT");
      assert.match(reference, /^sha256:[0-9a-f]{64}$/u);
      const bytes = await requestBytes(options.body);
      if (sha256(bytes) !== reference)
        return new Response(null, { status: 400 });
      remoteManifests.set(reference, bytes);
      return new Response(null, {
        status: 201,
        headers: { "docker-content-digest": reference },
      });
    }
    if (suffix === "blobs/uploads/") {
      assert.equal(method, "POST");
      return new Response(null, {
        status: 202,
        headers: {
          location: `https://ghcr.io${prefix}blobs/uploads/${calls.length}`,
        },
      });
    }
    if (suffix.startsWith("blobs/uploads/")) {
      assert.equal(method, "PUT");
      const blobDigest = url.searchParams.get("digest");
      assert.match(blobDigest, /^sha256:[0-9a-f]{64}$/u);
      const bytes = await requestBytes(options.body);
      assert.equal(sha256(bytes), blobDigest);
      remoteBlobs.set(blobDigest, bytes);
      return new Response(null, { status: 201 });
    }
    if (suffix.startsWith("blobs/")) {
      const blobDigest = decodeURIComponent(suffix.slice("blobs/".length));
      const bytes = remoteBlobs.get(blobDigest);
      if (method === "HEAD") {
        return new Response(null, {
          status: bytes ? 200 : 404,
          ...(bytes
            ? { headers: { "docker-content-digest": blobDigest } }
            : {}),
        });
      }
      assert.equal(method, "GET");
      if (!bytes) return new Response(null, { status: 404 });
      if (redirectBlobs) {
        return new Response(null, {
          status: 307,
          headers: {
            location: `https://objects.example.test/blob/${encodeURIComponent(blobDigest)}`,
          },
        });
      }
      return new Response(bytes, {
        status: 200,
        headers: { "docker-content-digest": blobDigest },
      });
    }
    throw new Error(`unhandled registry request ${method} ${url.href}`);
  };
  return { calls, fetchImpl, indexBytes };
}

test("seals canonical preflight-only and complete receipts", () => {
  for (const stage of ["preflight-only", "complete"]) {
    const sealed = sealProductionImagePublicationReceipt(receiptFixture(stage));
    assert.match(sealed.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(sealed.canonical, canonicalJson(sealed.receipt));
    const parsed = parseProductionImagePublicationReceipt(sealed.canonical, {
      expectedStage: stage,
      expectedSourceSha: SOURCE_SHA,
      expectedRunId: sealed.receipt.caller.runId,
      expectedRunAttempt: "1",
      expectedReceiptSha256: sealed.sha256,
    });
    assert.equal(parsed.sha256, sealed.sha256);
  }
});

test("requires exact merged main and a successful exact-SHA push Quality gate", () => {
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.source.mergeParentShas = ["4".repeat(40)];
    }),
    "PRODUCTION_IMAGE_SOURCE_NOT_MERGED_MAIN",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.source.qualityGate.event = "pull_request";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.source.qualityGate.headSha = "7".repeat(40);
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.source.qualityGate.conclusion = "neutral";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
});

test("keeps the two-stage publisher default-dark and non-operational", () => {
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.policy.registryWritePermitted = true;
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.preflightReceiptSha256 = null;
    }),
    "PRODUCTION_IMAGE_SCHEMA_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.preflightRunId = receipt.caller.runId;
    }),
    "PRODUCTION_IMAGE_STAGE_CHAIN_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.policy.deploymentAuthorized = true;
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.policy.migrationAuthorized = true;
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
});

test("pins production package names, Docker targets and mutating profile boundaries", () => {
  assert.deepEqual(Object.keys(PRODUCTION_IMAGE_SPECS), [
    "api",
    "controlPlane",
    "hostOperator",
    "web",
  ]);
  assert.deepEqual(PRODUCTION_IMAGE_SPECS.hostOperator, {
    component: "host-operator",
    repository: "ghcr.io/modvolt/site-logbook-host-operator",
    dockerfile: "artifacts/api-server/Dockerfile",
    target: "host-operator",
    buildArg: "BUILD_SHA",
    imageProfile: "host-operator",
    mutatingEntrypointsPresent: true,
  });
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.api.repository =
        "ghcr.io/modvolt/site-logbook-staging-api";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.api.build.target = "control-plane";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.controlPlane.build.mutatingEntrypointsPresent = false;
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.hostOperator.repository =
        "ghcr.io/modvolt/site-logbook-control-plane";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.hostOperator.build.target = "control-plane";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.hostOperator.build.mutatingEntrypointsPresent = false;
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.web.build.buildArg = "BUILD_SHA";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
});

test("rejects provenance, SBOM, manifest and filesystem binding drift", () => {
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.api.provenance.vcsRevision = "7".repeat(40);
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.web.sbom.packageCount = 0;
    }),
    "PRODUCTION_IMAGE_SBOM_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.controlPlane.filesystemManifest.layers[0].size += 1;
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.images.api.configDigest = `sha256:${"z".repeat(64)}`;
    }),
    "PRODUCTION_IMAGE_DIGEST_INVALID",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.images.api.ociArchive.indexDigest = digest("wrong-index");
      receipt.chain.reviewedImageSetSha256 = reviewedImageSetSha256(
        receipt.images,
      );
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.reviewedImageSetSha256 = digest("wrong-reviewed-set");
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
});

test("preserves ordered duplicate filesystem layer descriptors", async () => {
  const receipt = receiptFixture("preflight-only");
  const controlPlane = receipt.images.controlPlane;
  const [baseLayer, overlayLayer] = controlPlane.filesystemManifest.layers;
  const orderedLayers = [baseLayer, overlayLayer, baseLayer];
  replaceFilesystemLayers(controlPlane, orderedLayers);
  receipt.chain.reviewedImageSetSha256 = reviewedImageSetSha256(receipt.images);

  const sealed = sealProductionImagePublicationReceipt(receipt);
  assert.deepEqual(
    sealed.receipt.images.controlPlane.filesystemManifest.layers,
    orderedLayers,
  );
  assert.equal(
    sealed.receipt.images.controlPlane.filesystemManifest.entryCount,
    3,
  );

  const layout = ociLayoutFixture({
    imageKey: "controlPlane",
    duplicateFilesystemLayer: true,
  });
  try {
    const graph = await verifyReviewedOciLayout({
      layoutDirectory: layout.root,
      archivePath: layout.archivePath,
      image: layout.image,
      imageKey: "controlPlane",
    });
    const [firstLayer, secondLayer, repeatedLayer] =
      layout.image.filesystemManifest.layers;
    assert.equal(firstLayer.digest, repeatedLayer.digest);
    assert.notEqual(firstLayer.digest, secondLayer.digest);
    assert.equal(
      graph.blobFiles.filter(
        ({ digest: blobDigest }) => blobDigest === firstLayer.digest,
      ).length,
      1,
    );

    for (const driftedLayers of [
      [firstLayer, secondLayer],
      [firstLayer, repeatedLayer, secondLayer],
    ]) {
      const driftedImage = structuredClone(layout.image);
      replaceFilesystemLayers(driftedImage, driftedLayers);
      await assert.rejects(
        () =>
          verifyReviewedOciLayout({
            layoutDirectory: layout.root,
            archivePath: layout.archivePath,
            image: driftedImage,
            imageKey: "controlPlane",
          }),
        (error) =>
          error instanceof ProductionImagePublicationError &&
          error.code === "PRODUCTION_IMAGE_BINDING_INVALID",
      );
    }
  } finally {
    rmSync(layout.fixtureRoot, { recursive: true, force: true });
  }
});

test("binds immutable caller ids, nonce single-use key and fresh artifact chronology", () => {
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.caller.actorId = "1";
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.caller.repositoryId = "0";
    }),
    "PRODUCTION_IMAGE_RUN_IDENTITY_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.publicationNonceSha256 = digest("other-nonce");
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.singleUseKeySha256 = digest("other-single-use-key");
    }),
    "PRODUCTION_IMAGE_BINDING_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.preflightArtifactDigest = "not-a-digest";
    }),
    "PRODUCTION_IMAGE_DIGEST_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.preflightArtifactCreatedAt = "2026-08-18T13:00:00.000Z";
    }),
    "PRODUCTION_IMAGE_STAGE_CHAIN_INVALID",
  );
  expectCode(
    changed("complete", (receipt) => {
      receipt.chain.preflightArtifactExpiresAt =
        receipt.chain.preflightArtifactCreatedAt;
    }),
    "PRODUCTION_IMAGE_STAGE_CHAIN_INVALID",
  );
  const sealed = sealProductionImagePublicationReceipt(
    receiptFixture("preflight-only"),
  );
  assert.throws(
    () =>
      parseProductionImagePublicationReceipt(sealed.canonical, {
        now: Date.parse("2026-08-20T12:00:00.001Z"),
        maxAgeMs: 24 * 60 * 60 * 1000,
      }),
    (error) =>
      error instanceof ProductionImagePublicationError &&
      error.code === "PRODUCTION_IMAGE_FRESHNESS_INVALID",
  );
});

test("distinguishes exact absence from authorization, server and network-equivalent statuses", () => {
  assert.equal(classifyExactLookupStatus(200), "present");
  assert.equal(classifyExactLookupStatus(404), "absent");
  for (const status of [0, 401, 403, 408, 429, 500, 503]) {
    assert.throws(
      () => classifyExactLookupStatus(status),
      (error) =>
        error instanceof ProductionImagePublicationError &&
        error.code === "PRODUCTION_IMAGE_LOOKUP_FAILED",
    );
  }
});

test("verifies exact offline OCI graph and raw target/build-arg provenance", async () => {
  const accepted = ociLayoutFixture();
  try {
    const graph = await verifyReviewedOciLayout({
      layoutDirectory: accepted.root,
      archivePath: accepted.archivePath,
      image: accepted.image,
      imageKey: "api",
    });
    assert.equal(
      graph.runnableDescriptor.digest,
      accepted.image.runnableManifestDigest,
    );
    assert.equal(
      graph.indexPath,
      join(
        accepted.root,
        "blobs",
        "sha256",
        accepted.image.digest.slice("sha256:".length),
      ),
    );
    assert.equal(graph.layoutIndexPath, join(accepted.root, "index.json"));
  } finally {
    rmSync(accepted.fixtureRoot, { recursive: true, force: true });
  }

  for (const mutation of [
    { rawTarget: "control-plane" },
    { rawBuildArgValue: "7".repeat(40) },
    { rawDockerfileDirectory: "artifacts/stavba" },
  ]) {
    const drifted = ociLayoutFixture(mutation);
    try {
      await assert.rejects(
        () =>
          verifyReviewedOciLayout({
            layoutDirectory: drifted.root,
            archivePath: drifted.archivePath,
            image: drifted.image,
            imageKey: "api",
          }),
        (error) =>
          error instanceof ProductionImagePublicationError &&
          error.code === "PRODUCTION_IMAGE_BINDING_INVALID",
      );
    } finally {
      rmSync(drifted.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("requires one exact named OCI layout root and its bound inner image index", async () => {
  const layoutInvalid = "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID";
  const bindingInvalid = "PRODUCTION_IMAGE_BINDING_INVALID";
  for (const [options, expectedCode] of [
    [{ duplicateLayoutKey: true }, layoutInvalid],
    [
      { layoutSecretValue: "github_pat_redacted_layout_fixture" },
      "PRODUCTION_IMAGE_SECRET_MATERIAL",
    ],
    [{ omitLayoutRoot: true }, layoutInvalid],
    [{ extraLayoutRoot: true }, layoutInvalid],
    [
      {
        layoutRootMediaType: "application/vnd.oci.image.manifest.v1+json",
      },
      bindingInvalid,
    ],
    [{ layoutRootDigest: digest("foreign-layout-root") }, bindingInvalid],
    [{ layoutRootSizeDelta: 1 }, bindingInvalid],
    [
      {
        layoutRootImageName: `ghcr.io/modvolt/unreviewed:${SOURCE_SHA}`,
      },
      bindingInvalid,
    ],
    [{ layoutRootRefName: `foreign-${SOURCE_SHA}` }, bindingInvalid],
    [{ missingRootIndexBlob: true }, layoutInvalid],
    [{ corruptRootIndexBlob: true }, bindingInvalid],
    [{ legacyFlatLayout: true }, layoutInvalid],
    [{ extraRunnableDescriptor: true }, layoutInvalid],
    [{ extraAttestationDescriptor: true }, layoutInvalid],
    [
      {
        runnablePlatform: { architecture: "amd64", os: "linux", variant: "v3" },
      },
      bindingInvalid,
    ],
    [
      { attestationPlatform: { architecture: "amd64", os: "linux" } },
      bindingInvalid,
    ],
    [
      {
        attestationReferenceDigest: digest("foreign-runnable-reference"),
      },
      bindingInvalid,
    ],
  ]) {
    const layout = ociLayoutFixture(options);
    try {
      await assert.rejects(
        () =>
          verifyReviewedOciLayout({
            layoutDirectory: layout.root,
            archivePath: layout.archivePath,
            image: layout.image,
            imageKey: "api",
          }),
        (error) =>
          error instanceof ProductionImagePublicationError &&
          error.code === expectedCode,
      );
    } finally {
      rmSync(layout.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("requires one exact BuildKit PURL subject for the runnable manifest", async () => {
  for (const scenario of [
    {
      options: {
        rawSubjectName: `pkg:docker/ghcr.io/modvolt/unreviewed@${SOURCE_SHA}?platform=linux%2Famd64`,
      },
      expectedCode: "PRODUCTION_IMAGE_BINDING_INVALID",
    },
    {
      options: { rawSubjectDigest: digest("unreviewed-subject").slice(7) },
      expectedCode: "PRODUCTION_IMAGE_BINDING_INVALID",
    },
    {
      options: { omitProvenanceSubjectName: true },
      expectedCode: "PRODUCTION_IMAGE_SCHEMA_INVALID",
    },
    {
      options: { omitProvenanceSubject: true },
      expectedCode: "PRODUCTION_IMAGE_PROVENANCE_INVALID",
    },
    {
      options: { extraProvenanceSubject: true },
      expectedCode: "PRODUCTION_IMAGE_PROVENANCE_INVALID",
    },
  ]) {
    const layout = ociLayoutFixture(scenario.options);
    try {
      await assert.rejects(
        () =>
          verifyReviewedOciLayout({
            layoutDirectory: layout.root,
            archivePath: layout.archivePath,
            image: layout.image,
            imageKey: "api",
          }),
        (error) =>
          error instanceof ProductionImagePublicationError &&
          error.code === scenario.expectedCode,
      );
    } finally {
      rmSync(layout.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("strict secret-free JSON rejects decoded duplicate keys and secret-shaped property names", () => {
  const hiddenSecret = "github_pat_redacted_duplicate_fixture";
  const duplicate = `{"outer":{"reviewNote":"${hiddenSecret}","review\\u004eote":"safe"}}`;
  assert.throws(
    () => parseStrictSecretFreeJson(duplicate, "rawProvenance"),
    (error) => {
      assert.equal(error.code, "PRODUCTION_IMAGE_JSON_INVALID");
      assert.doesNotMatch(error.message, new RegExp(hiddenSecret, "u"));
      return true;
    },
  );

  const secretKey = "ghp_0123456789abcdefghijklmnop";
  assert.throws(
    () =>
      parseStrictSecretFreeJson(
        JSON.stringify({ metadata: { [secretKey]: "safe" } }),
        "rawProvenance",
      ),
    (error) => {
      assert.equal(error.code, "PRODUCTION_IMAGE_SECRET_MATERIAL");
      assert.doesNotMatch(error.message, new RegExp(secretKey, "u"));
      return true;
    },
  );

  assert.deepEqual(
    parseStrictSecretFreeJson('{"metadata":{"reviewNote":"safe"}}'),
    { metadata: { reviewNote: "safe" } },
  );
});

test("rejects unreferenced OCI blobs instead of publishing hidden bytes", async () => {
  const layout = ociLayoutFixture();
  try {
    const hidden = Buffer.from("unreviewed-hidden-blob", "utf8");
    writeFileSync(
      join(layout.root, "blobs", "sha256", sha256(hidden).slice(7)),
      hidden,
    );
    await assert.rejects(
      () =>
        verifyReviewedOciLayout({
          layoutDirectory: layout.root,
          archivePath: layout.archivePath,
          image: layout.image,
          imageKey: "api",
        }),
      (error) =>
        error instanceof ProductionImagePublicationError &&
        error.code === "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
    );
  } finally {
    rmSync(layout.fixtureRoot, { recursive: true, force: true });
  }
});

test("requires one provenance and one SPDX layer and rejects secret-shaped reachable JSON metadata", async () => {
  for (const scenario of [
    {
      options: { extraAttestationLayer: true },
      expectedCode: "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
    },
    {
      options: { configSecret: true },
      expectedCode: "PRODUCTION_IMAGE_SECRET_MATERIAL",
    },
    ...[
      "PGPASSWORD=correct-horse-battery-staple",
      "AWS_SECRET_ACCESS_KEY=fixture-secret-access-key",
      "SCRAM-SHA-256$4096:c2FsdA==$c3RvcmVkS2V5:c2VydmVyS2V5",
      "Bearer eyJhbGciOiJIUzI1NiJ9.fixture.signature",
      "github_pat_11AAABBBCCCDDDEEEFFF_0123456789",
      "ghp_0123456789abcdefghijklmnop",
    ].map((configNeutralValue) => ({
      options: { configNeutralValue },
      expectedCode: "PRODUCTION_IMAGE_SECRET_MATERIAL",
    })),
    {
      options: {
        provenanceNeutralValue: "POSTGRES_PASSWORD=fixture-password",
      },
      expectedCode: "PRODUCTION_IMAGE_SECRET_MATERIAL",
    },
    {
      options: {
        provenanceRawTransform: (raw) =>
          raw.replace(
            '"buildType":',
            '"reviewNote":"github_pat_redacted_duplicate_fixture","review\\u004eote":"safe","buildType":',
          ),
      },
      expectedCode: "PRODUCTION_IMAGE_OCI_LAYOUT_INVALID",
    },
    {
      options: {
        provenanceSecretKey: "ghp_0123456789abcdefghijklmnop",
      },
      expectedCode: "PRODUCTION_IMAGE_SECRET_MATERIAL",
    },
  ]) {
    const layout = ociLayoutFixture(scenario.options);
    try {
      await assert.rejects(
        () =>
          verifyReviewedOciLayout({
            layoutDirectory: layout.root,
            archivePath: layout.archivePath,
            image: layout.image,
            imageKey: "api",
          }),
        (error) =>
          error instanceof ProductionImagePublicationError &&
          error.code === scenario.expectedCode,
      );
    } finally {
      rmSync(layout.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("documents that filesystem payloads are digest-bound but outside the JSON metadata secret scan", async () => {
  assert.deepEqual(PRODUCTION_IMAGE_SECRET_SCAN_SCOPE, {
    metadata: "all-reachable-oci-json-and-buildkit-provenance",
    filesystemPayloads: "digest-bound-not-content-scanned",
  });
  const layout = ociLayoutFixture({
    layerPayload: "PGPASSWORD=opaque-compressed-or-binary-payload",
  });
  try {
    await verifyReviewedOciLayout({
      layoutDirectory: layout.root,
      archivePath: layout.archivePath,
      image: layout.image,
      imageKey: "api",
    });
  } finally {
    rmSync(layout.fixtureRoot, { recursive: true, force: true });
  }
});

test("publishes and reuses only content-addressed digest references", async () => {
  for (const digestStatus of [404, 200]) {
    const layout = ociLayoutFixture({ duplicateFilesystemLayer: true });
    const registry = registryFixture(layout, {
      digestStatus,
      redirectBlobs: digestStatus === 404,
    });
    try {
      const result = await publishReviewedOciLayout({
        layoutDirectory: layout.root,
        archivePath: layout.archivePath,
        image: layout.image,
        imageKey: "api",
        actor: "modvolt",
        publicationToken: "fixture-publication-token-1234567890",
        resultPath: join(layout.root, `registry-result-${digestStatus}.json`),
        fetchImpl: registry.fetchImpl,
        now: () => new Date("2026-08-18T12:30:00.000Z"),
        sourceRecheck: async () => true,
      });
      assert.equal(result.result.referenceMode, "digest-only");
      assert.equal(
        result.result.preWriteDigestState,
        digestStatus === 200 ? "present" : "absent",
      );
      assert.equal(result.result.digestAlreadyPresent, digestStatus === 200);
      assert.equal(result.result.registryWritePerformed, digestStatus === 404);
      const manifestCalls = registry.calls.filter((call) =>
        call.path.includes("/manifests/"),
      );
      assert.ok(manifestCalls.length > 0);
      assert.ok(
        manifestCalls.every((call) =>
          /^\/v2\/modvolt\/site-logbook-production-api\/manifests\/sha256:[0-9a-f]{64}$/u.test(
            decodeURIComponent(call.path),
          ),
        ),
      );
      assert.ok(
        manifestCalls.every((call) => !call.path.endsWith(`/${SOURCE_SHA}`)),
      );
      assert.equal(
        manifestCalls.some((call) => call.method === "PUT"),
        digestStatus === 404,
      );
      assert.ok(
        registry.calls
          .filter((call) => call.path.startsWith("/blob/"))
          .every((call) => call.authorizationPresent === false),
      );
    } finally {
      rmSync(layout.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("live source recheck requires current main and the exact first push Quality attempt", async () => {
  const receipt = receiptFixture("preflight-only");
  const observedPaths = [];
  const fetchForAttempt = (runAttempt) => async (input) => {
    const url = new URL(input);
    observedPaths.push(url.pathname);
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      return new Response(
        JSON.stringify({ object: { type: "commit", sha: SOURCE_SHA } }),
        { status: 200 },
      );
    }
    if (
      url.pathname.endsWith(`/actions/runs/${receipt.source.qualityGate.runId}`)
    ) {
      return new Response(
        JSON.stringify({
          id: Number(receipt.source.qualityGate.runId),
          name: "Quality gate",
          path: ".github/workflows/quality-gate.yml",
          event: "push",
          head_branch: "main",
          head_sha: SOURCE_SHA,
          run_attempt: runAttempt,
          status: "completed",
          conclusion: "success",
          repository: { full_name: "modvolt/Site-Logbook" },
          head_repository: { full_name: "modvolt/Site-Logbook" },
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected source URL ${url.href}`);
  };
  assert.equal(
    await recheckExactProductionSource({
      receipt,
      fetchImpl: fetchForAttempt(1),
    }),
    true,
  );
  assert.deepEqual(observedPaths, [
    `/repos/modvolt/Site-Logbook/actions/runs/${receipt.source.qualityGate.runId}`,
    "/repos/modvolt/Site-Logbook/git/ref/heads/main",
  ]);
  observedPaths.length = 0;
  await assert.rejects(
    () =>
      recheckExactProductionSource({
        receipt,
        fetchImpl: fetchForAttempt(2),
      }),
    (error) =>
      error instanceof ProductionImagePublicationError &&
      error.code === "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
  );
  assert.deepEqual(observedPaths, [
    `/repos/modvolt/Site-Logbook/actions/runs/${receipt.source.qualityGate.runId}`,
  ]);
});

test("detects main moving during the awaited Quality recheck and performs zero writes", async () => {
  const layouts = {
    api: ociLayoutFixture({ imageKey: "api" }),
    controlPlane: ociLayoutFixture({ imageKey: "controlPlane" }),
    hostOperator: ociLayoutFixture({ imageKey: "hostOperator" }),
    web: ociLayoutFixture({ imageKey: "web" }),
  };
  const receipt = receiptFixture("preflight-only");
  receipt.images = Object.fromEntries(
    Object.entries(layouts).map(([key, layout]) => [key, layout.image]),
  );
  receipt.chain.reviewedImageSetSha256 = reviewedImageSetSha256(receipt.images);
  const registries = Object.fromEntries(
    Object.entries(layouts).map(([key, layout]) => [
      key,
      registryFixture(layout, { digestStatus: 404 }),
    ]),
  );
  const timeline = [];
  const registryFetchImpl = async (input, options) => {
    const url = new URL(input);
    let key;
    if (url.hostname === "ghcr.io" && url.pathname === "/token") {
      const scope = url.searchParams.get("scope") ?? "";
      key = Object.keys(layouts).find((candidate) =>
        scope.includes(
          layouts[candidate].image.repository.slice("ghcr.io/".length),
        ),
      );
    } else {
      key = Object.keys(layouts).find((candidate) =>
        url.pathname.startsWith(
          `/v2/${layouts[candidate].image.repository.slice("ghcr.io/".length)}/`,
        ),
      );
    }
    assert.ok(key, `unexpected set registry URL ${url.href}`);
    timeline.push(
      `registry:${key}:${options?.method ?? "GET"}:${url.pathname}`,
    );
    return registries[key].fetchImpl(input, options);
  };
  let currentMain = SOURCE_SHA;
  let qualityAwaitCompleted = false;
  const sourceFetchImpl = async (input) => {
    const url = new URL(input);
    timeline.push(`source:${url.pathname}`);
    assert.equal(
      timeline.filter(
        (entry) => entry.includes(":GET:/v2/") && entry.includes("/manifests/"),
      ).length,
      4,
      "all four exact digest lookups must precede the source recheck",
    );
    if (
      url.pathname.endsWith(`/actions/runs/${receipt.source.qualityGate.runId}`)
    ) {
      await Promise.resolve();
      currentMain = "f".repeat(40);
      qualityAwaitCompleted = true;
      return new Response(
        JSON.stringify({
          id: Number(receipt.source.qualityGate.runId),
          name: "Quality gate",
          path: ".github/workflows/quality-gate.yml",
          event: "push",
          head_branch: "main",
          head_sha: SOURCE_SHA,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          repository: { full_name: "modvolt/Site-Logbook" },
          head_repository: { full_name: "modvolt/Site-Logbook" },
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      assert.equal(qualityAwaitCompleted, true);
      return new Response(
        JSON.stringify({ object: { type: "commit", sha: currentMain } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected source recheck URL ${url.href}`);
  };
  try {
    await assert.rejects(
      () =>
        publishReviewedOciSet({
          receipt,
          publications: Object.fromEntries(
            Object.entries(layouts).map(([key, layout]) => [
              key,
              {
                layoutDirectory: layout.root,
                archivePath: layout.archivePath,
                resultPath: join(layout.root, `${key}-registry-result.json`),
              },
            ]),
          ),
          actor: "modvolt",
          publicationToken: "fixture-publication-token-1234567890",
          fetchImpl: registryFetchImpl,
          sourceFetchImpl,
        }),
      (error) =>
        error instanceof ProductionImagePublicationError &&
        error.code === "PRODUCTION_IMAGE_SOURCE_RECHECK_FAILED",
    );
    assert.deepEqual(
      timeline.filter((entry) => entry.startsWith("source:")),
      [
        `source:/repos/modvolt/Site-Logbook/actions/runs/${receipt.source.qualityGate.runId}`,
        "source:/repos/modvolt/Site-Logbook/git/ref/heads/main",
      ],
    );
    assert.equal(
      Object.values(registries)
        .flatMap((registry) => registry.calls)
        .some((call) => call.method === "PUT" || call.method === "POST"),
      false,
    );
  } finally {
    for (const layout of Object.values(layouts)) {
      rmSync(layout.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("fails closed on digest lookup authorization and byte drift before writes", async () => {
  for (const scenario of [
    { digestStatus: 403, expectedCode: "PRODUCTION_IMAGE_LOOKUP_FAILED" },
    {
      digestStatus: 503,
      expectedCode: "PRODUCTION_IMAGE_LOOKUP_FAILED",
    },
    {
      digestStatus: "network",
      expectedCode: "PRODUCTION_IMAGE_REGISTRY_NETWORK_FAILED",
    },
    {
      digestStatus: 200,
      corruptExistingRoot: true,
      expectedCode: "PRODUCTION_IMAGE_BINDING_INVALID",
    },
  ]) {
    const layout = ociLayoutFixture();
    const registry = registryFixture(layout, scenario);
    try {
      await assert.rejects(
        () =>
          publishReviewedOciLayout({
            layoutDirectory: layout.root,
            archivePath: layout.archivePath,
            image: layout.image,
            imageKey: "api",
            actor: "modvolt",
            publicationToken: "fixture-publication-token-1234567890",
            resultPath: join(layout.root, "must-not-exist.json"),
            fetchImpl: registry.fetchImpl,
            sourceRecheck: async () => true,
          }),
        (error) =>
          error instanceof ProductionImagePublicationError &&
          error.code === scenario.expectedCode,
      );
      assert.equal(
        registry.calls.some(
          (call) => call.method === "PUT" || call.method === "POST",
        ),
        false,
      );
    } finally {
      rmSync(layout.fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("rejects non-canonical bytes, schema widening and secret-shaped material", () => {
  const sealed = sealProductionImagePublicationReceipt(
    receiptFixture("preflight-only"),
  );
  assert.throws(
    () =>
      parseProductionImagePublicationReceipt(
        JSON.stringify(JSON.parse(sealed.canonical), null, 2),
      ),
    (error) =>
      error instanceof ProductionImagePublicationError &&
      error.code === "PRODUCTION_IMAGE_ARTIFACT_INVALID",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.approved = true;
    }),
    "PRODUCTION_IMAGE_SCHEMA_INVALID",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.caller.authorizationToken = "github_pat_abcdefghijklmnop";
    }),
    "PRODUCTION_IMAGE_SECRET_MATERIAL",
  );
  expectCode(
    changed("preflight-only", (receipt) => {
      receipt.createdAt = "2026-08-18T12:00:00Z";
    }),
    "PRODUCTION_IMAGE_TIME_INVALID",
  );
});

test("workflow is reusable, two-stage, digest-only and never rebuilds reviewed bytes", () => {
  const raw = readFileSync(".github/workflows/production-images.yml", "utf8");
  const workflow = YAML.parse(raw);
  assert.ok(workflow.on.workflow_call);
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(
    workflow.on.workflow_call.inputs.publication_stage.default,
    "preflight-only",
  );
  assert.equal(
    workflow.on.workflow_call.inputs.confirm_complete_registry_write.default,
    false,
  );
  assert.deepEqual(workflow.jobs["build-preflight"].permissions, {
    contents: "read",
  });
  assert.equal(
    workflow.jobs["build-preflight"].env.DOCKER_BUILD_RECORD_UPLOAD,
    "false",
  );
  assert.equal(
    workflow.jobs["publish-reviewed-complete"].permissions.packages,
    "write",
  );
  assert.equal(
    workflow.jobs["publish-reviewed-complete"].permissions.actions,
    "read",
  );
  assert.match(
    workflow.jobs["publish-reviewed-complete"].if,
    /publication_stage == 'complete'/u,
  );
  assert.doesNotMatch(
    raw,
    /site-logbook-staging|source_pr_number|pull_request/u,
  );
  assert.match(raw, /event=push/u);
  assert.match(raw, /\.event == "push"/u);
  assert.match(raw, /target: production/u);
  assert.match(raw, /target: control-plane/u);
  assert.match(raw, /target: host-operator/u);
  assert.match(raw, /ghcr\.io\/modvolt\/site-logbook-host-operator/u);
  assert.match(raw, /filesystem payloads are digest-bound/u);
  assert.match(raw, /not content-scanned/u);
  assert.match(raw, /never claimed secret-complete/u);
  assert.match(raw, /provenance: mode=max,version=v0\.2/u);
  assert.equal((raw.match(/sbom: true/gu) ?? []).length, 4);
  assert.equal((raw.match(/push: false/gu) ?? []).length, 4);
  assert.equal((raw.match(/push: true/gu) ?? []).length, 0);
  assert.equal((raw.match(/docker\/build-push-action@/gu) ?? []).length, 4);
  assert.equal((raw.match(/oci-artifact=false/gu) ?? []).length, 4);
  for (const [archive, repository] of [
    ["production-api.oci.tar", "site-logbook-production-api"],
    ["control-plane.oci.tar", "site-logbook-control-plane"],
    ["host-operator.oci.tar", "site-logbook-host-operator"],
    ["production-web.oci.tar", "site-logbook-production-web"],
  ]) {
    assert.match(
      raw,
      new RegExp(
        `outputs: type=oci,dest=${archive.replaceAll(".", "\\.")},name=ghcr\\.io/modvolt/${repository}:\\$\\{\\{ inputs\\.source_sha \\}\\},oci-artifact=false`,
        "u",
      ),
    );
  }
  assert.match(raw, /expected one layout root descriptor/u);
  assert.match(raw, /io\.containerd\.image\.name/u);
  assert.match(raw, /org\.opencontainers\.image\.ref\.name/u);
  assert.doesNotMatch(raw, /sha256sum "\$root\/index\.json"/u);
  assert.doesNotMatch(raw, /cp "\$root\/index\.json"/u);
  assert.match(
    raw,
    /preflight-artifact\/\$\{key\}-oci-index\.json" "\$\{root\}\/blobs\/sha256\/\$\{root_digest#sha256:\}"/u,
  );
  assert.match(
    raw,
    /\.subject == \[\{name:\$subjectName,digest:\{sha256:\(\$runnableDigest \| sub\("\^sha256:"; ""\)\)\}\}\]/u,
  );
  const completeJob = JSON.stringify(
    workflow.jobs["publish-reviewed-complete"],
  );
  const predecessorStep = workflow.jobs["publish-reviewed-complete"].steps.find(
    (step) =>
      step.name === "Download and verify the exact reviewed preflight bytes",
  );
  assert.ok(predecessorStep);
  assert.equal(
    (
      predecessorStep.run.match(
        /--arg callerWorkflowSha "\$CURRENT_CALLER_WORKFLOW_SHA"/gu,
      ) ?? []
    ).length,
    3,
  );
  assert.match(
    predecessorStep.run,
    /\.event == "workflow_dispatch" and \.head_branch == "main" and\s+\.head_sha == \$callerWorkflowSha/u,
  );
  assert.match(
    predecessorStep.run,
    /\.workflow_run\.head_sha == \$callerWorkflowSha/u,
  );
  assert.doesNotMatch(
    predecessorStep.run,
    /\.workflow_run\.head_sha == \$sourceSha/u,
  );
  const packagePostcheck = workflow.jobs[
    "publish-reviewed-complete"
  ].steps.find(
    (step) =>
      step.name ===
      "Require exact private package identities after publication",
  );
  assert.ok(packagePostcheck);
  assert.doesNotMatch(
    packagePostcheck.run,
    /expected_digest|SOURCE_SHA|registry-publication\.json/u,
  );
  assert.match(packagePostcheck.run, /\.visibility == "private"/u);
  assert.match(packagePostcheck.run, /\.version_count > 0/u);
  assert.match(
    packagePostcheck.run,
    /Digest integrity is established separately by the GHCR graph verifier\./u,
  );
  assert.doesNotMatch(
    completeJob,
    /docker\/build-push-action|docker\/setup-buildx-action|docker\/login-action/u,
  );
  assert.match(raw, /outputs: type=oci,dest=production-api\.oci\.tar/u);
  assert.match(raw, /outputs: type=oci,dest=host-operator\.oci\.tar/u);
  assert.match(raw, /--host-operator-layout preflight-hostOperator-oci/u);
  assert.match(raw, /--image-key hostOperator/u);
  assert.match(raw, /hostOperator-registry-publication\.json/u);
  assert.match(raw, /site-logbook-host-operator/u);
  assert.match(raw, /expected_preflight_artifact_id/u);
  assert.match(raw, /expected_preflight_artifact_digest/u);
  assert.match(raw, /preflightArtifactCreatedAt/u);
  assert.match(raw, /preflightArtifactExpiresAt/u);
  assert.match(raw, /publicationNonceSha256/u);
  assert.match(raw, /singleUseKeySha256/u);
  assert.match(raw, /caller_repository_id/u);
  assert.match(raw, /caller_workflow_sha/u);
  assert.match(raw, /\.actor_id == \$actorId/u);
  assert.match(raw, /--max-age-minutes 1440/u);
  assert.match(raw, /production-image-publication-contract\.mjs verify-oci/u);
  assert.equal(
    (raw.match(/production-image-publication-contract\.mjs verify-oci/gu) ?? [])
      .length,
    8,
  );
  assert.equal(
    (
      raw.match(
        /production-image-publication-contract\.mjs publish-oci-set/gu,
      ) ?? []
    ).length,
    1,
  );
  assert.doesNotMatch(
    raw,
    /production-image-publication-contract\.mjs publish-oci\s/u,
  );
  assert.match(raw, /referenceMode == "digest-only"/u);
  assert.match(raw, /sourceRecheckPerformed == true/u);
  assert.match(raw, /\$attestation\[0\]\.layers \| length\) == 2/u);
  assert.doesNotMatch(
    raw,
    /--source-tag|conditionalTagCreate|tagReferenceVerified/u,
  );
  assert.doesNotMatch(raw, /manifests\/\$\{SOURCE_SHA\}/u);
  assert.match(raw, /production-image-publication-contract\.mjs seal/u);
  assert.match(raw, /production-image-publication-contract\.mjs verify/u);
});
