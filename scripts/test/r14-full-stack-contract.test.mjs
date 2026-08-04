import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..", "..");
const composePath = path.join(
  root,
  "deploy",
  "test",
  "r14",
  "docker-compose.yml",
);
const runnerPath = path.join(root, "scripts", "run-r14-full-stack-gate.mjs");
const providerPath = path.join(
  root,
  "deploy",
  "test",
  "r14",
  "provider-fakes.mjs",
);
const workflowPath = path.join(
  root,
  ".github",
  "workflows",
  "quality-gate.yml",
);
const dockerignorePath = path.join(root, ".dockerignore");
const apiDockerfilePath = path.join(
  root,
  "artifacts",
  "api-server",
  "Dockerfile",
);

const [composeSource, runner, provider, workflow, dockerignore, apiDockerfile] =
  await Promise.all([
    readFile(composePath, "utf8"),
    readFile(runnerPath, "utf8"),
    readFile(providerPath, "utf8"),
    readFile(workflowPath, "utf8"),
    readFile(dockerignorePath, "utf8"),
    readFile(apiDockerfilePath, "utf8"),
  ]);
const compose = YAML.parse(composeSource);

test("R14 stateful/application services remain internal and only web binds loopback", () => {
  assert.deepEqual(
    Object.keys(compose.services).sort(),
    ["api", "minio", "minio-init", "postgres", "provider-fakes", "web"].sort(),
  );
  assert.equal(compose.networks.r14_internal.internal, true);
  assert.deepEqual(Object.keys(compose.networks).sort(), [
    "r14_host",
    "r14_internal",
  ]);
  assert.equal(
    compose.volumes,
    undefined,
    "named persistent volumes are forbidden",
  );
  for (const [name, service] of Object.entries(compose.services)) {
    assert.ok(
      service.networks.includes("r14_internal"),
      `${name} must use the internal network`,
    );
    for (const port of service.ports ?? []) {
      assert.match(
        String(port),
        /^127\.0\.0\.1:/,
        `${name} port must bind only to loopback`,
      );
    }
  }
  assert.ok(
    compose.services.postgres.tmpfs.includes("/var/lib/postgresql/data"),
  );
  assert.ok(compose.services.minio.tmpfs.includes("/data"));
  for (const name of [
    "api",
    "postgres",
    "minio",
    "minio-init",
    "provider-fakes",
  ]) {
    assert.equal(
      compose.services[name].ports,
      undefined,
      `${name} must not publish a host port`,
    );
    assert.ok(!compose.services[name].networks.includes("r14_host"));
  }
  assert.ok(compose.services.web.networks.includes("r14_host"));
});

test("all public R14 images are immutable and app images are exact-SHA inputs", () => {
  for (const name of ["postgres", "minio", "minio-init", "provider-fakes"]) {
    assert.match(compose.services[name].image, /@sha256:[0-9a-f]{64}$/);
  }
  assert.equal(
    compose.services.api.image,
    "${R14_API_IMAGE:?set exact-SHA local R14 API image}",
  );
  assert.equal(
    compose.services.web.image,
    "${R14_WEB_IMAGE:?set exact-SHA local R14 web image}",
  );
  assert.equal(compose.services.api.pull_policy, "never");
  assert.equal(compose.services.web.pull_policy, "never");
  assert.ok(
    apiDockerfile.indexOf("apt-get install") <
      apiDockerfile.indexOf("ARG BUILD_SHA=dev"),
    "exact-SHA metadata must not invalidate the PostgreSQL client layer",
  );
});

test("runtime uses only synthetic test configuration and test-only provider boundaries", () => {
  const env = compose.services.api.environment;
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.BUILD_SHA, "${R14_SOURCE_SHA:?set exact Git SHA}");
  assert.equal(env.MAIL_TEST_ALLOW_INSECURE, "true");
  assert.equal(env.OPENAI_TEST_BASE_URL, "http://provider-fakes:4010/v1");
  assert.equal(env.S3_ENDPOINT, "http://minio:9000");
  assert.equal(env.BACKUP_ENABLED, "false");
  assert.notEqual(env.SECRET_ENCRYPTION_KEYRING, env.BACKUP_ENCRYPTION_KEYRING);
  assert.doesNotMatch(
    composeSource,
    /\b(PRODUCTION|PROD_|STAGING_|COOLIFY|HETZNER|GHCR)\b/i,
  );
  assert.doesNotMatch(composeSource, /0100_user_ui_preferences/i);
});

test("provider controls expose deterministic health and explicit fault modes", () => {
  for (const marker of [
    "R14_PROVIDER_CONTROL_TOKEN",
    '"/__test/reset"',
    '"/__test/modes"',
    '"/__test/state"',
    'smtp: new Set(["healthy", "fail"])',
    'imap: new Set(["healthy", "fail"])',
    'ai: new Set(["healthy", "http500", "timeout"])',
  ]) {
    assert.ok(provider.includes(marker), `provider fake is missing ${marker}`);
  }
  assert.ok(provider.includes("sha256"));
  assert.ok(
    !provider.includes("body: body"),
    "raw SMTP body must not enter evidence state",
  );
});

test("runner enforces exact provenance, restore/fault proof, and unconditional teardown", () => {
  for (const marker of [
    'git", ["rev-parse", "HEAD"]',
    '"pg_dump"',
    '"pg_restore"',
    'compose(["stop", "--timeout", "5", "minio"])',
    'compose(["stop", "--timeout", "5", "postgres"])',
    "await injectProviderFaults()",
    '"down", "--volumes", "--remove-orphans"',
    "loopbackPortsClosed",
    "syntheticCredentialsOnly: true",
    "options.timeoutMs ?? 120_000",
    "timeoutMs: 600_000",
    "timeoutMs: 30_000",
    "await persistEvidence()",
  ]) {
    assert.ok(runner.includes(marker), `runner is missing ${marker}`);
  }
  assert.match(
    runner,
    /captureText\("git", \[\s*"status",\s*"--porcelain=v1",\s*"--untracked-files=all",\s*\]\)/,
  );
  assert.equal((runner.match(/DOCKER_BUILDKIT: "1"/g) ?? []).length, 2);
  assert.ok(runner.includes('"docker-buildx.exe"'));
  assert.ok(runner.includes('["build", "--load"]'));
  assert.doesNotMatch(runner, /"--no-privileges",\s*"-",/);
  assert.ok(runner.includes('options.input !== undefined'));
  assert.ok(runner.includes('["pipe", "inherit", "inherit"]'));
  assert.match(dockerignore, /^\/tmp$/m);
  assert.match(dockerignore, /^\/e2e\/test-results$/m);
  assert.ok(runner.indexOf("finally {") < runner.indexOf("await cleanup();"));
});

test("mandatory GitHub gate runs the isolated stack against the checked-out SHA", () => {
  const parsed = YAML.parse(workflow);
  const job = parsed.jobs["hermetic-release-gate"];
  assert.ok(job["timeout-minutes"] >= 55);
  const step = job.steps.find(
    (candidate) => candidate.name === "R14 isolated full-stack and fault gate",
  );
  assert.equal(step.run, "pnpm test:e2e:r14-full-stack");
  assert.equal(step.env.R14_SOURCE_SHA, "${{ github.sha }}");
});
