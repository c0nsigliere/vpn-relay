import { describe, expect, it } from "vitest";
import {
  DesiredPeer,
  isValidWgIp,
  NAME_RE,
  PUBKEY_RE,
  parseConfIps,
  renderConf,
  renderPeerBlock,
} from "./wg.conf";

/** Byte-exact copy of Heisenberg A's live wg-clients.conf interface section. */
const LIVE_CONF = `# /etc/wireguard/wg-clients.conf
# Managed by Ansible wg_cascade role (roles/wg_cascade/tasks/configs.yml)
# DO NOT manually edit the [Interface] section.
# Client peers are managed by playbooks/add_wg_client.yml.

[Interface]
Address    = 10.66.0.1/24
ListenPort = 51888
PrivateKey = +JIkiRg1N2vp4UcF/Kpw8FjLr1+R9WXBP0M5osiJfUc=

# TPROXY routing: packets marked 0x1 are delivered locally to XRay
PostUp  = sysctl -w net.ipv4.conf.wg-clients.rp_filter=0
PostUp  = ip rule add fwmark 0x1/0x1 table 100 priority 100 2>/dev/null || true
PostUp  = ip route replace local 0.0.0.0/0 dev lo table 100 2>/dev/null || true
PreDown = ip rule del fwmark 0x1/0x1 table 100 priority 100 2>/dev/null || true
PreDown = ip route del local 0.0.0.0/0 dev lo table 100 2>/dev/null || true

# Client peers are appended below by add_wg_client.yml (blockinfile markers).
# Each peer block is wrapped: # BEGIN CLIENT <name> ... # END CLIENT <name>

# BEGIN CLIENT LgTvOled
[Peer]
# LgTvOled
PublicKey = 7lCka23hDzViR/dt6xzcD645ZdL3OCDCm7yxp6h4JDw=
AllowedIPs = 10.66.0.2/32
# END CLIENT LgTvOled
`;

const LGTV: DesiredPeer = {
  name: "LgTvOled",
  pubkey: "7lCka23hDzViR/dt6xzcD645ZdL3OCDCm7yxp6h4JDw=",
  ip: "10.66.0.2",
  active: true,
};
const SECOND: DesiredPeer = {
  name: "Laptop",
  pubkey: "AbCd1234AbCd1234AbCd1234AbCd1234AbCd1234Ab8=",
  ip: "10.66.0.3",
  active: true,
};

describe("renderConf preserves the Ansible-managed interface", () => {
  it("keeps the [Interface] section byte for byte", () => {
    const out = renderConf(LIVE_CONF, [LGTV]);
    const head = (s: string) => s.slice(0, s.indexOf("# BEGIN CLIENT"));
    expect(head(out)).toBe(head(LIVE_CONF));
  });

  it("keeps the private key and every TPROXY rule", () => {
    const out = renderConf(LIVE_CONF, [LGTV]);
    expect(out).toContain("PrivateKey = +JIkiRg1N2vp4UcF/Kpw8FjLr1+R9WXBP0M5osiJfUc=");
    expect(out.match(/PostUp/g)).toHaveLength(3);
    expect(out.match(/PreDown/g)).toHaveLength(2);
    expect(out).toContain("ListenPort = 51888");
  });

  it("is idempotent — a synced node is never rewritten", () => {
    const once = renderConf(LIVE_CONF, [LGTV]);
    expect(renderConf(once, [LGTV])).toBe(once);
  });

  it("does not grow the file across repeated syncs", () => {
    let conf = LIVE_CONF;
    for (let i = 0; i < 5; i++) conf = renderConf(conf, [LGTV]);
    expect(conf.split("[Peer]")).toHaveLength(2); // exactly one peer
  });
});

