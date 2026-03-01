"use strict";
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
exports.sshPool = void 0;
const ssh2_1 = require("ssh2");
const fs = __importStar(require("fs"));
const env_1 = require("../config/env");
const RECONNECT_DELAY_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;
class SshPool {
    client = null;
    connecting = false;
    closed = false;
    pendingQueue = [];
    get connectConfig() {
        return {
            host: env_1.env.SERVER_A_HOST,
            port: env_1.env.SERVER_A_SSH_PORT,
            username: env_1.env.SERVER_A_SSH_USER,
            privateKey: fs.readFileSync(env_1.env.SERVER_A_SSH_KEY_PATH),
            readyTimeout: 15000,
            keepaliveInterval: 10000,
        };
    }
    connect() {
        return new Promise((resolve, reject) => {
            if (this.client) {
                resolve(this.client);
                return;
            }
            this.pendingQueue.push({ resolve, reject });
            if (this.connecting)
                return;
            this.connecting = true;
            const conn = new ssh2_1.Client();
            conn.on("ready", () => {
                this.client = conn;
                this.connecting = false;
                const pending = [...this.pendingQueue];
                this.pendingQueue = [];
                pending.forEach(({ resolve }) => resolve(conn));
            });
            conn.on("error", (err) => {
                this.client = null;
                this.connecting = false;
                const pending = [...this.pendingQueue];
                this.pendingQueue = [];
                pending.forEach(({ reject }) => reject(err));
            });
            conn.on("close", () => {
                this.client = null;
                if (!this.closed) {
                    // Auto-reconnect after delay
                    setTimeout(() => {
                        if (!this.closed)
                            this.connect().catch(() => { });
                    }, RECONNECT_DELAY_MS);
                }
            });
            conn.connect(this.connectConfig);
        });
    }
    async exec(command) {
        const conn = await this.connect();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("SSH command timed out")), COMMAND_TIMEOUT_MS);
            conn.exec(command, (err, stream) => {
                if (err) {
                    clearTimeout(timer);
                    reject(err);
                    return;
                }
                let stdout = "";
                let stderr = "";
                stream
                    .on("data", (d) => { stdout += d.toString(); })
                    .stderr.on("data", (d) => { stderr += d.toString(); });
                stream.on("close", (code) => {
                    clearTimeout(timer);
                    if (code !== 0) {
                        reject(new Error(`SSH command failed (exit ${code}): ${stderr.trim()}`));
                    }
                    else {
                        resolve(stdout);
                    }
                });
            });
        });
    }
    // Ping check — returns true if reachable
    async ping() {
        try {
            await this.connect();
            await this.exec("echo ok");
            return true;
        }
        catch {
            return false;
        }
    }
    close() {
        this.closed = true;
        this.client?.end();
        this.client = null;
    }
}
exports.sshPool = new SshPool();
//# sourceMappingURL=ssh.js.map