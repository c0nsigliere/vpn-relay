import * as fs from "fs";
import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { xrayService } from "../services/xray.service";
import { wgService } from "../services/wg.service";
import { sshPool } from "../services/ssh";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Last raw eth0 counter readings per server (for delta computation) */
const lastEth0: Map<"a" | "b", { rx: number; tx: number }> = new Map();

/** Detect first non-loopback interface on Server B (local) */
function detectLocalInterface(): string {
  try {
    const ifaces = fs.readdirSync("/sys/class/net").filter((i) => i !== "lo");
    return ifaces.includes("eth0") ? "eth0" : (ifaces[0] ?? "eth0");
  } catch {
    return "eth0";
  }
}

async function collectServerEth0(): Promise<void> {
  // Server B (local — this process runs on B)
  try {
    const iface = detectLocalInterface();
    const rx = parseInt(fs.readFileSync(`/sys/class/net/${iface}/statistics/rx_bytes`, "utf8").trim(), 10);
    const tx = parseInt(fs.readFileSync(`/sys/class/net/${iface}/statistics/tx_bytes`, "utf8").trim(), 10);
    const prev = lastEth0.get("b");
    if (prev !== undefined && rx >= prev.rx && tx >= prev.tx) {
      queries.insertServerTrafficSnapshot("b", rx - prev.rx, tx - prev.tx);
    }
    lastEth0.set("b", { rx, tx });
  } catch {
    // ignore — iface may not exist in dev
  }

  // Server A (remote — SSH)
  try {
    const out = await sshPool.exec(
      "IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -1); cat /sys/class/net/$IFACE/statistics/rx_bytes /sys/class/net/$IFACE/statistics/tx_bytes"
    );
    const lines = out.trim().split("\n");
    const rx = parseInt(lines[0], 10);
    const tx = parseInt(lines[1], 10);
    if (!isNaN(rx) && !isNaN(tx)) {
      const prev = lastEth0.get("a");
      if (prev !== undefined && rx >= prev.rx && tx >= prev.tx) {
        queries.insertServerTrafficSnapshot("a", rx - prev.rx, tx - prev.tx);
      }
      lastEth0.set("a", { rx, tx });
    }
  } catch {
    // Server A unreachable
  }
}

export function trafficWorker(bot: Bot<BotContext>): { stop: () => void } {
  const run = async () => {
    try {
      const clients = queries.getActiveClients();

      if (clients.length > 0) {
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
      }

      // Always collect server eth0 counters (independent of client count)
      await collectServerEth0();
    } catch (err) {
      console.error("[traffic worker] error:", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  run().catch(() => {});

  return { stop: () => clearInterval(timer) };
}
