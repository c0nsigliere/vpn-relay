import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { xrayService } from "../services/xray.service";
import { wgService } from "../services/wg.service";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export function trafficWorker(bot: Bot<BotContext>): { stop: () => void } {
  const run = async () => {
    try {
      const clients = queries.getActiveClients();
      if (clients.length === 0) return;

      // Fetch XRay stats (reset=true for delta)
      const xrayStats = await xrayService.queryAllStats(true);

      // Fetch WG stats
      let wgStats: Awaited<ReturnType<typeof wgService.getStats>> = [];
      try {
        wgStats = await wgService.getStats();
      } catch {
        // Server A unreachable — use zeros
      }

      const wgByPubkey = new Map(wgStats.map((s) => [s.pubkey, s]));

      for (const client of clients) {
        const xray = xrayStats.get(client.name);
        const wg = client.wg_pubkey ? wgByPubkey.get(client.wg_pubkey) : undefined;

        // Compute WG delta vs last snapshot
        const lastSnap = queries.getLastTrafficSnapshot(client.id);
        const wgRxDelta = wg ? Math.max(0, wg.rxBytes - (lastSnap?.wg_rx ?? 0)) : 0;
        const wgTxDelta = wg ? Math.max(0, wg.txBytes - (lastSnap?.wg_tx ?? 0)) : 0;

        queries.insertTrafficSnapshot({
          client_id: client.id,
          wg_rx: wgRxDelta,
          wg_tx: wgTxDelta,
          xray_rx: Number(xray?.downlinkBytes ?? 0),
          xray_tx: Number(xray?.uplinkBytes ?? 0),
        });
      }
    } catch (err) {
      console.error("[traffic worker] error:", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Run immediately on start
  run().catch(() => {});

  return { stop: () => clearInterval(timer) };
}
