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
  // Add a VLESS client: sync clients.json for persistence + hot-add via gRPC API
  async addClient(name: string, uuid?: string): Promise<string> {
    const clientUuid = uuid ?? crypto.randomUUID();
    this.syncClientsJson("add", { name, uuid: clientUuid });
    this.apiAddUser(name, clientUuid);
    return clientUuid;
  }

  // Remove a VLESS client: sync clients.json for persistence + hot-remove via gRPC API
  async removeClient(name: string, uuid: string): Promise<void> {
    this.syncClientsJson("remove", { name, uuid });
    this.apiRemoveUser(name);
  }

  // Query traffic stats for a client via `xray api statsquery` CLI
  async getStats(name: string, reset = false): Promise<ClientStats> {
    return this.queryStatsCli(`user>>>${name}@xray`, reset);
  }

  // Query all user stats (for traffic worker)
  async queryAllStats(reset = false): Promise<Map<string, ClientStats>> {
    const result = new Map<string, ClientStats>();
    try {
      const args = [
        `--server=127.0.0.1:${env.XRAY_API_PORT}`,
        "-pattern", ">>>traffic>>>",
        ...(reset ? ["-reset"] : []),
      ];
      const out = execSync(
        `${XRAY_BIN} api statsquery ${args.join(" ")}`,
        { encoding: "utf8", timeout: 10000 }
      );
      // Output is JSON array of {name, value} objects
      const stats: Array<{ name: string; value: string }> = JSON.parse(out);
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

  // Hot-add a user to the running xray instance via gRPC API (no restart needed)
  private apiAddUser(name: string, uuid: string): void {
    const userJson = JSON.stringify({
      inboundTag: "vless-in",
      user: {
        level: 0,
        email: `${name}@xray`,
        account: {
          "@type": "type.googleapis.com/xray.proxy.vless.Account",
          id: uuid,
          flow: env.XRAY_FLOW || undefined,
          encryption: "none",
        },
      },
    });
    const tmp = path.join(os.tmpdir(), `xray-user-${process.pid}.json`);
    try {
      fs.writeFileSync(tmp, userJson, { mode: 0o600 });
      execSync(
        `${XRAY_BIN} api adu --server=127.0.0.1:${env.XRAY_API_PORT} ${tmp}`,
        { timeout: 10000 }
      );
    } catch (err) {
      throw new Error(`Failed to hot-add user to xray: ${(err as Error).message}`);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  // Hot-remove a user from the running xray instance via gRPC API (no restart needed)
  private apiRemoveUser(name: string): void {
    try {
      execSync(
        `${XRAY_BIN} api rmu --server=127.0.0.1:${env.XRAY_API_PORT} -tag=vless-in ${name}@xray`,
        { timeout: 10000 }
      );
    } catch (err) {
      throw new Error(`Failed to hot-remove user from xray: ${(err as Error).message}`);
    }
  }

  private async queryStatsCli(pattern: string, reset: boolean): Promise<ClientStats> {
    try {
      const upArgs = [
        `--server=127.0.0.1:${env.XRAY_API_PORT}`,
        `-name=${pattern}>>>uplink`,
        ...(reset ? ["-reset"] : []),
      ];
      const downArgs = [
        `--server=127.0.0.1:${env.XRAY_API_PORT}`,
        `-name=${pattern}>>>downlink`,
        ...(reset ? ["-reset"] : []),
      ];
      const upOut = execSync(
        `${XRAY_BIN} api statget ${upArgs.join(" ")} 2>/dev/null || echo '{"stat":{"value":"0"}}'`,
        { encoding: "utf8", timeout: 5000 }
      );
      const downOut = execSync(
        `${XRAY_BIN} api statget ${downArgs.join(" ")} 2>/dev/null || echo '{"stat":{"value":"0"}}'`,
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
