/**
 * Hysteria 2 service — manages the sing-box config.json from DB state and
 * provides per-user traffic stats via sing-box's v2ray_api gRPC endpoint.
 *
 * Mirrors xray.service.ts: DB is the single source of truth, config is rebuilt
 * from DB on every mutation, and sing-box is restarted via a systemd path unit.
 *
 * Stats cannot go through the xray CLI: sing-box registers the stats gRPC service
 * under the v2ray v5 name "v2ray.core.app.stats.command.StatsService", while the
 * xray CLI targets "xray.app.stats.command.StatsService". So we call sing-box
 * directly with a native gRPC client (proto/v2ray-stats.proto).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { env } from "../config/env";
import { queries } from "../db/queries";
import { createLogger } from "../utils/logger";
import type { ClientStats } from "./xray.service";

const logger = createLogger("hysteria");

// Resolved from dist/services/ back up to packages/server/proto/ at runtime.
// The proto/ dir is rsynced with the source tree (it is not copied into dist/).
const PROTO_PATH = path.join(__dirname, "../../proto/v2ray-stats.proto");

const RESTART_TRIGGER = "/run/vpn-bot/singbox-restart";

interface Hy2User {
  name: string;
  password: string;
}

class HysteriaService {
  private statsClient: grpc.Client | null = null;

  /** Generate a random Hysteria 2 auth password (pattern: {protocol}_{identifier}). */
  generatePassword(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  /**
   * Rebuild sing-box config.json from DB + restart.
   * Call after any client state change (create, suspend, resume, rename, delete).
   */
  async syncConfigAndRestart(): Promise<void> {
    this.syncConfigJson();
    await this.restartSingbox();
    const count = queries
      .getActiveClients()
      .filter((c) => c.type === "hysteria2" && c.hy2_password).length;
    logger.info(`sing-box config synced (${count} active hy2 clients), restart triggered`);
  }

  /**
   * Build a canonical Hysteria 2 URI (hysteria.network format — note the slash
   * before '?', required by stricter parsers). Direct-only; no relay variant.
   */
  generateUri(name: string, password: string): string {
    const obfs = fs.readFileSync(env.SINGBOX_OBFS_FILE, "utf8").trim();
    const params = [
      `sni=${encodeURIComponent(env.HY2_DOMAIN)}`,
      "obfs=salamander",
      `obfs-password=${encodeURIComponent(obfs)}`,
    ].join("&");

    const countryB = env.SERVER_B_COUNTRY;
    const tag = countryB ? `${name}_${countryB}` : name;

    return `hysteria2://${encodeURIComponent(password)}@${env.HY2_HOST}:${env.HY2_PORT}/?${params}#${encodeURIComponent(tag)}`;
  }

  /**
   * Query all user traffic stats via the sing-box v2ray_api gRPC endpoint.
   * Same signature/shape as xrayService.queryAllStats. Errors are swallowed
   * (empty Map) so the traffic worker never crashes on a sing-box hiccup.
   */
  async queryAllStats(reset = false): Promise<Map<string, ClientStats>> {
    const result = new Map<string, ClientStats>();
    try {
      const client = this.getStatsClient() as grpc.Client & {
        QueryStats: (req: unknown, cb: (err: unknown, res: unknown) => void) => void;
      };
      const response = await new Promise<{ stat?: Array<{ name: string; value?: string | number }> }>(
        (resolve, reject) => {
          client.QueryStats({ pattern: ">>>traffic>>>", reset }, (err, res) =>
            err ? reject(err) : resolve(res as { stat?: Array<{ name: string; value?: string | number }> })
          );
        }
      );
      const stats = response?.stat ?? [];
      for (const stat of stats) {
        const m = stat.name.match(/^user>>>(.+)@hy2>>>traffic>>>(uplink|downlink)$/);
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
    } catch (err) {
      logger.debug(`queryAllStats failed: ${err instanceof Error ? err.message : err}`);
    }
    return result;
  }

  /**
   * Probe the v2ray_api gRPC stats endpoint. Distinguishes "reachable" from the
   * silent failure where sing-box is systemd-active but its stats API is broken
   * (which would make traffic accounting return zeros without any error).
   */
  async statsApiHealthy(): Promise<boolean> {
    try {
      const client = this.getStatsClient() as grpc.Client & {
        QueryStats: (
          req: unknown,
          md: grpc.Metadata,
          opts: grpc.CallOptions,
          cb: (err: unknown, res: unknown) => void
        ) => void;
      };
      await new Promise((resolve, reject) => {
        client.QueryStats(
          { pattern: ">>>traffic>>>", reset: false },
          new grpc.Metadata(),
          { deadline: Date.now() + 3000 },
          (err, res) => (err ? reject(err) : resolve(res))
        );
      });
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.statsClient) {
      this.statsClient.close();
      this.statsClient = null;
    }
  }

  /**
   * Rebuild the hy2-in inbound users from DB and keep v2ray_api stats.users in
   * sync. stats.users is an explicit allow-list (no wildcard): a user missing
   * from it gets no counters. The config is patched, not rebuilt from scratch,
   * so unrelated fields survive.
   */
  private syncConfigJson(): void {
    const configFile = env.SINGBOX_CONFIG_FILE;
    const config = JSON.parse(fs.readFileSync(configFile, "utf8"));

    const hy2In = (config.inbounds as any[]).find(
      (i) => i.tag === "hy2-in" && i.type === "hysteria2"
    );
    if (!hy2In) throw new Error("hy2-in inbound not found in sing-box config.json");

    const users: Hy2User[] = [];
    // Static cascade uplink user (phase 3) — only when a password is configured.
    if (env.HY2_UPLINK_PASSWORD) {
      users.push({ name: "wg-clients@hy2", password: env.HY2_UPLINK_PASSWORD });
    }
    // Bot clients: active Hysteria 2 clients from DB.
    const activeClients = queries
      .getActiveClients()
      .filter((c) => c.type === "hysteria2" && c.hy2_password);
    for (const c of activeClients) {
      users.push({ name: `${c.name}@hy2`, password: c.hy2_password! });
    }

    hy2In.users = users;

    const statNames = users.map((u) => u.name);
    if (config.experimental?.v2ray_api?.stats) {
      config.experimental.v2ray_api.stats.users = statNames;
    }

    const tmp = `${configFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, configFile);
  }

  // Trigger sing-box restart via systemd path unit — write trigger file, poll
  // until removed. Mirrors xray.service.ts#restartXray; no privilege escalation.
  private async restartSingbox(): Promise<void> {
    fs.writeFileSync(RESTART_TRIGGER, "", { mode: 0o644 });

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      if (!fs.existsSync(RESTART_TRIGGER)) return;
    }
    logger.warn("sing-box restart not confirmed within 10s — systemd path unit will complete it");
  }

  private getStatsClient(): grpc.Client {
    if (this.statsClient) return this.statsClient;
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const StatsService = proto.v2ray.core.app.stats.command.StatsService;
    this.statsClient = new StatsService(
      `127.0.0.1:${env.SINGBOX_V2RAY_API_PORT}`,
      grpc.credentials.createInsecure()
    ) as grpc.Client;
    return this.statsClient;
  }
}

export const hysteriaService = new HysteriaService();
