/**
 * Parse the sing-box log to extract the last source IP per Hysteria 2 client.
 *
 * Requires `log.level: "info"`. Each connection emits two lines that share a
 * connection id — the source line carries the client IP + port, the routing
 * line carries the authenticated user (before "@hy2"):
 *
 *   INFO [<id> 0ms] inbound/hysteria2[hy2-in]: inbound connection from <ip>:<port>
 *   INFO [<id> 0ms] inbound/hysteria2[hy2-in]: [<name>@hy2] inbound connection to <dest>
 *
 * We join the two on <id>. Mirrors xray-log.service: connections whose source
 * IP is Server A are relay (phase 4) — we keep the masqueraded source port for
 * UDP conntrack correlation on A; everything else is a direct connection with a
 * real client IP.
 */

import * as fs from "fs";
import { env } from "../config/env";
import { isStandalone } from "../config/standalone";

const SINGBOX_LOG = "/var/log/sing-box/sing-box.log";

// [<id> <dur>] inbound/hysteria2[...]: inbound [packet ]connection from <ip>:<port>
const FROM_RE =
  /\[(\d+)\s+[^\]]+\]\s+inbound\/hysteria2\[[^\]]*\]:\s+inbound (?:packet )?connection from (\[[0-9a-fA-F:]+\]|\d+\.\d+\.\d+\.\d+):(\d+)/;
// [<id> <dur>] inbound/hysteria2[...]: [<name>@hy2] inbound [packet ]connection to ...
const USER_RE =
  /\[(\d+)\s+[^\]]+\]\s+inbound\/hysteria2\[[^\]]*\]:\s+\[([^\]]+)@hy2\]\s+inbound (?:packet )?connection to/;

export interface SingboxLogResult {
  /** clientName → real IP (direct connections, not from Server A) */
  directIps: Map<string, string>;
  /** clientName → masqueraded source port (connections from Server A relay) */
  relayPorts: Map<string, number>;
}

class SingboxLogService {
  /**
   * Read the tail of the sing-box log and split clients into direct (real IP)
   * and relay (masqueraded source port). Later lines overwrite earlier ones,
   * so the classification reflects the most recent connection per client.
   */
  getRecentClientIps(): SingboxLogResult {
    const directIps = new Map<string, string>();
    const relayPorts = new Map<string, number>();

    let content: string;
    try {
      content = fs.readFileSync(SINGBOX_LOG, "utf8");
    } catch {
      return { directIps, relayPorts };
    }

    const tail = content.split("\n").slice(-5000);
    const serverAIp = isStandalone ? null : env.SERVER_A_HOST;

    // connId → { ip, port }, joined with the user line that follows.
    const connSrc = new Map<string, { ip: string; port: number }>();
    // Track the last entry per client (later lines = more recent connection mode).
    const lastEntry = new Map<string, { ip: string; port: number }>();

    for (const line of tail) {
      const f = line.match(FROM_RE);
      if (f) {
        // Strip [] from IPv6 literals so the value matches XRay's plain-IP form.
        connSrc.set(f[1], { ip: f[2].replace(/^\[|\]$/g, ""), port: parseInt(f[3], 10) });
        continue;
      }
      const u = line.match(USER_RE);
      if (u) {
        const name = u[2];
        // Skip the WG-over-Hy2 cascade uplink user (not a real client).
        if (name === "wg-clients") continue;
        const src = connSrc.get(u[1]);
        if (src) lastEntry.set(name, src);
      }
    }

    for (const [name, entry] of lastEntry) {
      const isRelay = serverAIp ? entry.ip === serverAIp : false;
      if (isRelay) relayPorts.set(name, entry.port);
      else directIps.set(name, entry.ip);
    }

    return { directIps, relayPorts };
  }
}

export const singboxLogService = new SingboxLogService();
