"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clientsRoutes = clientsRoutes;
const queries_1 = require("../../db/queries");
const client_service_1 = require("../../services/client.service");
const tma_auth_1 = require("../middleware/tma-auth");
const env_1 = require("../../config/env");
async function clientsRoutes(app, opts) {
    const bot = opts.bot;
    // All routes require TMA auth
    app.addHook("preHandler", tma_auth_1.tmaAuthMiddleware);
    // GET /api/clients?search=&filter=active|suspended|all&type=wg|xray|both|all&page=0
    app.get("/api/clients", async (req, reply) => {
        const q = req.query;
        const search = (q.search ?? "").trim();
        const filter = (["all", "active", "suspended"].includes(q.filter) ? q.filter : "all");
        const type = (["all", "wg", "xray", "both"].includes(q.type) ? q.type : "all");
        const page = Math.max(0, parseInt(q.page ?? "0", 10));
        const pageSize = 20;
        const { clients, total } = queries_1.queries.searchClients(search, filter, type, page, pageSize);
        return reply.send({ clients, total, page, pageSize });
    });
    // GET /api/clients/:id
    app.get("/api/clients/:id", async (req, reply) => {
        const client = queries_1.queries.getClientById(req.params.id);
        if (!client)
            return reply.code(404).send({ error: "Client not found" });
        return reply.send(client);
    });
    // POST /api/clients — create client; also sends config to Telegram chat
    app.post("/api/clients", async (req, reply) => {
        const body = req.body;
        const { name, type, ttlDays } = body;
        if (!name || !/^[a-zA-Z0-9_]{1,32}$/.test(name)) {
            return reply.code(400).send({ error: "Invalid name. Use letters, digits, underscores (max 32)." });
        }
        if (!["wg", "xray", "both"].includes(type ?? "")) {
            return reply.code(400).send({ error: "Invalid type. Must be wg, xray, or both." });
        }
        if (queries_1.queries.getClientByName(name)) {
            return reply.code(409).send({ error: "A client with that name already exists." });
        }
        try {
            const result = await (0, client_service_1.createClient)(name, type, ttlDays);
            // Killer feature: send config + QR to admin Telegram chat, then Web App can close
            await (0, client_service_1.sendConfigToChat)(bot, env_1.env.ADMIN_ID, result.client, result.wgConf);
            return reply.code(201).send({
                client: result.client,
                xrayUris: result.xrayUris,
            });
        }
        catch (err) {
            return reply.code(500).send({ error: err.message });
        }
    });
    // PATCH /api/clients/:id — suspend or resume
    app.patch("/api/clients/:id", async (req, reply) => {
        const client = queries_1.queries.getClientById(req.params.id);
        if (!client)
            return reply.code(404).send({ error: "Client not found" });
        const body = req.body;
        try {
            if (body.action === "suspend") {
                await (0, client_service_1.suspendClient)(client);
            }
            else if (body.action === "resume") {
                await (0, client_service_1.resumeClient)(client);
            }
            else {
                return reply.code(400).send({ error: "action must be suspend or resume" });
            }
            const updated = queries_1.queries.getClientById(req.params.id);
            return reply.send(updated);
        }
        catch (err) {
            return reply.code(500).send({ error: err.message });
        }
    });
    // DELETE /api/clients/:id
    app.delete("/api/clients/:id", async (req, reply) => {
        const client = queries_1.queries.getClientById(req.params.id);
        if (!client)
            return reply.code(404).send({ error: "Client not found" });
        try {
            await (0, client_service_1.deleteClient)(client);
            return reply.code(204).send();
        }
        catch (err) {
            return reply.code(500).send({ error: err.message });
        }
    });
}
//# sourceMappingURL=clients.js.map