/**
 * Pure-layer tests for the subscription body and headers.
 *
 * Everything here passes the URI pair and usage counters in as arguments, which
 * is why the cascade (direct + relay) cases are testable at all: setup.ts pins
 * SERVER_A_HOST="" process-wide, so the real generators can only ever return
 * relay=null. See subscription.uris.test.ts for the impure layer.
 */

import { describe, it, expect } from "vitest";
import {
  buildSubBody,
  buildSubResponse,
  buildSubscriptionUserinfo,
  buildSubUrl,
  generateSubToken,
  isSubscriptionCapable,
} from "./subscription.service";
import type { Client, SubUsage } from "@vpn-relay/shared";

const GIB = 1_073_741_824;
const NO_USAGE: SubUsage = { dailyUsedBytes: 0, monthlyUsedBytes: 0 };

const VLESS_DIRECT = "vless://uuid@203.0.113.1:443?security=reality#name_DE";
const VLESS_RELAY = "vless://uuid@198.51.100.1:443?security=reality#name_RU_DE";
const HY2_DIRECT = "hysteria2://pw@203.0.113.1:443/?obfs=salamander#name_DE";
const HY2_RELAY = "hysteria2://pw@198.51.100.1:443/?obfs=salamander#name_RU_DE";

type HeaderClient = Parameters<typeof buildSubResponse>[0];

function client(over: Partial<HeaderClient> = {}): HeaderClient {
  return {
    name: "alice",
    is_active: 1,
    suspend_reason: null,
    expires_at: null,
    daily_quota_gb: null,
    monthly_quota_gb: null,
    ...over,
  };
}

function decode(body: string): string[] {
  return Buffer.from(body, "base64").toString("utf8").split("\n");
}

function userinfo(c: HeaderClient, usage: SubUsage = NO_USAGE, nowMs = 1_700_000_000_000): string {
  return buildSubscriptionUserinfo(c, usage, nowMs);
}

/** Parse "upload=0; download=1; total=2" into a lookup. */
function fields(header: string): Record<string, string> {
  return Object.fromEntries(
    header.split(";").map((s) => {
      const [k, v] = s.trim().split("=");
      return [k, v];
    })
  );
}

// ─── isSubscriptionCapable ──────────────────────────────────────────────────

describe("isSubscriptionCapable", () => {
  const cases: Array<[string, Pick<Client, "type" | "xray_uuid" | "hy2_password">, boolean]> = [
    ["xray with uuid", { type: "xray", xray_uuid: "u", hy2_password: null }, true],
    ["xray without uuid", { type: "xray", xray_uuid: null, hy2_password: null }, false],
    ["both with uuid", { type: "both", xray_uuid: "u", hy2_password: null }, true],
    ["both without uuid", { type: "both", xray_uuid: null, hy2_password: null }, false],
    ["hysteria2 with password", { type: "hysteria2", xray_uuid: null, hy2_password: "p" }, true],
    ["hysteria2 without password", { type: "hysteria2", xray_uuid: null, hy2_password: null }, false],
    ["wg", { type: "wg", xray_uuid: null, hy2_password: null }, false],
    // WireGuard has no reproducible URI, so a stray credential must not make it capable.
    ["wg with a stray uuid", { type: "wg", xray_uuid: "u", hy2_password: null }, false],
  ];

  it.each(cases)("%s -> %s", (_label, input, expected) => {
    expect(isSubscriptionCapable(input)).toBe(expected);
  });
});

// ─── Body ───────────────────────────────────────────────────────────────────

