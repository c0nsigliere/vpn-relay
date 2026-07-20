/**
 * The thin impure layer: picking the right URI generator for a client.
 *
 * This is the file that justifies the Hy2 fixtures in test/setup.ts —
 * hysteriaService.generateUris reads SINGBOX_OBFS_FILE synchronously and throws
 * without it.
 *
 * Note every relay here is null: setup.ts pins SERVER_A_HOST="" (standalone) so
 * tests never dial out. Cascade bodies are covered in subscription.service.test.ts,
 * which passes the URI pair in directly.
 */

import { describe, it, expect } from "vitest";
import { clientUriPair, subscriptionUrl, subscriptionsAvailable } from "./subscription.service";
import type { Client } from "@vpn-relay/shared";

function client(over: Partial<Client> = {}): Client {
  return {
    id: "id-1",
    name: "alice",
    type: "xray",
    wg_ip: null,
    wg_pubkey: null,
    xray_uuid: "11111111-2222-3333-4444-555555555555",
    hy2_password: null,
    created_at: "2026-01-01 00:00:00",
    expires_at: null,
    is_active: 1,
    last_seen_at: null,
    daily_quota_gb: null,
    monthly_quota_gb: null,
    suspend_reason: null,
    last_ip: null,
    last_ip_isp: null,
    last_connection_route: null,
    wg_cascade_transport: "xray",
    sub_token: "TOKEN",
    ...over,
  };
}

describe("clientUriPair", () => {
  it("builds VLESS URIs for an xray client", () => {
    const pair = clientUriPair(client())!;
    expect(pair.direct).toMatch(/^vless:\/\//);
    expect(pair.direct).toContain("11111111-2222-3333-4444-555555555555");
    expect(pair.relay).toBeNull(); // standalone test env
  });

  it("builds VLESS URIs for a 'both' client", () => {
    expect(clientUriPair(client({ type: "both" }))!.direct).toMatch(/^vless:\/\//);
  });

  it("builds Hysteria 2 URIs for a hysteria2 client", () => {
    const pair = clientUriPair(
      client({ type: "hysteria2", xray_uuid: null, hy2_password: "secretpw" })
    )!;
    expect(pair.direct).toMatch(/^hysteria2:\/\//);
    expect(pair.direct).toContain("obfs=salamander");
    expect(pair.relay).toBeNull();
  });

  it("returns null for a wg-only client", () => {
    expect(clientUriPair(client({ type: "wg", xray_uuid: null }))).toBeNull();
  });

  it("returns null for a malformed row missing its credential", () => {
    expect(clientUriPair(client({ type: "xray", xray_uuid: null }))).toBeNull();
    expect(
      clientUriPair(client({ type: "hysteria2", xray_uuid: null, hy2_password: null }))
    ).toBeNull();
  });
});

describe("subscriptionUrl", () => {
  it("builds the link for a capable client with a token", () => {
    expect(subscriptionUrl(client())).toBe("https://tma.test.example:8444/sub/TOKEN");
  });

  it("returns null when the client has no token", () => {
    expect(subscriptionUrl(client({ sub_token: null }))).toBeNull();
  });

  it("returns null for a non-capable client even if a token was somehow set", () => {
    expect(subscriptionUrl(client({ type: "wg", xray_uuid: null }))).toBeNull();
  });
});

describe("subscriptionsAvailable", () => {
  it("is true when a public origin is configured", () => {
    expect(subscriptionsAvailable()).toBe(true);
  });
});
