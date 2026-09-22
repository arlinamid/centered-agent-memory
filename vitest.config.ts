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
    //
    // Pinned, but not nailed shut: `test.env` overrides the shell, so writing
    // "1" outright would silently ignore a caller asking for the other
    // folding — and CI runs the suite a second time doing exactly that.
    env: { CAM_CASE_FOLD: process.env.CAM_CASE_FOLD ?? "1" },

    // A large part of this suite spawns the CLI as a real subprocess, so each
    // worker costs far more than a worker usually does. On a two-core runner
    // that starved vitest's own main thread until it gave up on a worker
    // ("Timeout calling onTaskUpdate") — first at 454 tests with no cap, then
    // again at 606 with two workers on Windows Node 26, every test green.
    // One worker on CI trades wall time for a run that does not fail for
    // reasons unrelated to the code.
    maxWorkers: process.env.CI ? 1 : undefined,
  },
});
