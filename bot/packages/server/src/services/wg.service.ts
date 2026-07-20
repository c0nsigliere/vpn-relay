/**
 * WgService — WireGuard peer management on Server A (cascade mode only).
 *
 * Two layers, deliberately separated:
 *
 *   Live state  — incremental `wg set` calls (add/remove a single peer). Instant,
 *                 and they never disturb the sessions of unrelated peers.
 *   Persisted   — `wg-clients.conf` is *derived data*, rebuilt wholesale from the DB
 *                 by syncPeersFromDb(). The bot owns the peer region; the Ansible-
 *                 managed [Interface] section is preserved verbatim.
 *
 * The desired-state rebuild is the same shape as xrayService.syncConfigAndRestart()
 * for XRay and hysteriaService for sing-box, and it is what makes "the DB is the
 * single source of truth" actually true for WireGuard: a restored DB resurrects the
 * full peer set, and any drift on A heals on the next startup or mutation.
 *
 * Callers must invoke syncPeersFromDb() *after* the DB write, never before — the
 * desired state is computed from the rows, so a pre-write call renders stale state.
 */

import { sshPool } from "./ssh";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { isStandalone, requireCascade } from "../config/standalone";
import { createLogger } from "../utils/logger";
import {
  DesiredPeer,
  IP_RE,
  NAME_RE,
  PUBKEY_RE,
  WG_CONF,
  WG_IFACE,
  WG_IP_END,
  WG_IP_START,
  WG_NET,
  isValidWgIp,
  parseConfIps,
  renderConf,
} from "./wg.conf";

const logger = createLogger("wg");

// Reload idiom: a temp file rather than process substitution, for shells that lack it.
const RELOAD_CMD =
  `bash -c 'wg-quick strip ${WG_IFACE} > /tmp/wg-sync.conf ` +
  `&& wg syncconf ${WG_IFACE} /tmp/wg-sync.conf; rm -f /tmp/wg-sync.conf'`;

export interface WgClientConfig {
  privateKey: string;
  publicKey: string;
  ip: string;
  conf: string;
}

export interface WgPeerStats {
  pubkey: string;
  endpoint: string;
  allowedIps: string;
  latestHandshake: number;
  rxBytes: number;
  txBytes: number;
}

export interface WgSyncResult {
  /** Peer blocks written to the conf (active + suspended). */
  applied: number;
  /** Suspended peers removed from live state. */
  suspended: number;
  /** Names of DB rows rejected by validation — rendered nowhere, exec'd nowhere. */
  skipped: string[];
}

// Mutex to prevent duplicate IP allocation from concurrent requests
let ipMutex: Promise<void> = Promise.resolve();

class WgService {
  async addClient(name: string): Promise<WgClientConfig> {
    requireCascade("WireGuard");
    let result!: WgClientConfig;
    // Serialize through the mutex to prevent duplicate IP assignment. The chain is
    // re-armed with a resolved promise on failure — without this, one rejection
    // would poison every subsequent allocation for the lifetime of the process.
    const run = ipMutex.then(async () => {
      result = await this.doAddClient(name);
    });
    ipMutex = run.catch(() => undefined);
    await run;
    return result;
  }

  private async doAddClient(name: string): Promise<WgClientConfig> {
    // Generate the keypair on Server A (it has the wg tools)
    const privateKey = (await sshPool.exec("wg genkey")).trim();
    const publicKey = (
      await sshPool.exec(`bash -c 'echo "${privateKey}" | wg pubkey'`)
    ).trim();

    const ip = await this.findFreeIp();

    // Add the peer live (instant, no reload needed). The conf block is written by
    // the caller's syncPeersFromDb() once the row exists.
    await sshPool.exec(
      `wg set ${WG_IFACE} peer ${publicKey} allowed-ips ${ip}/32`
    );

    const serverPubkey = (
      await sshPool.exec(`cat /etc/wireguard/keys/wg-clients.pub`)
    ).trim();

    const conf = [
      `[Interface]`,
      `Address    = ${ip}/32`,
      `PrivateKey = ${privateKey}`,
      `DNS        = 1.1.1.1,1.0.0.1`,
      ``,
      `[Peer]`,
      `# Server A — cascade VPN entry point`,
      `PublicKey           = ${serverPubkey}`,
      `Endpoint            = ${env.SERVER_A_HOST}:${env.SERVER_A_WG_PORT}`,
      `AllowedIPs          = 0.0.0.0/0`,
      `PersistentKeepalive = 25`,
    ].join("\n");

    return { privateKey, publicKey, ip, conf };
  }

  /** Remove a peer from live state. The conf block goes away via syncPeersFromDb(). */
  async removeClient(pubkey: string): Promise<void> {
    requireCascade("WireGuard");
    await sshPool.exec(`wg set ${WG_IFACE} peer ${pubkey} remove`);
  }

  /**
   * Suspend / resume touch live state only — the conf block stays either way.
   * That is deliberate: the block is the durable record of an allocated IP, and
   * syncPeersFromDb() renders suspended clients too, then removes them live.
   */
  async suspendClient(pubkey: string): Promise<void> {
    requireCascade("WireGuard");
    await sshPool.exec(`wg set ${WG_IFACE} peer ${pubkey} remove`);
  }

