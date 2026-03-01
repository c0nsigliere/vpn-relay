"use strict";
/**
 * XRay service — uses the local xray CLI for stats and atomic clients.json
 * writes + service restart for client management.
 *
 * This avoids gRPC proto dependency hell: XRay proto files have deep
 * transitive imports that are impractical to bundle. The xray binary itself
 * provides a built-in `xray api` CLI that communicates with the local gRPC
 * endpoint using its own bundled proto definitions.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.xrayService = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const child_process_1 = require("child_process");
const env_1 = require("../config/env");
const XRAY_BIN = "/usr/local/bin/xray";
class XrayService {
    // Add a VLESS client: persist to clients.json + update config.json + restart xray
    async addClient(name, uuid) {
        const clientUuid = uuid ?? crypto.randomUUID();
        this.syncClientsJson("add", { name, uuid: clientUuid });
        this.syncConfigJson();
        await this.restartXray();
        return clientUuid;
    }
    // Remove a VLESS client: persist to clients.json + update config.json + restart xray
    async removeClient(name, uuid) {
        this.syncClientsJson("remove", { name, uuid });
        this.syncConfigJson();
        await this.restartXray();
    }
    // Query traffic stats for a client via `xray api statsquery` CLI
    async getStats(name, reset = false) {
        return this.queryStatsCli(`user>>>${name}@xray`, reset);
    }
    // Query all user stats (for traffic worker)
    async queryAllStats(reset = false) {
        const result = new Map();
        try {
            // Quote >>>traffic>>> to prevent /bin/sh from misinterpreting >>> as redirects
            const resetFlag = reset ? " -reset" : "";
            const out = (0, child_process_1.execSync)(`${XRAY_BIN} api statsquery --server=127.0.0.1:${env_1.env.XRAY_API_PORT} '-pattern' '>>>traffic>>>'${resetFlag}`, { encoding: "utf8", timeout: 10000 });
            // Output is {"stat": [{name, value}, ...]} — xray API wraps the array
            const parsed = JSON.parse(out);
            const stats = parsed?.stat ?? [];
            for (const stat of stats) {
                const m = stat.name.match(/^user>>>(.+)@xray>>>traffic>>>(uplink|downlink)$/);
                if (!m)
                    continue;
                const [, clientName, direction] = m;
                if (!result.has(clientName)) {
                    result.set(clientName, { uplinkBytes: BigInt(0), downlinkBytes: BigInt(0) });
                }
                const entry = result.get(clientName);
                const bytes = BigInt(stat.value ?? 0);
                if (direction === "uplink")
                    entry.uplinkBytes = bytes;
                else
                    entry.downlinkBytes = bytes;
            }
        }
        catch {
            // xray api not available or no stats yet
        }
        return result;
    }
    // Generate VLESS URIs (direct + relay) matching xray-client.vless.txt.j2 format
    generateVlessUris(name, uuid) {
        const pubkey = fs
            .readFileSync(path.join(env_1.env.XRAY_KEYS_DIR, "reality.pub"), "utf8")
            .trim();
        const shortId = fs
            .readFileSync(path.join(env_1.env.XRAY_KEYS_DIR, "shortid"), "utf8")
            .trim();
        const params = [
            "encryption=none",
            "security=reality",
            `sni=${env_1.env.XRAY_SNI}`,
            `fp=${env_1.env.XRAY_FINGERPRINT}`,
            `pbk=${pubkey}`,
            `sid=${shortId}`,
            "type=tcp",
            ...(env_1.env.XRAY_FLOW ? [`flow=${env_1.env.XRAY_FLOW}`] : []),
        ].join("&");
        const direct = `vless://${uuid}@${env_1.env.SERVER_B_HOST}:${env_1.env.SERVER_B_XRAY_PORT}?${params}#${name}`;
        const relay = `vless://${uuid}@${env_1.env.SERVER_A_HOST}:${env_1.env.SERVER_A_RELAY_PORT}?${params}#${name}-via-relay`;
        return { direct, relay };
    }
    // Atomic write to clients.json
    syncClientsJson(action, client) {
        const file = env_1.env.XRAY_CLIENTS_FILE;
        let clients = [];
        if (fs.existsSync(file)) {
            try {
                clients = JSON.parse(fs.readFileSync(file, "utf8"));
            }
            catch {
                clients = [];
            }
        }
        if (action === "add") {
            if (!clients.find((c) => c.name === client.name || c.uuid === client.uuid)) {
                clients.push(client);
            }
        }
        else {
            clients = clients.filter((c) => c.uuid !== client.uuid);
        }
        // Atomic write: temp file then rename
        const tmp = `${file}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(clients, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, file);
    }
    // Sync bot-managed clients into config.json so they survive xray restarts.
    // Preserves Ansible-managed clients (those not in clients.json).
    syncConfigJson() {
        const configFile = env_1.env.XRAY_CONFIG_FILE;
        const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
        const vlessIn = config.inbounds.find((i) => i.tag === "vless-in" && i.protocol === "vless");
        if (!vlessIn)
            throw new Error("vless-in inbound not found in config.json");
        // Read current bot-managed clients
        let botClients = [];
        if (fs.existsSync(env_1.env.XRAY_CLIENTS_FILE)) {
            try {
                botClients = JSON.parse(fs.readFileSync(env_1.env.XRAY_CLIENTS_FILE, "utf8"));
            }
            catch { /* start fresh */ }
        }
        const botUuids = new Set(botClients.map((c) => c.uuid));
        // Keep non-bot clients (Ansible-managed), replace bot clients with current list
        const staticClients = vlessIn.settings.clients.filter((c) => !botUuids.has(c.id));
        const newBotClients = botClients.map((c) => ({
            id: c.uuid,
            email: `${c.name}@xray`,
            ...(env_1.env.XRAY_FLOW ? { flow: env_1.env.XRAY_FLOW } : {}),
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
    async restartXray() {
        const trigger = "/run/vpn-bot/xray-restart";
        fs.writeFileSync(trigger, "", { mode: 0o644 });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 300));
            if (!fs.existsSync(trigger))
                return;
        }
        throw new Error("xray restart timed out after 10s");
    }
    async queryStatsCli(pattern, reset) {
        try {
            // Quote >>> args to prevent /bin/sh from misinterpreting them as redirects
            const resetFlag = reset ? " -reset" : "";
            const server = `--server=127.0.0.1:${env_1.env.XRAY_API_PORT}`;
            const upOut = (0, child_process_1.execSync)(`${XRAY_BIN} api statget ${server} '-name=${pattern}>>>uplink'${resetFlag} 2>/dev/null || echo '{"stat":{"value":"0"}}'`, { encoding: "utf8", timeout: 5000 });
            const downOut = (0, child_process_1.execSync)(`${XRAY_BIN} api statget ${server} '-name=${pattern}>>>downlink'${resetFlag} 2>/dev/null || echo '{"stat":{"value":"0"}}'`, { encoding: "utf8", timeout: 5000 });
            const up = JSON.parse(upOut);
            const down = JSON.parse(downOut);
            return {
                uplinkBytes: BigInt(up?.stat?.value ?? 0),
                downlinkBytes: BigInt(down?.stat?.value ?? 0),
            };
        }
        catch {
            return { uplinkBytes: BigInt(0), downlinkBytes: BigInt(0) };
        }
    }
    // No-op: nothing to close in the CLI approach
    close() { }
}
exports.xrayService = new XrayService();
//# sourceMappingURL=xray.service.js.map