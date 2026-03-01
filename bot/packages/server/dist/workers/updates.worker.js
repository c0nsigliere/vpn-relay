"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.updatesWorker = updatesWorker;
const system_service_1 = require("../services/system.service");
const env_1 = require("../config/env");
const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
function updatesWorker(bot) {
    const run = async () => {
        try {
            const [statusA, statusB] = await Promise.allSettled([
                system_service_1.systemService.getStatusA(),
                system_service_1.systemService.getStatusB(),
            ]);
            const alerts = [];
            if (statusA.status === "fulfilled") {
                const a = statusA.value;
                if (a.updatesAvailable > 0) {
                    alerts.push(`⚠️ *Server A*: ${a.updatesAvailable} security updates pending.`);
                }
                if (a.rebootRequired) {
                    alerts.push("🔄 *Server A*: Reboot required.");
                }
            }
            if (statusB.status === "fulfilled") {
                const b = statusB.value;
                if (b.updatesAvailable > 0) {
                    alerts.push(`⚠️ *Server B*: ${b.updatesAvailable} security updates pending.`);
                }
                if (b.rebootRequired) {
                    alerts.push("🔄 *Server B*: Reboot required.");
                }
            }
            if (alerts.length > 0) {
                await bot.api.sendMessage(env_1.env.ADMIN_ID, alerts.join("\n"), { parse_mode: "Markdown" });
            }
        }
        catch (err) {
            console.error("[updates worker] error:", err);
        }
    };
    const timer = setInterval(run, INTERVAL_MS);
    // Run after 60s on startup to avoid false alerts during init
    const initTimer = setTimeout(() => run().catch(() => { }), 60_000);
    return {
        stop: () => {
            clearInterval(timer);
            clearTimeout(initTimer);
        },
    };
}
//# sourceMappingURL=updates.worker.js.map