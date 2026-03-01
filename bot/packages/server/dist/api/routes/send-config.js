"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendConfigRoutes = sendConfigRoutes;
const queries_1 = require("../../db/queries");
const client_service_1 = require("../../services/client.service");
const tma_auth_1 = require("../middleware/tma-auth");
const env_1 = require("../../config/env");
async function sendConfigRoutes(app, opts) {
    const bot = opts.bot;
    app.addHook("preHandler", tma_auth_1.tmaAuthMiddleware);
    // POST /api/clients/:id/send-config — send config/QR to admin Telegram chat
    app.post("/api/clients/:id/send-config", async (req, reply) => {
        const client = queries_1.queries.getClientById(req.params.id);
        if (!client)
            return reply.code(404).send({ error: "Client not found" });
        try {
            await (0, client_service_1.sendConfigToChat)(bot, env_1.env.ADMIN_ID, client);
            return reply.send({ ok: true });
        }
        catch (err) {
            return reply.code(500).send({ error: err.message });
        }
    });
}
//# sourceMappingURL=send-config.js.map