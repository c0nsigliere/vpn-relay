import { FastifyInstance } from "fastify";
import { createReadStream, statSync } from "fs";
import { basename } from "path";
import { env } from "../../config/env";
import { tmaAuthMiddleware } from "../middleware/tma-auth";

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/settings/db-info — returns DB file size
  app.get("/api/settings/db-info", async () => {
    const stat = statSync(env.DB_PATH);
    return { size: stat.size };
  });

  // GET /api/settings/backup — streams DB file as a download
  app.get("/api/settings/backup", async (_req, reply) => {
    const filename = basename(env.DB_PATH);
    const timestamp = new Date().toISOString().slice(0, 10);
    reply.header("Content-Disposition", `attachment; filename="vpn-bot-${timestamp}-${filename}"`);
    reply.header("Content-Type", "application/octet-stream");
    return reply.send(createReadStream(env.DB_PATH));
  });
}
