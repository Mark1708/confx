import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    testTimeout: 30_000,
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: [
        "src/lib/**/*.ts",
        "src/sidepanel/**/*.ts",
        "src/background/**/*.ts",
        "src/content/**/*.ts",
      ],
      thresholds: {
        statements: 44,
        branches: 44,
        functions: 52,
        lines: 45,
      },
    },
  },
});
