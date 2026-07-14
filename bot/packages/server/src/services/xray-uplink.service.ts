/**
 * Manage Server A's XRay routing over SSH (cascade uplink transport per client).
 *
 * A single XRay instance on Server A carries every WG client's TPROXY'd traffic.
 * Which A→B uplink tunnel it takes is a per-client choice (`wg_cascade_transport`):
 *   - "xray" → outbound `proxy-out` (VLESS+Reality, the default)
 *   - "hy2"  → outbound `hy2-uplink` (SOCKS → local sing-box → Hysteria 2 to B)
 *
 * XRay routes by SOURCE IP: TPROXY preserves each WG client's tunnel IP
 * (10.66.0.x), so a `source: [ip/32] → hy2-uplink` rule selects the transport.
 *
 * This service rewrites ONLY the `routing.rules` array of A's /etc/xray/config.json;
 * the outbounds (which hold the Reality pubkey and uplink UUID, written by Ansible)
 * are never touched. Rules are rebuilt deterministically from the DB and A's XRay
 * is restarted. Called on WG client create/edit-transport/delete and on startup.
 *
 * Rules are active-agnostic: a suspended client keeps its rule (its WG peer is
 * removed, so the rule matches no traffic), which is why suspend/resume needs no
 * A restart — avoiding restart storms from the quota/alert auto-suspend workers.
 */

import { sshPool } from "./ssh";
import { env } from "../config/env";
import { isStandalone } from "../config/standalone";
import { queries } from "../db/queries";
import { createLogger } from "../utils/logger";

const logger = createLogger("xray-uplink");

const CONFIG_PATH = "/etc/xray/config.json";
const WG_INBOUND_TAG = "tproxy-wg-clients";

class XrayUplinkService {
  /**
   * Rebuild Server A's XRay routing.rules from DB and restart A's XRay if changed.
   * No-op in standalone. Errors are swallowed (logged) so client mutations and
   * bot startup never crash on an unreachable Server A.
   */
  async syncRoutingAndRestart(): Promise<void> {
    if (isStandalone) return;
    try {
      const raw = await sshPool.exec(`cat ${CONFIG_PATH}`);
      const config = JSON.parse(raw);

      const hasHy2Uplink =
        Array.isArray(config.outbounds) &&
        config.outbounds.some((o: { tag?: string }) => o.tag === "hy2-uplink");

      const hy2Clients = queries.getWgHy2RouteClients();

      // Rule order matters: loop-breaker first, then per-client Hy2, then default.
      const rules: unknown[] = [
        // Prevent an uplink loop: XRay's own connections to Server B go direct.
        { type: "field", ip: [env.SERVER_B_HOST], outboundTag: "direct" },
      ];

      if (hasHy2Uplink) {
        for (const c of hy2Clients) {
          rules.push({
            type: "field",
            source: [`${c.wg_ip}/32`],
            inboundTag: [WG_INBOUND_TAG],
            outboundTag: "hy2-uplink",
          });
        }
      } else if (hy2Clients.length > 0) {
        logger.warn(
          `${hy2Clients.length} WG client(s) request Hy2 transport but Server A has no hy2-uplink outbound — falling back to VLESS`
        );
      }

      // Default: everything else from the WG TPROXY inbound goes over VLESS.
      rules.push({ type: "field", inboundTag: [WG_INBOUND_TAG], outboundTag: "proxy-out" });

      const current = JSON.stringify(config.routing?.rules ?? null);
      const next = JSON.stringify(rules);
      if (current === next) {
        logger.debug("Server A XRay routing already in sync — no restart");
        return;
      }

      config.routing = config.routing || {};
      config.routing.rules = rules;

      // Atomic write on A (temp + mv, mode 0600 via umask) then restart XRay.
      // base64 carries the JSON safely through the SSH command line.
      const b64 = Buffer.from(JSON.stringify(config, null, 2)).toString("base64");
      await sshPool.exec(
        `bash -c 'umask 077; echo ${b64} | base64 -d > ${CONFIG_PATH}.tmp && mv ${CONFIG_PATH}.tmp ${CONFIG_PATH} && systemctl restart xray'`
      );

      const hy2Count = hasHy2Uplink ? hy2Clients.length : 0;
      logger.info(`Server A XRay routing synced (${hy2Count} Hy2, rest VLESS), xray restarted`);
    } catch (err) {
      logger.error(`Server A routing sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

export const xrayUplinkService = new XrayUplinkService();
