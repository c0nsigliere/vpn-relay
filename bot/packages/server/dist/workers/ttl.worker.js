"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ttlWorker = ttlWorker;
const queries_1 = require("../db/queries");
const xray_service_1 = require("../services/xray.service");
const wg_service_1 = require("../services/wg.service");
const env_1 = require("../config/env");
const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
function ttlWorker(bot) {
    const run = async () => {
        try {
            const expired = queries_1.queries.getExpiredClients();
            for (const client of expired) {
                try {
                    if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
                        await wg_service_1.wgService.suspendClient(client.wg_pubkey);
                    }
                    if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
                        await xray_service_1.xrayService.removeClient(client.name, client.xray_uuid);
                    }
                    queries_1.queries.setClientActive(client.id, false);
                    await bot.api.sendMessage(env_1.env.ADMIN_ID, `⏰ Client *${client.name}* expired and has been suspended.`, { parse_mode: "Markdown" });
                }
                catch (err) {
                    console.error(`[ttl worker] failed to suspend ${client.name}:`, err);
                }
            }
        }
        catch (err) {
            console.error("[ttl worker] error:", err);
        }
    };
    const timer = setInterval(run, INTERVAL_MS);
    run().catch(() => { });
    return { stop: () => clearInterval(timer) };
}
//# sourceMappingURL=ttl.worker.js.map