import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

function shellExecutable() {
  if (process.platform !== "win32") return "sh";
  const execPath = execFileSync("git", ["--exec-path"], {
    encoding: "utf8",
  }).trim();
  const candidate = path.resolve(execPath, "../../../usr/bin/sh.exe");
  assert.equal(
    existsSync(candidate),
    true,
    "Git for Windows sh.exe is required",
  );
  return candidate;
}

const validator = fileURLToPath(
  new URL(
    "../../deploy/staging/preflight/validate-proxy-cidrs.sh",
    import.meta.url,
  ),
);
const boundaryPreflight = fileURLToPath(
  new URL("../../deploy/staging/preflight/preflight.sh", import.meta.url),
);

function validate(value) {
  return spawnSync(shellExecutable(), [validator.replaceAll("\\", "/")], {
    encoding: "utf8",
    env: { ...process.env, STAGING_API_TRUSTED_PROXY_CIDRS: value },
  });
}

test("staging proxy preflight accepts explicit canonical IPv4 values", () => {
  for (const value of ["172.20.0.2", "172.20.0.0/28,192.0.2.40"]) {
    const result = validate(value);
    assert.equal(result.status, 0, `${value}: ${result.stderr}`);
  }
});

test("staging proxy preflight rejects values the API would reject", () => {
  for (const value of [
    "",
    ",",
    "172.20.0.2,",
    "172.20.0.2,,192.0.2.40",
    "999.1.1.1",
    "001.002.003.004",
    "172.20.0.0/0",
    "172.20.0.0/33",
    "172.20.0.0/nope",
    "uniquelocal",
    "2001:db8::1",
  ]) {
    const result = validate(value);
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /STAGING PREFLIGHT FAILED/);
  }
});

test("staging boundary preflight remains valid POSIX shell", () => {
  const result = spawnSync(
    shellExecutable(),
    ["-n", boundaryPreflight.replaceAll("\\", "/")],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
