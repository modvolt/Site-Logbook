import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const HARNESS_DOCKERFILE = path.join(
  REPO_ROOT,
  "deploy/test/workflow-harness/Dockerfile",
);
const HARNESS_CONTEXT = path.dirname(HARNESS_DOCKERFILE);
const HARNESS_DEFINITION_DIGEST = createHash("sha256")
  .update(fs.readFileSync(HARNESS_DOCKERFILE, "utf8").replaceAll("\r\n", "\n"))
  .digest("hex")
  .slice(0, 16);
export const WORKFLOW_HARNESS_IMAGE = `site-logbook/workflow-harness:alpine-3.22.1-${HARNESS_DEFINITION_DIGEST}`;

function formatYamlErrors(errors) {
  return errors.map((error) => error.message).join("\n");
}

export function parseWorkflow(source, sourceName = "workflow") {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${sourceName} is not valid unique-key YAML:\n${formatYamlErrors(document.errors)}`,
    );
  }
  const workflow = document.toJS({ mapAsMap: false });
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error(`${sourceName} must contain a YAML mapping.`);
  }
  return workflow;
}

export function readWorkflow(
  relativePath = ".github/workflows/staging-images.yml",
) {
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  return parseWorkflow(fs.readFileSync(absolutePath, "utf8"), relativePath);
}

export function requireWorkflowStep(workflow, jobName, stepName) {
  const steps = workflow?.jobs?.[jobName]?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`Workflow job ${jobName} has no steps.`);
  }
  const matches = steps.filter((step) => step?.name === stepName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${jobName} step named ${JSON.stringify(stepName)}; found ${matches.length}.`,
    );
  }
  return matches[0];
}

export function requireRunScript(workflow, jobName, stepName) {
  const step = requireWorkflowStep(workflow, jobName, stepName);
  if (typeof step.run !== "string" || step.run.trim() === "") {
    throw new Error(`${jobName}/${stepName} has no executable run script.`);
  }
  return step.run;
}

export function extractQuotedHeredoc(runScript, marker) {
  const lines = runScript.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line.includes(`<<'${marker}'`));
  if (start < 0) throw new Error(`Heredoc ${marker} was not found.`);
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === marker,
  );
  if (end < 0) throw new Error(`Heredoc ${marker} is not terminated.`);
  return `${lines.slice(start + 1, end).join("\n")}\n`;
}

function writeHarnessFiles(root, script, files) {
  fs.writeFileSync(
    path.join(root, "run.sh"),
    script.replaceAll("\r\n", "\n"),
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf8");
    if (relativePath.split(/[\\/]/u)[0] === "bin") {
      fs.chmodSync(absolutePath, 0o755);
    }
  }
}

function inspectHarnessImage() {
  return spawnSync("docker", ["image", "inspect", WORKFLOW_HARNESS_IMAGE], {
    encoding: "utf8",
    stdio: "ignore",
  });
}

function requireHarnessImage() {
  const inspect = inspectHarnessImage();
  if (inspect.status === 0) return;
  throw new Error(
    `Offline workflow harness image ${WORKFLOW_HARNESS_IMAGE} is missing. ` +
      "Run `pnpm prepare:staging-workflow-harness` before the tests.",
  );
}

export function prepareWorkflowHarnessImage() {
  const inspect = spawnSync(
    "docker",
    ["image", "inspect", WORKFLOW_HARNESS_IMAGE],
    {
      encoding: "utf8",
      stdio: "ignore",
    },
  );
  if (inspect.status === 0) return WORKFLOW_HARNESS_IMAGE;
  const build = spawnSync(
    "docker",
    [
      "build",
      "--pull",
      "--platform",
      "linux/amd64",
      "--tag",
      WORKFLOW_HARNESS_IMAGE,
      "--file",
      HARNESS_DOCKERFILE,
      HARNESS_CONTEXT,
    ],
    { encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(
      `Unable to build the offline workflow harness image:\n${build.stderr || build.stdout}`,
    );
  }
  if (inspectHarnessImage().status !== 0) {
    throw new Error(
      `Docker reported success but ${WORKFLOW_HARNESS_IMAGE} is unavailable.`,
    );
  }
  return WORKFLOW_HARNESS_IMAGE;
}

function resolveHarnessEnvironment(environment, runtimeRoot) {
  return Object.fromEntries(
    Object.entries(environment).map(([key, value]) => [
      key,
      String(value).replaceAll("{HARNESS_ROOT}", runtimeRoot),
    ]),
  );
}

function readCapturedFiles(root, captureFiles) {
  return Object.fromEntries(
    captureFiles.map((relativePath) => {
      const absolutePath = path.join(root, relativePath);
      return [
        relativePath,
        fs.existsSync(absolutePath)
          ? fs.readFileSync(absolutePath, "utf8")
          : null,
      ];
    }),
  );
}

export function resolveContainerUser({
  platform = process.platform,
  getuid = process.getuid,
  getgid = process.getgid,
} = {}) {
  if (platform === "win32") return null;
  if (typeof getuid !== "function" || typeof getgid !== "function") {
    throw new Error(
      "POSIX workflow harness requires numeric host UID and GID.",
    );
  }
  return `${getuid()}:${getgid()}`;
}

export function dockerIsolationArgs() {
  return [
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=16m",
  ];
}

export function runBashHarness({
  script,
  files = {},
  environment = {},
  args = [],
  captureFiles = [],
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-logbook-workflow-"));
  try {
    writeHarnessFiles(root, script, files);
    requireHarnessImage();
    const runtimeRoot = "/work";
    const resolvedEnvironment = resolveHarnessEnvironment(
      environment,
      runtimeRoot,
    );
    const resolvedArgs = args.map((value) =>
      String(value).replaceAll("{HARNESS_ROOT}", runtimeRoot),
    );
    const dockerArgs = [
      "run",
      "--rm",
      ...dockerIsolationArgs(),
      "--mount",
      `type=bind,source=${root},target=${runtimeRoot}`,
      "--workdir",
      runtimeRoot,
    ];
    const containerUser = resolveContainerUser();
    if (containerUser) dockerArgs.push("--user", containerUser);
    for (const [key, value] of Object.entries(resolvedEnvironment)) {
      dockerArgs.push("--env", `${key}=${value}`);
    }
    dockerArgs.push(
      "--env",
      "PATH=/work/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      WORKFLOW_HARNESS_IMAGE,
      "/work/run.sh",
      ...resolvedArgs,
    );
    const result = spawnSync("docker", dockerArgs, { encoding: "utf8" });

    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      captured: readCapturedFiles(root, captureFiles),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export { REPO_ROOT };
