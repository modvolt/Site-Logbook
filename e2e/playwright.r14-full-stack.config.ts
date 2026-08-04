import { defineConfig, devices } from "@playwright/test";
import * as fs from "node:fs";
import { r14AuthFile, r14Environment } from "./r14-full-stack/runtime";

const candidates = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim(),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((value): value is string => Boolean(value));
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) {
  throw new Error(
    "R14 requires an installed Chromium-family browser; set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
  );
}

export default defineConfig({
  testDir: "./r14-full-stack",
  testMatch: /full-stack\.spec\.ts/,
  globalSetup: "./r14-full-stack/global.setup.ts",
  outputDir: "./test-results/r14-full-stack/artifacts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: r14Environment.baseURL,
    storageState: r14AuthFile,
    launchOptions: {
      executablePath,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
});
