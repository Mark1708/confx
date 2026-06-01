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
    include: ["tests/**/*.test.ts"],
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
