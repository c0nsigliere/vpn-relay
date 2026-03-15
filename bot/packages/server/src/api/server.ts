import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import path from "path";
import { Bot } from "grammy";
import { env } from "../config/env";
import { createLogger } from "../utils/logger";

const logger = createLogger("api");
import { clientsRoutes } from "./routes/clients";
import { sendConfigRoutes } from "./routes/send-config";
import { serversRoutes } from "./routes/servers";
import { trafficRoutes } from "./routes/traffic";
import { settingsRoutes } from "./routes/settings";
import { alertsRoutes } from "./routes/alerts";
import type { BotContext } from "../bot/context";

export async function buildApiServer(bot: Bot<BotContext>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, {
    // Only allow same-origin or TMA domain in production
    origin: env.TMA_URL ?? true,
  });

  // Register API routes (pass bot for Telegram notifications)
  await app.register(clientsRoutes, { bot });
  await app.register(sendConfigRoutes, { bot });
  await app.register(serversRoutes);
  await app.register(trafficRoutes);
  await app.register(settingsRoutes);
  await app.register(alertsRoutes);

  // Serve static React SPA from packages/web/dist
  const webDist = path.resolve(__dirname, "../../../web/dist");
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
  });

  // SPA fallback: serve index.html for non-API routes
  app.setNotFoundHandler(async (_req, reply) => {
    return reply.sendFile("index.html");
  });

  return app;
}

export async function startApiServer(bot: Bot<BotContext>): Promise<FastifyInstance> {
  const app = await buildApiServer(bot);
  await app.listen({ port: env.TMA_PORT, host: "127.0.0.1" });
  logger.info(`Listening on http://127.0.0.1:${env.TMA_PORT}`);
  return app;
}
