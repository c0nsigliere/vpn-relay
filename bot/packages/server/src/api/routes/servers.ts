import { FastifyInstance } from "fastify";
import { systemService } from "../../services/system.service";
import { getPing } from "../../services/ping.store";
import { queries } from "../../db/queries";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import { env } from "../../config/env";
import type { ServerId, ServerTrafficResponse } from "@vpn-relay/shared";

const PERIOD_LIMITS: Record<string, number> = {
  "24h": 144,
  "7d": 1008,
  "30d": 4320,
};

/** Downsample array to at most `target` evenly-spaced points */
function downsample<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  return Array.from({ length: target }, (_, i) => arr[Math.round(i * step)]);
}

export async function serversRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/servers/status
  app.get("/api/servers/status", async (_req, reply) => {
    const [resultA, resultB] = await Promise.allSettled([
      systemService.getStatusA(),
      systemService.getStatusB(),
    ]);

    const ping = getPing();

    const serverA = resultA.status === "fulfilled"
      ? { ...resultA.value, pingMs: ping?.ms, pingLossPercent: ping?.lossPercent }
      : { error: resultA.reason?.message ?? "unreachable" };

    const serverB = resultB.status === "fulfilled"
      ? { ...resultB.value, pingMs: ping?.ms, pingLossPercent: ping?.lossPercent }
      : { error: resultB.reason?.message ?? "unreachable" };

    // Sparkline: last 144 server eth0 aggregate points, downsampled to 24
    const rawSnapshots = queries.getAggregateServerTraffic(144);
    const sparklineRaw = downsample(rawSnapshots, 24);
    const trafficSparkline = sparklineRaw.map((s) => ({
      ts: s.ts,
      rx: s.rx,
      tx: s.tx,
    }));

    const totals24h = queries.getServerTrafficTotals24h();
    const trafficTotal24h = { rx: totals24h.totalRx, tx: totals24h.totalTx };

    return reply.send({
      serverA,
      serverB,
      serverAIp: env.SERVER_A_HOST,
      serverBIp: env.SERVER_B_HOST,
      trafficSparkline,
      trafficTotal24h,
    });
  });

  // GET /api/servers/:id/traffic?period=24h|7d|30d
  app.get<{ Params: { id: string }; Querystring: { period?: string } }>(
    "/api/servers/:id/traffic",
    async (req, reply) => {
      const id = req.params.id as ServerId;
      if (id !== "a" && id !== "b") {
        return reply.status(404).send({ error: "Unknown server id" });
      }

      const period = req.query.period ?? "24h";
      const limit = PERIOD_LIMITS[period] ?? 144;
      const snapshots = queries.getServerTraffic(id, limit);

      const response: ServerTrafficResponse = { serverId: id, snapshots };
      return reply.send(response);
    }
  );

  // GET /api/servers/:id/monthly
  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/monthly",
    async (req, reply) => {
      const id = req.params.id as ServerId;
      if (id !== "a" && id !== "b") {
        return reply.status(404).send({ error: "Unknown server id" });
      }
      const history = queries.getServerMonthlyTraffic(id);
      return reply.send({ serverId: id, history });
    }
  );

  // GET /api/servers/:id/daily — daily aggregated traffic (last 30 days)
  app.get<{ Params: { id: string } }>(
    "/api/servers/:id/daily",
    async (req, reply) => {
      const id = req.params.id as ServerId;
      if (id !== "a" && id !== "b") {
        return reply.status(404).send({ error: "Unknown server id" });
      }
      const history = queries.getServerDailyTraffic(id);
      return reply.send({ serverId: id, history });
    }
  );
}
