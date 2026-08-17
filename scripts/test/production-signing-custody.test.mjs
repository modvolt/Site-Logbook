import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { restoreProductionSigningVault } from "../production-evidence/production-signing-custody.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");
const CLI = join(
  ROOT,
  "scripts",
  "production-evidence",
  "production-signing-custody.mjs",
);
const DPAPI = join(
  ROOT,
  "scripts",
  "production-evidence",
  "production-signing-dpapi.ps1",
);

function unprotect(vault, role, filename) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      DPAPI,
      "-Operation",
      "unprotect",
      "-Path",
      join(vault, filename),
      "-Role",
      role,
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  return Buffer.from(result.stdout, "base64").toString("utf8");
}

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024,
  });
  assert.equal(
    result.status,
    expectedStatus,
    `stdout=${result.stdout}\nstderr=${result.stderr}`,
  );
  return result;
}

test(
  "creates four independent protected roles and only explicit bounded exports",
  { skip: process.platform !== "win32" },
  () => {
    const dpapiSource = readFileSync(DPAPI, "utf8");
    assert.match(dpapiSource, /Set-Clipboard -Value \(\[char\]32\)/);
    assert.doesNotMatch(dpapiSource, /Set-Clipboard -Value ""/);

    const root = mkdtempSync(join(tmpdir(), "site-logbook-signing-custody-"));
    try {
      const vault = join(root, "vault");
      const created = run([
        "init",
        "--vault",
        vault,
        "--publisher-key-id",
        "ed25519:production-publisher-test",
        "--host-key-id",
        "ed25519:production-host-test",
        "--secret-key-id",
        "production-secret-test",
        "--backup-key-id",
        "production-backup-test",
        "--confirm",
        "INITIALIZE_NEW_PRODUCTION_KEY_VAULT",
      ]);
      assert.match(created.stdout, /privateMaterialPrinted=false/);
      assert.doesNotMatch(created.stdout, /BEGIN PRIVATE KEY/);

      const manifest = JSON.parse(
        readFileSync(join(vault, "public-trust-roots.json"), "utf8"),
      );
      assert.notEqual(
        manifest.publisherProvenance.publicKeySha256,
        manifest.hostEvidence.publicKeySha256,
      );
      const status = run(["status", "--vault", vault]);
      assert.match(status.stdout, /ready=true/);
      assert.match(status.stdout, /recoveryBindingsVerified=true/);
      assert.doesNotMatch(status.stdout, /BEGIN PRIVATE KEY/);

      const restoredVault = join(root, "restored-vault");
      restoreProductionSigningVault({
        vault: restoredVault,
        publicManifestCanonical: readFileSync(
          join(vault, "public-trust-roots.json"),
        ),
        recoveryCards: {
          publisherProvenance: unprotect(
            vault,
            "publisher-provenance",
            "publisher-provenance.recovery.dpapi",
          ),
          hostEvidence: unprotect(
            vault,
            "host-evidence",
            "host-evidence.recovery.dpapi",
          ),
          secretEnvelope: unprotect(
            vault,
            "secret-envelope",
            "secret-envelope.recovery.dpapi",
          ),
          backupEncryption: unprotect(
            vault,
            "backup-encryption",
            "backup-encryption.recovery.dpapi",
          ),
        },
      });
      const restoredStatus = run(["status", "--vault", restoredVault]);
      assert.match(restoredStatus.stdout, /ready=true/);
      assert.match(restoredStatus.stdout, /recoveryBindingsVerified=true/);
      assert.deepEqual(
        readFileSync(join(restoredVault, "public-trust-roots.json")),
        readFileSync(join(vault, "public-trust-roots.json")),
      );
      const unattendedRestore = run(
        [
          "restore",
          "--vault",
          join(root, "unattended-vault"),
          "--public-manifest",
          join(vault, "public-trust-roots.json"),
          "--confirm",
          "RESTORE_NEW_PRODUCTION_KEY_VAULT",
        ],
        1,
      );
      assert.match(unattendedRestore.stderr, /interactive masked TTY/);
      assert.equal(existsSync(join(root, "unattended-vault")), false);
      assert.throws(
        () =>
          restoreProductionSigningVault({
            vault: restoredVault,
            publicManifestCanonical: readFileSync(
              join(vault, "public-trust-roots.json"),
            ),
            recoveryCards: {},
          }),
        /exactly four reviewed recovery cards|existing signing vault path/,
      );

      const publisherInput = join(root, "publisher.json");
      const publisherSignature = join(root, "publisher.sig");
      const publisherBytes = Buffer.from('{"kind":"publisher-test"}\n');
      writeFileSync(publisherInput, publisherBytes);
      run([
        "sign",
        "--vault",
        vault,
        "--purpose",
        "publisher-provenance",
        "--input",
        publisherInput,
        "--output",
        publisherSignature,
      ]);
      assert.equal(
        verify(
          null,
          publisherBytes,
          createPublicKey(manifest.publisherProvenance.publicKeyPem),
          readFileSync(publisherSignature),
        ),
        true,
      );

      const backupInput = join(root, "backup-envelope.json");
      const backupSignature = join(root, "backup-envelope.sig");
      const backupBytes = Buffer.from('{"kind":"backup-test"}\n');
      writeFileSync(backupInput, backupBytes);
      run([
        "sign",
        "--vault",
        vault,
        "--purpose",
        "backup-receipt",
        "--input",
        backupInput,
        "--output",
        backupSignature,
      ]);
      assert.equal(
        verify(
          null,
          Buffer.concat([
            Buffer.from(
              "site-logbook.production-exact-0096-backup-executor-signature/v1\0",
            ),
            backupBytes,
          ]),
          createPublicKey(manifest.hostEvidence.publicKeyPem),
          readFileSync(backupSignature),
        ),
        true,
      );

      const rejected = run(
        [
          "export-coolify-clipboard",
          "--vault",
          vault,
          "--clipboard-seconds",
          "30",
          "--confirm",
          "WRONG_CONFIRMATION",
        ],
        1,
      );
      assert.match(rejected.stderr, /exact clipboard confirmation is required/);
      assert.equal(
        existsSync(join(vault, "coolify-production-encryption.env")),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "rejects a new vault beneath a junction before creating it",
  { skip: process.platform !== "win32" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "site-logbook-signing-path-"));
    try {
      const target = join(root, "target");
      const junction = join(root, "junction");
      writeFileSync(join(root, "placeholder"), "public-test");
      mkdirSync(target);
      symlinkSync(target, junction, "junction");
      const rejected = run(
        [
          "init",
          "--vault",
          join(junction, "vault"),
          "--publisher-key-id",
          "ed25519:production-publisher-test",
          "--host-key-id",
          "ed25519:production-host-test",
          "--secret-key-id",
          "production-secret-test",
          "--backup-key-id",
          "production-backup-test",
          "--confirm",
          "INITIALIZE_NEW_PRODUCTION_KEY_VAULT",
        ],
        1,
      );
      assert.match(rejected.stderr, /verify-new-path failed/);
      assert.equal(existsSync(join(target, "vault")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
