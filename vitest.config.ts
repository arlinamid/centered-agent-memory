import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Path folding is a platform decision that every stored path depends on.
    // Pinned here so the suite asserts the same thing on Windows, macOS and
    // Linux; `test/projkey.test.ts` covers both foldings explicitly.
    env: { CAM_CASE_FOLD: "1" },
  },
});