  async resumeClient(pubkey: string, ip: string): Promise<void> {
    requireCascade("WireGuard");
    await sshPool.exec(
      `wg set ${WG_IFACE} peer ${pubkey} allowed-ips ${ip}/32`
    );
  }

  /**
   * Rebuild Server A's peer region from the DB and reconcile live state.
   *
   * No-op in standalone. Throws if Server A is unreachable — call sites decide
   * whether that is fatal (a mutation) or best-effort (startup).
   */
  async syncPeersFromDb(): Promise<WgSyncResult> {
    if (isStandalone) return { applied: 0, suspended: 0, skipped: [] };

    const { desired, skipped } = this.buildDesiredPeers();

    const currentConf = await sshPool.exec(`cat ${WG_CONF}`);
    const nextConf = renderConf(currentConf, desired);

    // Ship base64-encoded and land it with a temp file + atomic mv: config text is
    // never interpolated into a shell string, and a dropped connection mid-write
    // can never leave a truncated conf in place.
    const encoded = Buffer.from(nextConf).toString("base64");
    await sshPool.exec(
      `bash -c 'echo ${encoded} | base64 -d > ${WG_CONF}.tmp ` +
        `&& chmod 600 ${WG_CONF}.tmp && mv ${WG_CONF}.tmp ${WG_CONF}'`
    );

    await sshPool.exec(RELOAD_CMD);

    // syncconf applies the whole conf, which includes suspended peers, so they are
    // dropped again here. Live state = active peers only. The re-add/remove window
    // is a single SSH round-trip and only ever affects already-suspended clients.
    const suspendedPeers = desired.filter((p) => !p.active);
    for (const peer of suspendedPeers) {
      await sshPool.exec(`wg set ${WG_IFACE} peer ${peer.pubkey} remove`);
    }

    if (skipped.length > 0) {
      logger.error(
        `Skipped ${skipped.length} invalid WG row(s) — not rendered: ${skipped.join(", ")}`
      );
    }
    logger.info(
      `Peers synced from DB: ${desired.length} block(s), ${suspendedPeers.length} suspended`
    );

    return { applied: desired.length, suspended: suspendedPeers.length, skipped };
  }

  /**
   * Desired peer set from the DB: every WG-capable client with a key and an IP,
   * *including suspended ones* (their block records the IP allocation).
   * A row failing validation is skipped rather than aborting the whole sync — one
   * corrupt row must not take every other client's connectivity down with it.
   */
  private buildDesiredPeers(): { desired: DesiredPeer[]; skipped: string[] } {
    const desired: DesiredPeer[] = [];
    const skipped: string[] = [];

    for (const c of queries.getAllClients()) {
      if (c.type !== "wg" && c.type !== "both") continue;
      if (!c.wg_pubkey || !c.wg_ip) continue;

      if (!NAME_RE.test(c.name) || !PUBKEY_RE.test(c.wg_pubkey) || !isValidWgIp(c.wg_ip)) {
        skipped.push(c.name);
        continue;
      }
      desired.push({
        name: c.name,
        pubkey: c.wg_pubkey,
        ip: c.wg_ip,
        active: c.is_active === 1,
      });
    }

    return { desired, skipped };
  }

  async getStats(): Promise<WgPeerStats[]> {
    if (isStandalone) return [];
    const output = await sshPool.exec(`wg show ${WG_IFACE} dump`);
    const lines = output.trim().split("\n").slice(1); // skip interface line
    return lines
      .filter((l) => l.trim())
      .map((line) => {
        const [pubkey, _psk, endpoint, allowedIps, latestHandshake, rxBytes, txBytes] =
          line.split("\t");
        return {
          pubkey,
          endpoint: endpoint === "(none)" ? "" : endpoint,
          allowedIps,
          latestHandshake: parseInt(latestHandshake, 10),
          rxBytes: parseInt(rxBytes, 10),
          txBytes: parseInt(txBytes, 10),
        };
      });
  }

  /**
   * Allocate the next free tunnel IP from union(DB, conf-on-A).
   *
   * The DB side is authoritative and always available; the conf side is a
   * conservative extra that protects a peer an operator added by hand. Reading
   * only the conf (the previous behaviour) is the wrong direction under
   * desired-state: right after a restore the conf is not yet rebuilt, so an IP the
   * DB already owns would be handed out twice.
   */
  private async findFreeIp(): Promise<string> {
    const used = new Set<number>();

    for (const c of queries.getAllClients()) {
      if (!c.wg_ip) continue;
      const m = IP_RE.exec(c.wg_ip);
      if (m) used.add(parseInt(m[1], 10));
    }

    try {
      const conf = await sshPool.exec(`cat ${WG_CONF}`);
      for (const n of parseConfIps(conf)) used.add(n);
    } catch {
      // A is unreachable — the DB alone is a safe basis, since every IP the bot
      // ever issued is recorded there.
      logger.warn("Could not read wg-clients.conf for IP allocation; using DB only");
    }

    for (let i = WG_IP_START; i <= WG_IP_END; i++) {
      if (!used.has(i)) return `${WG_NET}.${i}`;
    }
    throw new Error(`No free IPs in WireGuard subnet ${WG_NET}.0/24`);
  }
}

export const wgService = new WgService();
