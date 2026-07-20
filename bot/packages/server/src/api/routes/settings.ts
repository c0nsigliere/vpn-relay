import { FastifyInstance } from "fastify";
import { createReadStream, rmSync, statSync } from "fs";
import { randomUUID } from "crypto";
import * as path from "path";
import { env } from "../../config/env";
import { db } from "../../db/index";
import { queries } from "../../db/queries";
import { backupService } from "../../services/backup.service";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import type { DbInfoResponse } from "@vpn-relay/shared";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/settings/db-info — DB size + the last backup, for the settings screen
  app.get("/api/settings/db-info", async (): Promise<DbInfoResponse> => {
    const stat = statSync(env.DB_PATH);
    const last = queries.getLastBackupRun(["success", "degraded", "failed"]);
    return {
      size: stat.size,
      lastBackup: last
        ? {
            finished_at: last.finished_at,
            status: last.status,
            bundle_bytes: last.bundle_bytes,
            telegram_ok: last.telegram_ok,
          }
        : null,
    };
  });

  // GET /api/settings/backup — download a consistent snapshot of the DB.
  //
  // Streaming env.DB_PATH directly (the previous behaviour) hands out a torn copy:
  // the DB is in WAL mode, so recent transactions live in the -wal sidecar that a raw
  // read never sees. db.backup() produces a checkpointed snapshot while the bot runs.
  //
  // This stays PLAIN SQLite, unlike the encrypted bundles — a deliberate asymmetry.
  // The transfer is TLS, but the browser saves an unencrypted file onto the admin's
  // device. That device is already inside the trust boundary: it holds the Telegram
  // session that controls the whole bot. Treat downloaded DB files like artifacts/.
  app.get("/api/settings/backup", async (_req, reply) => {
    const tmp = path.join(backupService.stagingDir, `download-${randomUUID()}.db`);
    await db.backup(tmp);

    const timestamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Disposition", `attachment; filename="vpn-bot-${timestamp}-data.db"`);
    reply.header("Content-Type", "application/octet-stream");

    const stream = createReadStream(tmp);
    // "close" rather than a fastify onResponse hook: it also fires when the client
    // aborts mid-download, which is exactly when a temp file would otherwise leak.
    stream.on("close", () => rmSync(tmp, { force: true }));
    return reply.send(stream);
  });
}