describe("renderConf peer set", () => {
  it("removes every peer when the DB has none", () => {
    const out = renderConf(LIVE_CONF, []);
    expect(out).not.toContain("[Peer]");
    expect(out).not.toContain("LgTvOled");
    expect(out).toContain("[Interface]");
  });

  it("round-trips removal and re-add", () => {
    const emptied = renderConf(LIVE_CONF, []);
    expect(renderConf(emptied, [LGTV])).toBe(renderConf(LIVE_CONF, [LGTV]));
  });

  it("renders suspended clients too — the block records the IP allocation", () => {
    const out = renderConf(LIVE_CONF, [{ ...LGTV, active: false }]);
    expect(out).toContain("# BEGIN CLIENT LgTvOled");
    expect(out).toContain("AllowedIPs = 10.66.0.2/32");
  });

  it("adds a second peer without disturbing the first", () => {
    const out = renderConf(LIVE_CONF, [LGTV, SECOND]);
    expect(out).toContain("# BEGIN CLIENT LgTvOled");
    expect(out).toContain("# BEGIN CLIENT Laptop");
    expect(out.match(/\[Peer\]/g)).toHaveLength(2);
  });

  it("renames by regenerating the block — live state is keyed on the pubkey", () => {
    const out = renderConf(LIVE_CONF, [{ ...LGTV, name: "LivingRoomTv" }]);
    expect(out).toContain("# BEGIN CLIENT LivingRoomTv");
    expect(out).not.toContain("LgTvOled");
    expect(out).toContain(LGTV.pubkey); // same peer, same tunnel
  });
});

describe("row validation rejects hostile input", () => {
  it.each([
    ["shell metacharacters", "alpha; rm -rf /"],
    ["newline injection", "alpha\n[Peer]\nPublicKey = attacker"],
    ["command substitution", "$(id)"],
    ["backticks", "`whoami`"],
    ["too long", "x".repeat(33)],
    ["empty", ""],
    ["path traversal", "../../etc/passwd"],
  ])("rejects name with %s", (_label, name) => {
    expect(NAME_RE.test(name)).toBe(false);
  });

  it("accepts legitimate names", () => {
    for (const n of ["LgTvOled", "laptop_2", "A", "x".repeat(32)]) {
      expect(NAME_RE.test(n)).toBe(true);
    }
  });

  it.each([
    ["command substitution", "$(id)"],
    ["too short", "AbCd="],
    ["missing padding", "7lCka23hDzViR/dt6xzcD645ZdL3OCDCm7yxp6h4JDw"],
    ["newline", "7lCka23hDzViR/dt6xzcD645ZdL3OCDCm7yxp6h4JD=\nPublicKey = evil"],
  ])("rejects pubkey with %s", (_label, key) => {
    expect(PUBKEY_RE.test(key)).toBe(false);
  });

  it("accepts a real WireGuard pubkey", () => {
    expect(PUBKEY_RE.test(LGTV.pubkey)).toBe(true);
  });

  it.each([
    ["network address", "10.66.0.0"],
    ["server address", "10.66.0.1"],
    ["broadcast", "10.66.0.255"],
    ["out of range octet", "10.66.0.999"],
    ["wrong subnet", "10.66.1.5"],
    ["wrong network", "192.168.0.5"],
    ["with CIDR", "10.66.0.5/32"],
    ["injection", "10.66.0.5; wg set"],
  ])("rejects IP: %s", (_label, ip) => {
    expect(isValidWgIp(ip)).toBe(false);
  });

  it("accepts the allocatable range", () => {
    expect(isValidWgIp("10.66.0.2")).toBe(true);
    expect(isValidWgIp("10.66.0.254")).toBe(true);
  });
});

describe("parseConfIps", () => {
  it("extracts allocated host octets from a conf", () => {
    expect(parseConfIps(LIVE_CONF)).toEqual([2]);
    expect(parseConfIps(renderConf(LIVE_CONF, [LGTV, SECOND]))).toEqual([2, 3]);
  });

  it("ignores the interface Address (a /24, not a /32 AllowedIPs)", () => {
    expect(parseConfIps(LIVE_CONF)).not.toContain(1);
  });

  it("returns nothing for a peerless conf", () => {
    expect(parseConfIps(renderConf(LIVE_CONF, []))).toEqual([]);
  });
});

describe("renderPeerBlock", () => {
  it("emits the marker-wrapped shape the conf parser expects", () => {
    expect(renderPeerBlock(LGTV)).toBe(
      [
        "# BEGIN CLIENT LgTvOled",
        "[Peer]",
        "# LgTvOled",
        "PublicKey = 7lCka23hDzViR/dt6xzcD645ZdL3OCDCm7yxp6h4JDw=",
        "AllowedIPs = 10.66.0.2/32",
        "# END CLIENT LgTvOled",
      ].join("\n")
    );
  });
});
