import { sshPool } from "./ssh";
import { env } from "../config/env";

const WG_IFACE = "wg-clients";
const WG_CONF = `/etc/wireguard/${WG_IFACE}.conf`;
const WG_NET = "10.66.0";
const WG_IP_START = 2;
const WG_IP_END = 254;

// Mutex to prevent duplicate IP allocation from concurrent requests
let ipMutex: Promise<void> = Promise.resolve();

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

class WgService {
  async addClient(name: string): Promise<WgClientConfig> {
    let result!: WgClientConfig;
    // Serialize through mutex to prevent duplicate IP assignment
    ipMutex = ipMutex.then(async () => {
      result = await this.doAddClient(name);
    });
    await ipMutex;
    return result;
  }

  private async doAddClient(name: string): Promise<WgClientConfig> {
    // Generate keypair on Server A (has wg tools)
    const privateKey = (await sshPool.exec("wg genkey")).trim();
    const publicKey = (
      await sshPool.exec(`bash -c 'echo "${privateKey}" | wg pubkey'`)
    ).trim();

    // Find next available IP
    const ip = await this.findFreeIp();

    // Add peer live (instant, no restart needed)
    await sshPool.exec(
      `wg set ${WG_IFACE} peer ${publicKey} allowed-ips ${ip}/32`
    );

    // Append peer block to config (for persistence across reboots)
    // Use base64 to safely transfer multi-line content over SSH exec
    const peerBlock = [
      ``,
      `# BEGIN CLIENT ${name}`,
      `[Peer]`,
      `# ${name}`,
      `PublicKey = ${publicKey}`,
      `AllowedIPs = ${ip}/32`,
      `# END CLIENT ${name}`,
    ].join("\n");
    const encoded = Buffer.from(peerBlock).toString("base64");

    await sshPool.exec(
      `bash -c 'echo ${encoded} | base64 -d >> ${WG_CONF}'`
    );

    // Reload config without dropping existing peers (use temp file — no process substitution)
    await sshPool.exec(
      `bash -c 'wg-quick strip ${WG_IFACE} > /tmp/wg-sync.conf && wg syncconf ${WG_IFACE} /tmp/wg-sync.conf; rm -f /tmp/wg-sync.conf'`
    );

    // Fetch server public key
    const serverPubkey = (
      await sshPool.exec(`cat /etc/wireguard/keys/wg-clients.pub`)
    ).trim();

    // Generate client .conf in memory
    const conf = [
      `[Interface]`,
      `Address    = ${ip}/32`,
      `PrivateKey = ${privateKey}`,
      `DNS        = ${env.SERVER_A_WG_PORT === 51888 ? "1.1.1.1,1.0.0.1" : "1.1.1.1,1.0.0.1"}`,
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

  async removeClient(name: string, pubkey: string): Promise<void> {
    // Remove from live WG
    await sshPool.exec(`wg set ${WG_IFACE} peer ${pubkey} remove`);

    // Remove config block between BEGIN/END markers
    await sshPool.exec(
      `bash -c 'sed -i "/^# BEGIN CLIENT ${name}$/,/^# END CLIENT ${name}$/d" ${WG_CONF}'`
    );

    // Reload
    await sshPool.exec(
      `bash -c 'wg syncconf ${WG_IFACE} <(wg-quick strip ${WG_IFACE})'`
    );
  }

  async suspendClient(pubkey: string): Promise<void> {
    // Remove from live WG (config block stays for resume)
    await sshPool.exec(`wg set ${WG_IFACE} peer ${pubkey} remove`);
  }

  async resumeClient(pubkey: string, ip: string): Promise<void> {
    await sshPool.exec(
      `wg set ${WG_IFACE} peer ${pubkey} allowed-ips ${ip}/32`
    );
  }

  async getStats(): Promise<WgPeerStats[]> {
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

  private async findFreeIp(): Promise<string> {
    const conf = await sshPool.exec(`cat ${WG_CONF}`);
    // Extract all AllowedIPs like 10.66.0.X/32
    const usedIps = new Set<number>();
    for (const match of conf.matchAll(/AllowedIPs\s*=\s*10\.66\.0\.(\d+)\/32/g)) {
      usedIps.add(parseInt(match[1], 10));
    }
    for (let i = WG_IP_START; i <= WG_IP_END; i++) {
      if (!usedIps.has(i)) return `${WG_NET}.${i}`;
    }
    throw new Error("No free IPs in WireGuard subnet 10.66.0.0/24");
  }
}

export const wgService = new WgService();
