import { FastifyInstance } from "fastify";
import { systemService } from "../../services/system.service";
import { tmaAuthMiddleware } from "../middleware/tma-auth";

export async function serversRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/servers/status
  app.get("/api/servers/status", async (_req, reply) => {
    const [resultA, resultB] = await Promise.allSettled([
      systemService.getStatusA(),
      systemService.getStatusB(),
    ]);
    return reply.send({
      serverA: resultA.status === "fulfilled" ? resultA.value : { error: resultA.reason?.message ?? "unreachable" },
      serverB: resultB.status === "fulfilled" ? resultB.value : { error: resultB.reason?.message ?? "unreachable" },
    });
  });
}
