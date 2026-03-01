"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApiServer = buildApiServer;
exports.startApiServer = startApiServer;
const fastify_1 = __importDefault(require("fastify"));
const static_1 = __importDefault(require("@fastify/static"));
const cors_1 = __importDefault(require("@fastify/cors"));
const path_1 = __importDefault(require("path"));
const env_1 = require("../config/env");
const clients_1 = require("./routes/clients");
const send_config_1 = require("./routes/send-config");
async function buildApiServer(bot) {
    const app = (0, fastify_1.default)({ logger: false });
    await app.register(cors_1.default, {
        // Only allow same-origin or TMA domain in production
        origin: env_1.env.TMA_DOMAIN ? `https://${env_1.env.TMA_DOMAIN}` : true,
    });
    // Register API routes (pass bot for Telegram notifications)
    await app.register(clients_1.clientsRoutes, { bot });
    await app.register(send_config_1.sendConfigRoutes, { bot });
    // Serve static React SPA from packages/web/dist
    const webDist = path_1.default.resolve(__dirname, "../../../web/dist");
    await app.register(static_1.default, {
        root: webDist,
        prefix: "/",
    });
    // SPA fallback: serve index.html for non-API routes
    app.setNotFoundHandler(async (_req, reply) => {
        return reply.sendFile("index.html");
    });
    return app;
}
async function startApiServer(bot) {
    const app = await buildApiServer(bot);
    await app.listen({ port: env_1.env.TMA_PORT, host: "127.0.0.1" });
    console.log(`TMA API listening on http://127.0.0.1:${env_1.env.TMA_PORT}`);
    return app;
}
//# sourceMappingURL=server.js.map