describe("buildSubBody", () => {
  it("emits direct then relay on a cascade node", () => {
    const { uris, body } = buildSubBody({ direct: VLESS_DIRECT, relay: VLESS_RELAY });
    expect(uris).toEqual([VLESS_DIRECT, VLESS_RELAY]);
    expect(decode(body)).toEqual([VLESS_DIRECT, VLESS_RELAY]);
  });

  it("degrades to a single URI in standalone mode", () => {
    const { uris, body } = buildSubBody({ direct: VLESS_DIRECT, relay: null });
    expect(uris).toEqual([VLESS_DIRECT]);
    expect(decode(body)).toEqual([VLESS_DIRECT]);
  });

  it("handles Hysteria 2 in both modes", () => {
    expect(decode(buildSubBody({ direct: HY2_DIRECT, relay: HY2_RELAY }).body)).toEqual([
      HY2_DIRECT,
      HY2_RELAY,
    ]);
    expect(decode(buildSubBody({ direct: HY2_DIRECT, relay: null }).body)).toEqual([HY2_DIRECT]);
  });

  it("produces base64 that decodes back to the exact URIs", () => {
    const { body } = buildSubBody({ direct: HY2_DIRECT, relay: null });
    expect(body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(body, "base64").toString("utf8")).toBe(HY2_DIRECT);
  });
});

// ─── Subscription-Userinfo: quota period matching ───────────────────────────

describe("Subscription-Userinfo quota periods", () => {
  it("reports the monthly period when a monthly quota is set", () => {
    const f = fields(
      userinfo(client({ monthly_quota_gb: 100 }), {
        dailyUsedBytes: 1 * GIB,
        monthlyUsedBytes: 40 * GIB,
      })
    );
    expect(f.download).toBe(String(40 * GIB));
    expect(f.total).toBe(String(100 * GIB));
  });

  it("reports the DAILY period when only a daily quota is set", () => {
    // Regression guard: reporting monthly usage against a daily total would
    // render a bar that is simply wrong.
    const f = fields(
      userinfo(client({ daily_quota_gb: 5 }), {
        dailyUsedBytes: 2 * GIB,
        monthlyUsedBytes: 40 * GIB,
      })
    );
    expect(f.download).toBe(String(2 * GIB));
    expect(f.total).toBe(String(5 * GIB));
  });

  it("prefers the monthly plan when both quotas are set", () => {
    const usage = { dailyUsedBytes: 2 * GIB, monthlyUsedBytes: 40 * GIB };
    const f = fields(userinfo(client({ daily_quota_gb: 5, monthly_quota_gb: 100 }), usage));
    expect(f.total).toBe(String(100 * GIB));
    expect(f.download).toBe(String(40 * GIB));
    expect(f.download).not.toBe(String(2 * GIB)); // not the daily figure
  });

  it("reports total=0 (unlimited) with informational month-to-date usage", () => {
    const f = fields(userinfo(client(), { dailyUsedBytes: 1 * GIB, monthlyUsedBytes: 7 * GIB }));
    expect(f.total).toBe("0");
    expect(f.download).toBe(String(7 * GIB));
  });

  it("always reports upload=0", () => {
    expect(fields(userinfo(client())).upload).toBe("0");
  });

  it("emits integers for fractional GB quotas", () => {
    const header = userinfo(client({ monthly_quota_gb: 1.5 }));
    expect(fields(header).total).toBe(String(1_610_612_736));
    // A float anywhere in the header would be malformed.
    expect(header).not.toContain(".");
  });
});

// ─── Subscription-Userinfo: expiry and suspension ───────────────────────────

