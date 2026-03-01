import { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import { queries } from "../../db/queries";
import { sendConfigToChat } from "../../services/client.service";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import { env } from "../../config/env";
import type { BotContext } from "../../bot/context";

export async function sendConfigRoutes(
  app: FastifyInstance,
  opts: { bot: Bot<BotContext> }
): Promise<void> {
  const bot = opts.bot;
  app.addHook("preHandler", tmaAuthMiddleware);

  // POST /api/clients/:id/send-config — send config/QR to admin Telegram chat
  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/send-config",
    async (req, reply) => {
      const client = queries.getClientById(req.params.id);
      if (!client) return reply.code(404).send({ error: "Client not found" });

      try {
        await sendConfigToChat(bot, env.ADMIN_ID, client);
        return reply.send({ ok: true });
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
    }
  );
}
