import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Populates process.env before any test module is imported — config/env.ts
    // exits the process on an invalid environment at import time.
    setupFiles: ["src/test/setup.ts"],
    // One process per file: db/index.ts opens a SQLite handle at import time, so
    // files must not share a module graph.
    isolate: true,
  },
});
