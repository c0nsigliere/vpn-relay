"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthWorker = healthWorker;
const ssh_1 = require("../services/ssh");
const env_1 = require("../config/env");
const INTERVAL_MS = 60 * 1000; // 1 minute
const FAILURE_THRESHOLD = 3;
function healthWorker(bot) {
    let consecutiveFailures = 0;
    let alertSent = false;
    const run = async () => {
        try {
            const ok = await ssh_1.sshPool.ping();
            if (ok) {
                if (alertSent && consecutiveFailures >= FAILURE_THRESHOLD) {
                    // Recovery notification
                    await bot.api.sendMessage(env_1.env.ADMIN_ID, "✅ Server A is back online.");
                }
                consecutiveFailures = 0;
                alertSent = false;
            }
            else {
                consecutiveFailures++;
                if (consecutiveFailures >= FAILURE_THRESHOLD && !alertSent) {
                    alertSent = true;
                    await bot.api.sendMessage(env_1.env.ADMIN_ID, `🚨 *Server A unreachable!*\n${consecutiveFailures} consecutive SSH failures. VPN tunnel may be down.`, { parse_mode: "Markdown" });
                }
            }
        }
        catch (err) {
            console.error("[health worker] error:", err);
        }
    };
    const timer = setInterval(run, INTERVAL_MS);
    return { stop: () => clearInterval(timer) };
}
//# sourceMappingURL=health.worker.js.map