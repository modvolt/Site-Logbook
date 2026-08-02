import { defineConfig, devices } from "@playwright/test";
import * as path from "path";
import { readStagingReleaseEnvironment } from "../scripts/staging-release-guard.cjs";

const staging = readStagingReleaseEnvironment(process.env);
const authFile = path.resolve(
  __dirname,
  "test-results",
  "staging-auth",
  "admin.json",
);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const launchOptions = executablePath
  ? { executablePath, args: ["--no-sandbox", "--disable-setuid-sandbox"] }
  : undefined;

export default defineConfig({
  testDir: "./staging",
  testMatch: /release-.*\.spec\.ts/,
  globalSetup: "./staging/global.setup.ts",
  outputDir: "./test-results/staging",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: staging.baseURL,
    storageState: authFile,
    ignoreHTTPSErrors: false,
    trace: "off",
    screenshot: "off",
    video: "off",
    actionTimeout: 12_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "staging-api",
      testMatch: /release-api\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    {
      name: "staging-desktop",
      testMatch: /release-browser\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    {
      name: "staging-mobile",
      testMatch: /release-browser\.spec\.ts/,
      use: { ...devices["iPhone 13"], launchOptions },
    },
  ],
});
