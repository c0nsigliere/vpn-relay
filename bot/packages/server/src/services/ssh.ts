import { Client as SSH2Client, ConnectConfig } from "ssh2";
import * as fs from "fs";
import { env } from "../config/env";

const RECONNECT_DELAY_MS = 5000;
const COMMAND_TIMEOUT_MS = 30000;

class SshPool {
  private client: SSH2Client | null = null;
  private connecting = false;
  private closed = false;
  private pendingQueue: Array<{
    resolve: (conn: SSH2Client) => void;
    reject: (err: Error) => void;
  }> = [];

  private get connectConfig(): ConnectConfig {
    return {
      host: env.SERVER_A_HOST,
      port: env.SERVER_A_SSH_PORT,
      username: env.SERVER_A_SSH_USER,
      privateKey: fs.readFileSync(env.SERVER_A_SSH_KEY_PATH),
      readyTimeout: 15000,
      keepaliveInterval: 10000,
    };
  }

  private connect(): Promise<SSH2Client> {
    return new Promise((resolve, reject) => {
      if (this.client) {
        resolve(this.client);
        return;
      }
      this.pendingQueue.push({ resolve, reject });
      if (this.connecting) return;

      this.connecting = true;
      const conn = new SSH2Client();

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
            if (!this.closed) this.connect().catch(() => {});
          }, RECONNECT_DELAY_MS);
        }
      });

      conn.connect(this.connectConfig);
    });
  }

  async exec(command: string): Promise<string> {
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
          .on("data", (d: Buffer) => { stdout += d.toString(); })
          .stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        stream.on("close", (code: number) => {
          clearTimeout(timer);
          if (code !== 0) {
            reject(new Error(`SSH command failed (exit ${code}): ${stderr.trim()}`));
          } else {
            resolve(stdout);
          }
        });
      });
    });
  }

  // Ping check — returns true if reachable
  async ping(): Promise<boolean> {
    try {
      await this.connect();
      await this.exec("echo ok");
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.closed = true;
    this.client?.end();
    this.client = null;
  }
}

export const sshPool = new SshPool();
