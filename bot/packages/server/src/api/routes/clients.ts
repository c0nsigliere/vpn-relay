import { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import { queries } from "../../db/queries";
import {
  createClient,
  suspendClient,
  resumeClient,
  deleteClient,
  sendConfigToChat,
} from "../../services/client.service";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import { env } from "../../config/env";
import type { ClientType, ClientWithTraffic } from "@vpn-relay/shared";
import type { BotContext } from "../../bot/context";

export async function clientsRoutes(
  app: FastifyInstance,
  opts: { bot: Bot<BotContext> }
): Promise<void> {
  const bot = opts.bot;

  // All routes require TMA auth
  app.addHook("preHandler", tmaAuthMiddleware);

  // GET /api/clients?search=&filter=active|suspended|all&type=wg|xray|both|all&page=0
  app.get("/api/clients", async (req, reply) => {
    const q = req.query as Record<string, string>;
    const search = (q.search ?? "").trim();
    const filter = (["all", "active", "suspended"].includes(q.filter) ? q.filter : "all") as
      "all" | "active" | "suspended";
    const type = (["all", "wg", "xray", "both"].includes(q.type) ? q.type : "all") as
      "all" | "wg" | "xray" | "both";
    const page = Math.max(0, parseInt(q.page ?? "0", 10));
    const pageSize = 20;

    const { clients, total } = queries.searchClients(search, filter, type, page, pageSize);

    if (q.withTraffic === "1") {
      const ids = clients.map((c) => c.id);
      const totalsMap = queries.getTrafficTotalsForClients(ids);
      const enriched: ClientWithTraffic[] = clients.map((c) => ({
        ...c,
        traffic: totalsMap.get(c.id),
      }));
      return reply.send({ clients: enriched, total, page, pageSize });
    }

    return reply.send({ clients, total, page, pageSize });
  });

  // GET /api/clients/:id
  app.get<{ Params: { id: string } }>("/api/clients/:id", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });
    return reply.send(client);
  });

  // POST /api/clients — create client; also sends config to Telegram chat
  app.post("/api/clients", async (req, reply) => {
    const body = req.body as { name?: string; type?: string; ttlDays?: number };
    const { name, type, ttlDays } = body;

    if (!name || !/^[a-zA-Z0-9_]{1,32}$/.test(name)) {
      return reply.code(400).send({ error: "Invalid name. Use letters, digits, underscores (max 32)." });
    }
    if (!["wg", "xray", "both"].includes(type ?? "")) {
      return reply.code(400).send({ error: "Invalid type. Must be wg, xray, or both." });
    }
    if (queries.getClientByName(name)) {
      return reply.code(409).send({ error: "A client with that name already exists." });
    }

    try {
      const result = await createClient(name, type as ClientType, ttlDays);
      // Killer feature: send config + QR to admin Telegram chat, then Web App can close
      await sendConfigToChat(bot, env.ADMIN_ID, result.client, result.wgConf);
      return reply.code(201).send({
        client: result.client,
        xrayUris: result.xrayUris,
      });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // PATCH /api/clients/:id — suspend or resume
  app.patch<{ Params: { id: string } }>("/api/clients/:id", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    const body = req.body as { action?: string };
    try {
      if (body.action === "suspend") {
        await suspendClient(client);
      } else if (body.action === "resume") {
        await resumeClient(client);
      } else {
        return reply.code(400).send({ error: "action must be suspend or resume" });
      }
      const updated = queries.getClientById(req.params.id)!;
      return reply.send(updated);
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // DELETE /api/clients/:id
  app.delete<{ Params: { id: string } }>("/api/clients/:id", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    try {
      await deleteClient(client);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}
