import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: [
      "apps/**/src/**/*.test.ts",
      "apps/**/src/**/*.spec.ts",
      "packages/**/src/**/*.test.ts",
      "packages/**/src/**/*.spec.ts",
      "packages/**/test/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "test/**/*.test.ts",
    ],
    exclude: ["node_modules", "dist", ".turbo", ".output"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
    },
  },
});
