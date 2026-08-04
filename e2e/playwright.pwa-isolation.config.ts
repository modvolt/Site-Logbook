import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PWA_ISOLATION_PORT ?? 4192);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error(`Invalid PWA_ISOLATION_PORT: ${process.env.PWA_ISOLATION_PORT ?? ""}`);
}

const baseURL = `http://127.0.0.1:${port}`;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

export default defineConfig({
  testDir: "./pwa-isolation",
  testMatch: /.*\.spec\.ts/,
  outputDir: "./test-results/pwa-isolation",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  webServer: {
    command: `node pwa-isolation/mock-pwa-server.mjs ${port}`,
    cwd: __dirname,
    url: `${baseURL}/__test/health`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "edge-pwa-isolation",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath,
          args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
        },
      },
    },
  ],
});
