import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { access, readFile, rm } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const buildSha = process.env.BUILD_SHA?.trim().toLowerCase() || "dev";
  if (buildSha !== "dev" && !/^[0-9a-f]{40}$/.test(buildSha)) {
    throw new Error("BUILD_SHA must be dev or an exact 40-character Git SHA.");
  }
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  // Keep esbuild's outdir relative so esbuild-plugin-pino resolves its worker
  // files from the runtime working directory. An absolute outdir would embed
  // the builder path (for example /repo/...) and break after the bundle is
  // relocated into the production image at /app/dist.
  const previousWorkingDirectory = process.cwd();
  process.chdir(artifactDir);

  await esbuild({
    entryPoints: [
      path.resolve(artifactDir, "src/index.ts"),
      path.resolve(artifactDir, "src/migrate.ts"),
      path.resolve(artifactDir, "src/external-schema-preflight.ts"),
      path.resolve(artifactDir, "src/external-schema-inventory.ts"),
      path.resolve(artifactDir, "src/external-schema-steady-state.ts"),
      path.resolve(artifactDir, "src/external-schema-gate.ts"),
      path.resolve(artifactDir, "src/accounting-schema-gate.ts"),
      path.resolve(artifactDir, "src/accounting-schema-steady-state.ts"),
      path.resolve(artifactDir, "src/accounting-schema-inventory.ts"),
      path.resolve(artifactDir, "src/accounting-schema-exact-0105-backup.ts"),
      path.resolve(artifactDir, "src/production-exact-0096-backup-producer.ts"),
      path.resolve(
        artifactDir,
        "src/production-exact-0096-backup-host-worker.ts",
      ),
      path.resolve(artifactDir, "src/production-migration-host-operator.ts"),
      path.resolve(artifactDir, "src/audit-schema-inventory.ts"),
      path.resolve(artifactDir, "src/audit-schema-gate.ts"),
      path.resolve(artifactDir, "src/audit-schema-steady-state.ts"),
      path.resolve(artifactDir, "src/audit-schema-exact-0106-backup.ts"),
      path.resolve(artifactDir, "src/external-schema-baseline-0104.ts"),
      path.resolve(artifactDir, "src/external-schema-exact-0104-backup.ts"),
      path.resolve(artifactDir, "src/external-schema-exact-0104-recovery.ts"),
    ],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    define: {
      __SITE_LOGBOOK_BUILD_SHA__: JSON.stringify(buildSha),
    },
    // Embed binary font assets (Roboto TTF for the invoice PDF) directly into the
    // bundle as base64 strings. This keeps PDF generation self-contained — no
    // runtime filesystem reads — so it works identically in dev and in the
    // production Docker image (which only ships dist/, not src/assets).
    loader: { ".ttf": "base64", ".png": "dataurl" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "@napi-rs/canvas",
      "@napi-rs/canvas-*",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "imapflow",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      "connect-pg-simple",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] }),
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  const pinoRuntimeFiles = [
    "thread-stream-worker.mjs",
    "pino-worker.mjs",
    "pino-file.mjs",
    "pino-pretty.mjs",
  ];
  await Promise.all(
    pinoRuntimeFiles.map((file) => access(path.join(distDir, file))),
  );

  const forbiddenBuildPaths = [
    artifactDir,
    artifactDir.replaceAll("\\", "\\\\"),
  ];
  for (const entry of ["index.mjs", "migrate.mjs"]) {
    const bundle = await readFile(path.join(distDir, entry), "utf8");
    if (!bundle.includes("const workingDir = process.cwd();")) {
      throw new Error(
        `${entry} does not resolve Pino worker files from the runtime working directory.`,
      );
    }
    if (forbiddenBuildPaths.some((buildPath) => bundle.includes(buildPath))) {
      throw new Error(`${entry} embeds the API build directory.`);
    }
  }

  process.chdir(previousWorkingDirectory);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
