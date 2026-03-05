/**
 * XRay service — manages XRay config.json from DB state and provides
 * stats queries via the local xray CLI.
 *
 * DB is the single source of truth for client state. This service
 * rebuilds config.json from DB on every state change (create, suspend,
 * resume, rename, delete) and restarts XRay via systemd path unit.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { env } from "../config/env";
import { queries } from "../db/queries";

const XRAY_BIN = "/usr/local/bin/xray";

export interface VlessUris {
  direct: string;
  relay: string;
}

export interface ClientStats {
  uplinkBytes: bigint;
  downlinkBytes: bigint;
}

class XrayService {
  /**
   * Rebuild config.json from DB + restart XRay.
   * Call after any client state change (create, suspend, resume, rename, delete).
   */
  async syncConfigAndRestart(): Promise<void> {
    this.syncConfigJson();
    await this.restartXray();
  }

  /** Generate a new UUID for a VLESS client. */
  generateUuid(): string {
    return crypto.randomUUID();
  }

  // Query traffic stats for a client via `xray api statsquery` CLI
  async getStats(name: string, reset = false): Promise<ClientStats> {
    return this.queryStatsCli(`user>>>${name}@xray`, reset);
  }

  // Query all user stats (for traffic worker)
  async queryAllStats(reset = false): Promise<Map<string, ClientStats>> {
    const result = new Map<string, ClientStats>();
    try {
      // Quote >>>traffic>>> to prevent /bin/sh from misinterpreting >>> as redirects
      const resetFlag = reset ? " -reset" : "";
      const out = execSync(
        `${XRAY_BIN} api statsquery --server=127.0.0.1:${env.XRAY_API_PORT} '-pattern' '>>>traffic>>>'${resetFlag}`,
        { encoding: "utf8", timeout: 10000 }
      );
      // Output is {"stat": [{name, value}, ...]} — xray API wraps the array
      const parsed = JSON.parse(out);
      const stats: Array<{ name: string; value?: number | string }> = parsed?.stat ?? [];
      for (const stat of stats) {
        const m = stat.name.match(/^user>>>(.+)@xray>>>traffic>>>(uplink|downlink)$/);
        if (!m) continue;
        const [, clientName, direction] = m;
        if (!result.has(clientName)) {
          result.set(clientName, { uplinkBytes: BigInt(0), downlinkBytes: BigInt(0) });
        }
        const entry = result.get(clientName)!;
        const bytes = BigInt(stat.value ?? 0);
        if (direction === "uplink") entry.uplinkBytes = bytes;
        else entry.downlinkBytes = bytes;
      }
    } catch {
      // xray api not available or no stats yet
    }
    return result;
  }

  // Generate VLESS URIs (direct + relay) matching xray-client.vless.txt.j2 format
  generateVlessUris(name: string, uuid: string): VlessUris {
    const pubkey = fs
      .readFileSync(path.join(env.XRAY_KEYS_DIR, "reality.pub"), "utf8")
      .trim();
    const shortId = fs
      .readFileSync(path.join(env.XRAY_KEYS_DIR, "shortid"), "utf8")
      .trim();

    const params = [
      "encryption=none",
      "security=reality",
      `sni=${env.XRAY_SNI}`,
      `fp=${env.XRAY_FINGERPRINT}`,
      `pbk=${pubkey}`,
      `sid=${shortId}`,
      "type=tcp",
      ...(env.XRAY_FLOW ? [`flow=${env.XRAY_FLOW}`] : []),
    ].join("&");

    const direct = `vless://${uuid}@${env.SERVER_B_HOST}:${env.SERVER_B_XRAY_PORT}?${params}#${name}`;
    const relay = `vless://${uuid}@${env.SERVER_A_HOST}:${env.SERVER_A_RELAY_PORT}?${params}#${name}-via-relay`;

    return { direct, relay };
  }

  /**
   * Rebuild config.json client list from two sources:
   * 1. Static entry: wg-clients@xray (WG cascade TPROXY uplink, UUID from env)
   * 2. Active bot clients: from DB (is_active=1, type xray/both, has xray_uuid)
   */
  private syncConfigJson(): void {
    const configFile = env.XRAY_CONFIG_FILE;
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

    const vlessIn = (config.inbounds as any[]).find(
      (i) => i.tag === "vless-in" && i.protocol === "vless"
    );
    if (!vlessIn) throw new Error("vless-in inbound not found in config.json");

    // Static: WG cascade TPROXY uplink (Ansible-managed, no flow)
    const staticClients: Array<{ id: string; email: string }> = [];
    if (env.XRAY_WG_UPLINK_UUID) {
      staticClients.push({
        id: env.XRAY_WG_UPLINK_UUID,
        email: "wg-clients@xray",
      });
    }

    // Bot clients: active XRay clients from DB
    const activeClients = queries.getActiveClients().filter(
      (c) => (c.type === "xray" || c.type === "both") && c.xray_uuid
    );
    const botClients = activeClients.map((c) => ({
      id: c.xray_uuid!,
      email: `${c.name}@xray`,
      ...(env.XRAY_FLOW ? { flow: env.XRAY_FLOW } : {}),
    }));

    vlessIn.settings.clients = [...staticClients, ...botClients];

    const tmp = `${configFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, configFile);
  }

  // Trigger xray restart via systemd path unit — write trigger file, poll until removed.
  // The xray-restart.path unit watches /run/vpn-bot/xray-restart and fires
  // xray-restart.service (Type=oneshot) which restarts xray then deletes the file.
  // No sudo/privilege escalation needed; bot keeps NoNewPrivileges=true.
  private async restartXray(): Promise<void> {
    const trigger = "/run/vpn-bot/xray-restart";
    fs.writeFileSync(trigger, "", { mode: 0o644 });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (!fs.existsSync(trigger)) return;
    }
    throw new Error("xray restart timed out after 10s");
  }

  private async queryStatsCli(pattern: string, reset: boolean): Promise<ClientStats> {
    try {
      // Quote >>> args to prevent /bin/sh from misinterpreting them as redirects
      const resetFlag = reset ? " -reset" : "";
      const server = `--server=127.0.0.1:${env.XRAY_API_PORT}`;
      const upOut = execSync(
        `${XRAY_BIN} api statget ${server} '-name=${pattern}>>>uplink'${resetFlag} 2>/dev/null || echo '{"stat":{"value":"0"}}'`,
        { encoding: "utf8", timeout: 5000 }
      );
      const downOut = execSync(
        `${XRAY_BIN} api statget ${server} '-name=${pattern}>>>downlink'${resetFlag} 2>/dev/null || echo '{"stat":{"value":"0"}}'`,
        { encoding: "utf8", timeout: 5000 }
      );
      const up = JSON.parse(upOut);
      const down = JSON.parse(downOut);
      return {
        uplinkBytes: BigInt(up?.stat?.value ?? 0),
        downlinkBytes: BigInt(down?.stat?.value ?? 0),
      };
    } catch {
      return { uplinkBytes: BigInt(0), downlinkBytes: BigInt(0) };
    }
  }

  // No-op: nothing to close in the CLI approach
  close(): void {}
}

export const xrayService = new XrayService();
