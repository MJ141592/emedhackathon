import { defineConfig, devices } from "@playwright/test";

const frontendPort = Number(process.env.FRONTEND_PORT ?? 5173);
const backendPort = Number(process.env.BACKEND_PORT ?? 8000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${frontendPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // The demo API intentionally models one patient aggregate. Serial workers keep each
  // reset-and-journey transaction isolated from the next one.
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command: "npm run dev:backend",
          url: `http://127.0.0.1:${backendPort}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
        {
          command: "npm run dev:frontend",
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
