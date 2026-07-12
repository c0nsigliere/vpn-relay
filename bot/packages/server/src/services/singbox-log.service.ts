/**
 * Parse the sing-box log to extract the last source IP per Hysteria 2 client.
 *
 * Requires `log.level: "info"`. Each connection emits two lines that share a
 * connection id — the source line carries the client IP, the routing line
 * carries the authenticated user (before "@hy2"):
 *
 *   INFO [<id> 0ms] inbound/hysteria2[hy2-in]: inbound connection from <ip>:<port>
 *   INFO [<id> 0ms] inbound/hysteria2[hy2-in]: [<name>@hy2] inbound connection to <dest>
 *
 * We join the two on <id> to map client name → source IP. Hysteria 2 is
 * direct-only, so there is no relay/conntrack correlation (unlike XRay).
 */

import * as fs from "fs";

const SINGBOX_LOG = "/var/log/sing-box/sing-box.log";

// [<id> <dur>] inbound/hysteria2[...]: inbound [packet ]connection from <ip>:<port>
const FROM_RE =
  /\[(\d+)\s+[^\]]+\]\s+inbound\/hysteria2\[[^\]]*\]:\s+inbound (?:packet )?connection from (\[[0-9a-fA-F:]+\]|\d+\.\d+\.\d+\.\d+):\d+/;
// [<id> <dur>] inbound/hysteria2[...]: [<name>@hy2] inbound [packet ]connection to ...
const USER_RE =
  /\[(\d+)\s+[^\]]+\]\s+inbound\/hysteria2\[[^\]]*\]:\s+\[([^\]]+)@hy2\]\s+inbound (?:packet )?connection to/;

class SingboxLogService {
  /**
   * Read the tail of the sing-box log and return clientName → most-recent source IP.
   * Later lines overwrite earlier ones, so the returned IP is the latest seen.
   */
  getRecentClientIps(): Map<string, string> {
    const result = new Map<string, string>();

    let content: string;
    try {
      content = fs.readFileSync(SINGBOX_LOG, "utf8");
    } catch {
      return result;
    }

    const tail = content.split("\n").slice(-5000);
    const connIp = new Map<string, string>(); // connId → source IP

    for (const line of tail) {
      const f = line.match(FROM_RE);
      if (f) {
        // Strip [] from IPv6 literals so the value matches XRay's plain-IP form.
        connIp.set(f[1], f[2].replace(/^\[|\]$/g, ""));
        continue;
      }
      const u = line.match(USER_RE);
      if (u) {
        const ip = connIp.get(u[1]);
        if (ip) result.set(u[2], ip);
      }
    }

    return result;
  }
}

export const singboxLogService = new SingboxLogService();
