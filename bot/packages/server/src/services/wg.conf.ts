/**
 * Pure rendering + validation helpers for Server A's wg-clients.conf.
 *
 * Deliberately free of env/db/ssh imports so the desired-state logic — the part
 * that decides what actually lands in a root-owned config on the entry node — is
 * unit-testable without a configured environment.
 */

export const WG_IFACE = "wg-clients";
export const WG_CONF = `/etc/wireguard/${WG_IFACE}.conf`;
export const WG_NET = "10.66.0";
export const WG_IP_START = 2;
export const WG_IP_END = 254;

const BEGIN_MARKER = "# BEGIN CLIENT ";
const END_MARKER = "# END CLIENT ";

const NET_RE_SRC = WG_NET.replace(/\./g, "\\.");

// ── Row validation ───────────────────────────────────────────────────────────
// These values are rendered into a root-owned config on Server A and interpolated
// into SSH commands. After a restore they originate from an uploaded file, so they
// are validated on every render — GCM already proves the bundle's author held the
// passphrase, but a corrupt or hostile row must never reach a shell either way.

/** Same regex the REST API already enforces on client names (api/routes/clients.ts). */
export const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;
/** WireGuard public key: 32 bytes, base64, always ends in '='. */
export const PUBKEY_RE = /^[A-Za-z0-9+/]{43}=$/;
/** Tunnel address inside WG_NET (host octet range checked separately). */
export const IP_RE = new RegExp(`^${NET_RE_SRC}\\.(\\d{1,3})$`);

export function isValidWgIp(ip: string): boolean {
  const m = IP_RE.exec(ip);
  if (!m) return false;
  const octet = parseInt(m[1], 10);
  return octet >= WG_IP_START && octet <= WG_IP_END;
}

export interface DesiredPeer {
  name: string;
  pubkey: string;
  ip: string;
  active: boolean;
}

/** Host octets of every AllowedIPs entry in WG_NET found in a conf. */
export function parseConfIps(conf: string): number[] {
  const re = new RegExp(`AllowedIPs\\s*=\\s*${NET_RE_SRC}\\.(\\d{1,3})\\/32`, "g");
  const out: number[] = [];
  for (const m of conf.matchAll(re)) out.push(parseInt(m[1], 10));
  return out;
}

export function renderPeerBlock(peer: DesiredPeer): string {
  return [
    `${BEGIN_MARKER}${peer.name}`,
    `[Peer]`,
    `# ${peer.name}`,
    `PublicKey = ${peer.pubkey}`,
    `AllowedIPs = ${peer.ip}/32`,
    `${END_MARKER}${peer.name}`,
  ].join("\n");
}

/**
 * Strip every bot-managed peer block from a conf and append the desired set.
 *
 * Everything outside BEGIN/END markers — crucially the Ansible-managed [Interface]
 * section with its PrivateKey and TPROXY PostUp rules — is preserved byte for byte.
 * Trailing blank lines are collapsed so repeated syncs do not grow the file.
 */
export function renderConf(currentConf: string, desired: DesiredPeer[]): string {
  const kept: string[] = [];
  let inBlock = false;

  for (const line of currentConf.split("\n")) {
    if (line.startsWith(BEGIN_MARKER)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.startsWith(END_MARKER)) inBlock = false;
      continue;
    }
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();

  const parts = [kept.join("\n")];
  for (const peer of desired) parts.push(renderPeerBlock(peer));

  return parts.join("\n\n") + "\n";
}
