import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import path from "path";
import { Bot } from "grammy";
import { env } from "../config/env";
import { clientsRoutes } from "./routes/clients";
import { sendConfigRoutes } from "./routes/send-config";
import type { BotContext } from "../bot/context";

export async function buildApiServer(bot: Bot<BotContext>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, {
    // Only allow same-origin or TMA domain in production
    origin: env.TMA_DOMAIN ? `https://${env.TMA_DOMAIN}` : true,
  });

  // Register API routes (pass bot for Telegram notifications)
  await app.register(clientsRoutes, { bot });
  await app.register(sendConfigRoutes, { bot });

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
  console.log(`TMA API listening on http://127.0.0.1:${env.TMA_PORT}`);
  return app;
}