describe("Subscription-Userinfo expiry", () => {
  const now = 1_700_000_000_000;

  it("maps expires_at to unix seconds", () => {
    const expires = "2030-01-01T00:00:00.000Z";
    const f = fields(userinfo(client({ expires_at: expires }), NO_USAGE, now));
    expect(f.expire).toBe(String(Math.floor(Date.parse(expires) / 1000)));
  });

  it("omits expire entirely for an active client with no TTL", () => {
    // expire=0 is ambiguous across apps ("never" vs "expired now") — omission is safe.
    expect(userinfo(client(), NO_USAGE, now)).not.toContain("expire");
  });

  it("marks a suspended client expired regardless of cause", () => {
    const f = fields(
      userinfo(client({ is_active: 0, suspend_reason: "manual" }), NO_USAGE, now)
    );
    expect(Number(f.expire)).toBe(Math.floor(now / 1000) - 1);
  });

  it("shows 100% consumed when suspended by a quota", () => {
    for (const reason of ["daily_quota", "monthly_quota"] as const) {
      const f = fields(
        userinfo(
          client({ is_active: 0, suspend_reason: reason, monthly_quota_gb: 100 }),
          { dailyUsedBytes: 0, monthlyUsedBytes: 3 * GIB },
          now
        )
      );
      expect(f.download).toBe(f.total);
      expect(Number(f.expire)).toBe(Math.floor(now / 1000) - 1);
    }
  });

  it("leaves usage untouched for a manual suspend", () => {
    const f = fields(
      userinfo(
        client({ is_active: 0, suspend_reason: "manual", monthly_quota_gb: 100 }),
        { dailyUsedBytes: 0, monthlyUsedBytes: 3 * GIB },
        now
      )
    );
    expect(f.download).toBe(String(3 * GIB)); // NOT forced to total
    expect(Number(f.expire)).toBe(Math.floor(now / 1000) - 1);
  });

  it("leaves usage untouched for an abnormal-traffic suspend", () => {
    const f = fields(
      userinfo(
        client({ is_active: 0, suspend_reason: "abnormal_traffic", monthly_quota_gb: 100 }),
        { dailyUsedBytes: 0, monthlyUsedBytes: 3 * GIB },
        now
      )
    );
    expect(f.download).toBe(String(3 * GIB));
  });
});

// ─── Full response ──────────────────────────────────────────────────────────

describe("buildSubResponse headers", () => {
  const res = () =>
    buildSubResponse(client(), { direct: VLESS_DIRECT, relay: VLESS_RELAY }, NO_USAGE);

  it("prefixes Profile-Title with the literal base64: marker", () => {
    const title = res().headers["Profile-Title"];
    expect(title.startsWith("base64:")).toBe(true);
    expect(Buffer.from(title.slice("base64:".length), "base64").toString("utf8")).toBe("alice");
  });

  it("round-trips a non-ASCII name through Profile-Title", () => {
    const c = client({ name: "Алиса" });
    const title = buildSubResponse(c, { direct: VLESS_DIRECT, relay: null }, NO_USAGE)
      .headers["Profile-Title"];
    expect(Buffer.from(title.slice("base64:".length), "base64").toString("utf8")).toBe("Алиса");
  });

  it("sets the update-interval hint and the security headers", () => {
    const h = res().headers;
    expect(h["Profile-Update-Interval"]).toBe("24");
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["X-Robots-Tag"]).toBe("noindex");
    expect(h["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("names the download after the client", () => {
    expect(res().headers["Content-Disposition"]).toBe("attachment; filename=alice.txt");
  });

  it("sanitises a name that would break the filename", () => {
    const c = client({ name: "a b/c" });
    const h = buildSubResponse(c, { direct: VLESS_DIRECT, relay: null }, NO_USAGE).headers;
    expect(h["Content-Disposition"]).toBe("attachment; filename=a_b_c.txt");
  });

  it("carries the decodable body alongside the headers", () => {
    expect(decode(res().body)).toEqual([VLESS_DIRECT, VLESS_RELAY]);
  });
});

// ─── Token + URL ────────────────────────────────────────────────────────────

describe("generateSubToken", () => {
  it("produces 32 URL-safe characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSubToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });

  it("does not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSubToken());
    expect(seen.size).toBe(1000);
  });
});

describe("buildSubUrl", () => {
  it("builds the link from the public origin", () => {
    expect(buildSubUrl("https://tma.example:8444", "TOKEN")).toBe(
      "https://tma.example:8444/sub/TOKEN"
    );
  });

  it("normalises a trailing slash", () => {
    expect(buildSubUrl("https://tma.example:8444/", "TOKEN")).toBe(
      "https://tma.example:8444/sub/TOKEN"
    );
  });

  it("returns null without a public origin", () => {
    // No domain configured → there is no usable link to show anywhere in the UI.
    expect(buildSubUrl(undefined, "TOKEN")).toBeNull();
    expect(buildSubUrl("", "TOKEN")).toBeNull();
  });
});
