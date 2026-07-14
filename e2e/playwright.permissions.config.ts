import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PERMISSION_E2E_PORT ?? 4191);
const baseURL = `http://127.0.0.1:${port}`;
const edgePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const launchOptions = {
  executablePath: edgePath,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
};

export default defineConfig({
  testDir: "./mock-tests",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  webServer: {
    command: `node mock-static-server.mjs ${port}`,
    cwd: __dirname,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-edge",
      use: { ...devices["Desktop Chrome"], launchOptions },
    },
    {
      name: "mobile-viewport-edge",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        launchOptions,
      },
    },
  ],
});
