import { defineConfig } from "@playwright/test";
import { LOCAL_ORIGIN, LOCAL_PORT } from "./sandbox/e2e/origin.mjs";

export default defineConfig({
  testDir: "./sandbox/e2e",
  testMatch: "**/*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: "tests/reports/sandbox/results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "tests/reports/sandbox/report", open: "never" }],
    ["junit", { outputFile: "tests/reports/sandbox/results/junit.xml" }],
  ],
  use: {
    baseURL: LOCAL_ORIGIN,
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [{ name: "unpacked-confx-chromium" }],
  webServer: {
    command: "npm run sandbox",
    url: `${LOCAL_ORIGIN}/health`,
    env: { SANDBOX_PORT: LOCAL_PORT },
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    stdout: "pipe",
    stderr: "pipe",
  },
});
