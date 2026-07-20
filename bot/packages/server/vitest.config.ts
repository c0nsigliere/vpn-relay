import * as path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // @vpn-relay/shared resolves through package.json "main" -> dist/index.js.
      // That was harmless while shared exported only types (erased at compile
      // time), but isSubscriptionCapable is a real runtime import, so without
      // this alias `pnpm test` would fail on a clean checkout until shared had
      // been built. Point tests at the source instead — no build step, and no
      // risk of testing a stale dist. Deployment is unaffected: Ansible builds
      // shared before server/web (roles/telegram_bot/tasks/deploy.yml).
      "@vpn-relay/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
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
