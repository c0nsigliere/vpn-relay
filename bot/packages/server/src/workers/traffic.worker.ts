import * as fs from "fs";
import { Bot } from "grammy";
import { BotContext } from "../bot/context";
import { queries } from "../db/queries";
import { xrayService } from "../services/xray.service";
import { wgService } from "../services/wg.service";
import { sshPool } from "../services/ssh";
import { xrayLogService } from "../services/xray-log.service";
import { ipInfoService } from "../services/ip-info.service";
import { env } from "../config/env";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** Last raw eth0 counter readings per server (for delta computation) */
const lastEth0: Map<"a" | "b", { rx: number; tx: number }> = new Map();

/** Last cumulative WG counter readings per peer pubkey (for delta computation) */
const lastWg: Map<string, { rx: number; tx: number }> = new Map();

/** Detect first non-loopback interface on Server B (local) */
function detectLocalInterface(): string {
  try {
    const ifaces = fs.readdirSync("/sys/class/net").filter((i) => i !== "lo");
    return ifaces.includes("eth0") ? "eth0" : (ifaces[0] ?? "eth0");
  } catch {
    return "eth0";
  }
}

/**
 * Query conntrack on Server A to build a map of masqueraded port → real client IP.
 *
 * Conntrack line format:
 *   tcp 6 300 ESTABLISHED src=5.18.217.45 dst=195.133.31.93 sport=51234 dport=443 src=104.248.240.45 dst=195.133.31.93 sport=443 dport=60123 [ASSURED]
 *
 * First src= is the real client IP; last dport= (before [ASSURED]) is the masqueraded
 * source port that Server B sees in its XRay access log.
 */
const CONNTRACK_RE = /^tcp\s+\d+\s+\d+\s+\S+\s+src=(\d+\.\d+\.\d+\.\d+)\s+.*\sdport=(\d+)\s*(?:\[|$)/;

async function getRelayRealIps(): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  try {
    const serverBIp = env.SERVER_B_HOST;
    // Pre-filter on Server A to minimize data transfer.
    // Server B IP appears as reply src= (not dst=) in conntrack, so grep for IP anywhere.
    // Trailing `|| true` prevents grep exit code 1 (no matches) from failing SSH.
    const out = await sshPool.exec(
      `conntrack -L -p tcp --dst-nat 2>/dev/null | grep '${serverBIp}' || true`
    );
    for (const line of out.split("\n")) {
      const m = line.match(CONNTRACK_RE);
      if (!m) continue;
      const realIp = m[1];
      const masqPort = parseInt(m[2], 10);
      // Multiple entries may exist; later ones overwrite (fine — any valid mapping works)
      result.set(masqPort, realIp);
    }
  } catch {
    // Server A unreachable or conntrack not installed — silently skip
  }
  return result;
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

          let wgRxDelta = 0, wgTxDelta = 0;
          if (wg) {
            const prev = lastWg.get(wg.pubkey);
            if (prev !== undefined && wg.rxBytes >= prev.rx && wg.txBytes >= prev.tx) {
              wgRxDelta = wg.rxBytes - prev.rx;
              wgTxDelta = wg.txBytes - prev.tx;
            }
            lastWg.set(wg.pubkey, { rx: wg.rxBytes, tx: wg.txBytes });
          }

          const xrayRx = Number(xray?.downlinkBytes ?? 0);
          const xrayTx = Number(xray?.uplinkBytes ?? 0);

          // Convention: rx = client download, tx = client upload.
          // WireGuard server counters are inverted: server rx = client upload, server tx = client download.
          // XRay counters already match: downlinkBytes = client download, uplinkBytes = client upload.
          queries.insertTrafficSnapshot({
            client_id: client.id,
            wg_rx: wgTxDelta,  // server tx = data sent to client = client download
            wg_tx: wgRxDelta,  // server rx = data received from client = client upload
            xray_rx: xrayRx,
            xray_tx: xrayTx,
          });

          // Update last_seen_at if there's any traffic or recent WG handshake
          if (wgRxDelta > 0 || wgTxDelta > 0 || xrayRx > 0 || xrayTx > 0) {
            queries.updateLastSeen(client.id);
          } else if (wg && wg.latestHandshake > 0) {
            const handshakeAge = Date.now() / 1000 - wg.latestHandshake;
            if (handshakeAge < 900) { // 15 minutes
              queries.updateLastSeen(client.id);
            }
          }
        }

      // ── Collect client IPs ──────────────────────────────────────────────
        try {
          // XRay access log: direct IPs + relay masqueraded ports
          const { directIps, relayPorts } = xrayLogService.getRecentClientIps();

          // If any clients connected via relay, resolve real IPs via conntrack on Server A
          let conntrackMap = new Map<number, string>();
          if (relayPorts.size > 0) {
            conntrackMap = await getRelayRealIps();
          }

          // Determine current IP per client
          // Priority: WG endpoint > XRay direct IP > XRay relay (conntrack-resolved)
          const ipUpdates: Array<{ id: string; ip: string }> = [];

          for (const client of clients) {
            let ip: string | undefined;

            // WG endpoint (always real client IP)
            if (client.wg_pubkey) {
              const wg = wgByPubkey.get(client.wg_pubkey);
              if (wg?.endpoint) {
                const colonIdx = wg.endpoint.lastIndexOf(":");
                if (colonIdx > 0) ip = wg.endpoint.slice(0, colonIdx);
              }
            }

            // XRay direct IP (fallback)
            if (!ip && (client.type === "xray" || client.type === "both")) {
              ip = directIps.get(client.name);
            }

            // XRay relay — resolve via conntrack correlation
            if (!ip && (client.type === "xray" || client.type === "both")) {
              const masqPort = relayPorts.get(client.name);
              if (masqPort !== undefined) {
                ip = conntrackMap.get(masqPort);
              }
            }

            if (ip && ip !== client.last_ip) {
              ipUpdates.push({ id: client.id, ip });
            }
          }

          if (ipUpdates.length > 0) {
            const ispMap = await ipInfoService.lookupBatch(ipUpdates.map((u) => u.ip));
            for (const { id, ip } of ipUpdates) {
              queries.updateClientIp(id, ip, ispMap.get(ip) ?? null);
            }
          }
        } catch (err) {
          console.error("[traffic worker] IP collection error:", err);
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
