/**
 * XRay service — uses the local xray CLI for stats and atomic clients.json
 * writes + service restart for client management.
 *
 * This avoids gRPC proto dependency hell: XRay proto files have deep
 * transitive imports that are impractical to bundle. The xray binary itself
 * provides a built-in `xray api` CLI that communicates with the local gRPC
 * endpoint using its own bundled proto definitions.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { env } from "../config/env";

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
  // Add a VLESS client: persist to clients.json + update config.json + restart xray
  async addClient(name: string, uuid?: string): Promise<string> {
    const clientUuid = uuid ?? crypto.randomUUID();
    this.syncClientsJson("add", { name, uuid: clientUuid });
    this.syncConfigJson();
    await this.restartXray();
    return clientUuid;
  }

  // Remove a VLESS client: persist to clients.json + update config.json + restart xray
  async removeClient(name: string, uuid: string): Promise<void> {
    this.syncClientsJson("remove", { name, uuid });
    this.syncConfigJson();
    await this.restartXray();
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

  // Atomic write to clients.json
  private syncClientsJson(
    action: "add" | "remove",
    client: { name: string; uuid: string }
  ): void {
    const file = env.XRAY_CLIENTS_FILE;
    let clients: Array<{ name: string; uuid: string }> = [];

    if (fs.existsSync(file)) {
      try {
        clients = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        clients = [];
      }
    }

    if (action === "add") {
      if (!clients.find((c) => c.name === client.name || c.uuid === client.uuid)) {
        clients.push(client);
      }
    } else {
      clients = clients.filter((c) => c.uuid !== client.uuid);
    }

    // Atomic write: temp file then rename
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(clients, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // Sync bot-managed clients into config.json so they survive xray restarts.
  // Preserves Ansible-managed clients (those not in clients.json).
  private syncConfigJson(): void {
    const configFile = env.XRAY_CONFIG_FILE;
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

    const vlessIn = (config.inbounds as any[]).find(
      (i) => i.tag === "vless-in" && i.protocol === "vless"
    );
    if (!vlessIn) throw new Error("vless-in inbound not found in config.json");

    // Read current bot-managed clients
    let botClients: Array<{ name: string; uuid: string }> = [];
    if (fs.existsSync(env.XRAY_CLIENTS_FILE)) {
      try {
        botClients = JSON.parse(fs.readFileSync(env.XRAY_CLIENTS_FILE, "utf8"));
      } catch { /* start fresh */ }
    }
    const botUuids = new Set(botClients.map((c) => c.uuid));

    // Keep non-bot clients (Ansible-managed), replace bot clients with current list
    const staticClients = (vlessIn.settings.clients as any[]).filter(
      (c) => !botUuids.has(c.id)
    );
    const newBotClients = botClients.map((c) => ({
      id: c.uuid,
      email: `${c.name}@xray`,
      ...(env.XRAY_FLOW ? { flow: env.XRAY_FLOW } : {}),
    }));
    vlessIn.settings.clients = [...staticClients, ...newBotClients];

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
