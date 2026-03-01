"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trafficWorker = trafficWorker;
const queries_1 = require("../db/queries");
const xray_service_1 = require("../services/xray.service");
const wg_service_1 = require("../services/wg.service");
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
function trafficWorker(bot) {
    const run = async () => {
        try {
            const clients = queries_1.queries.getActiveClients();
            if (clients.length === 0)
                return;
            // Fetch XRay stats (reset=true for delta)
            const xrayStats = await xray_service_1.xrayService.queryAllStats(true);
            // Fetch WG stats
            let wgStats = [];
            try {
                wgStats = await wg_service_1.wgService.getStats();
            }
            catch {
                // Server A unreachable — use zeros
            }
            const wgByPubkey = new Map(wgStats.map((s) => [s.pubkey, s]));
            for (const client of clients) {
                const xray = xrayStats.get(client.name);
                const wg = client.wg_pubkey ? wgByPubkey.get(client.wg_pubkey) : undefined;
                // Compute WG delta vs last snapshot
                const lastSnap = queries_1.queries.getLastTrafficSnapshot(client.id);
                const wgRxDelta = wg ? Math.max(0, wg.rxBytes - (lastSnap?.wg_rx ?? 0)) : 0;
                const wgTxDelta = wg ? Math.max(0, wg.txBytes - (lastSnap?.wg_tx ?? 0)) : 0;
                queries_1.queries.insertTrafficSnapshot({
                    client_id: client.id,
                    wg_rx: wgRxDelta,
                    wg_tx: wgTxDelta,
                    xray_rx: Number(xray?.downlinkBytes ?? 0),
                    xray_tx: Number(xray?.uplinkBytes ?? 0),
                });
            }
        }
        catch (err) {
            console.error("[traffic worker] error:", err);
        }
    };
    const timer = setInterval(run, INTERVAL_MS);
    // Run immediately on start
    run().catch(() => { });
    return { stop: () => clearInterval(timer) };
}
//# sourceMappingURL=traffic.worker.js.map