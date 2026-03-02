import { FastifyInstance } from "fastify";
import { queries } from "../../db/queries";
import { tmaAuthMiddleware } from "../middleware/tma-auth";

export async function trafficRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/clients/:id/traffic?limit=144
  app.get<{ Params: { id: string } }>("/api/clients/:id/traffic", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    const q = req.query as Record<string, string>;
    const limit = Math.min(Math.max(1, parseInt(q.limit ?? "144", 10)), 2016);

    // Return oldest-first for charting
    const snapshots = queries.getTrafficHistory(req.params.id, limit).reverse();
    return reply.send({ clientName: client.name, snapshots });
  });

  // GET /api/clients/:id/monthly
  app.get<{ Params: { id: string } }>("/api/clients/:id/monthly", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    const history = queries.getClientMonthlyTraffic(req.params.id);
    return reply.send({ clientName: client.name, history });
  });
}
