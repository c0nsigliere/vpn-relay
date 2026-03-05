/**
 * Parse XRay access log on Server B (local) to extract last client IP per email tag.
 *
 * XRay access log format (one line per connection):
 *   2026/03/05 12:34:56 1.2.3.4:54321 accepted tcp:example.com:443 [vless-in >> direct] email: clientname@xray
 *
 * We extract the source IP + port and map it to the client name (before @xray).
 *
 * Two categories:
 *   - directIps:  real client IPs (non-relay connections)
 *   - relayPorts: masqueraded source port from Server A (relay DNAT connections)
 *     These ports can be correlated with conntrack on Server A to recover the real client IP.
 */

import * as fs from "fs";
import { env } from "../config/env";

const ACCESS_LOG = "/var/log/xray/access.log";

// Match: <timestamp> <IP>:<port> accepted ... email: <name>@xray
const LINE_RE = /(\d+\.\d+\.\d+\.\d+):(\d+)\s+accepted\s+.+email:\s*(\S+)@xray/;

export interface XrayLogResult {
  /** clientName → real IP (direct connections, not from Server A) */
  directIps: Map<string, string>;
  /** clientName → masqueraded source port (connections from Server A relay) */
  relayPorts: Map<string, number>;
}

class XrayLogService {
  /**
   * Read last N lines from access log and extract per-client info.
   *
   * For direct connections: returns the real client IP.
   * For relay connections (from Server A): returns the masqueraded source port,
   * which can be correlated with conntrack on Server A to find the real IP.
   *
   * Later lines (more recent) overwrite earlier ones — newer connections have
   * the best chance of still being present in Server A's conntrack table.
   */
  getRecentClientIps(): XrayLogResult {
    const directIps = new Map<string, string>();
    const relayPorts = new Map<string, number>();

    let content: string;
    try {
      content = fs.readFileSync(ACCESS_LOG, "utf8");
    } catch {
      return { directIps, relayPorts };
    }

    const lines = content.split("\n");
    const tail = lines.slice(-5000);

    const serverAIp = env.SERVER_A_HOST;

    for (const line of tail) {
      const m = line.match(LINE_RE);
      if (!m) continue;

      const [, ip, port, name] = m;

      // Skip WG cascade uplink (not a real client)
      if (name === "wg-clients") continue;

      if (ip === serverAIp) {
        // Relay connection — save masqueraded source port for conntrack correlation
        relayPorts.set(name, parseInt(port, 10));
      } else {
        // Direct connection — real client IP
        directIps.set(name, ip);
      }
    }

    return { directIps, relayPorts };
  }
}

export const xrayLogService = new XrayLogService();
