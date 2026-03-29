import { FastifyInstance } from "fastify";
import { metricsCache } from "../../services/metrics.cache";
import { getPing } from "../../services/ping.store";
import { queries } from "../../db/queries";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import { env } from "../../config/env";
import { isStandalone } from "../../config/standalone";
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
      isStandalone ? Promise.reject("standalone") : metricsCache.getStatusA(),
      metricsCache.getStatusB(),
    ]);

    const ping = getPing();

    const serverA = isStandalone
      ? null
      : resultA.status === "fulfilled"
        ? { ...resultA.value, pingMs: ping?.ms, pingLossPercent: ping?.lossPercent }
        : { error: resultA.reason?.message ?? "unreachable" };

    const serverB = resultB.status === "fulfilled"
      ? { ...resultB.value, pingMs: ping?.ms, pingLossPercent: ping?.lossPercent }
      : { error: resultB.reason?.message ?? "unreachable" };

    // Per-server sparklines: last 144 points downsampled to 24
    const rawB = queries.getServerTrafficSparkline("b", 144);
    const trafficSparklineB = downsample(rawB, 24).map((s) => ({ ts: s.ts, rx: s.rx, tx: s.tx }));
    const totals24hB = queries.getServerTrafficTotals24hById("b");

    const response: Record<string, unknown> = {
      serverA,
      serverB,
      serverAIp: isStandalone ? null : env.SERVER_A_HOST || null,
      serverBIp: env.SERVER_B_HOST,
      serverACountry: isStandalone ? null : env.SERVER_A_COUNTRY || null,
      serverBCountry: env.SERVER_B_COUNTRY || undefined,
      trafficSparklineB,
      trafficTotal24hB: { rx: totals24hB.totalRx, tx: totals24hB.totalTx },
      standalone: isStandalone,
    };

    if (!isStandalone) {
      const rawA = queries.getServerTrafficSparkline("a", 144);
      response.trafficSparklineA = downsample(rawA, 24).map((s) => ({ ts: s.ts, rx: s.rx, tx: s.tx }));
      const totals24hA = queries.getServerTrafficTotals24hById("a");
      response.trafficTotal24hA = { rx: totals24hA.totalRx, tx: totals24hA.totalTx };
    }

    return reply.send(response);
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
