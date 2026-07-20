/**
 * Public GET/HEAD /sub/:token.
 *
 * Registers the plugin on a bare Fastify instance rather than going through
 * buildApiServer: @fastify/static throws at register time when packages/web/dist
 * is missing, which is the normal state of a checkout that runs tests before it
 * builds. Testing the plugin directly keeps the suite independent of the web build.
 */

import Fastify, { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { subscriptionRoutes } from "./routes/subscription";
import { queries } from "../db/queries";

type InsertArg = Parameters<typeof queries.insertClient>[0];

function seed(over: Partial<InsertArg> & Pick<InsertArg, "id" | "name">): void {
  queries.insertClient({
    type: "xray",
    wg_ip: null,
    wg_pubkey: null,
    xray_uuid: `uuid-${over.id}`,
    hy2_password: null,
    expires_at: null,
    is_active: 1,
    daily_quota_gb: null,
    monthly_quota_gb: null,
    suspend_reason: null,
    wg_cascade_transport: "xray",
    sub_token: null,
    ...over,
  } as InsertArg);
}

let app: FastifyInstance;

beforeAll(async () => {
  seed({ id: "x1", name: "xray_client", sub_token: "TOKEN_XRAY" });
  seed({
    id: "h1",
    name: "hy2_client",
    type: "hysteria2",
    xray_uuid: null,
    hy2_password: "hy2secret",
    sub_token: "TOKEN_HY2",
  });
  // A wg-only row that somehow carries a token: must never serve a subscription.
  seed({ id: "w1", name: "wg_client", type: "wg", xray_uuid: null, sub_token: "TOKEN_WG" });
  seed({ id: "s1", name: "suspended_client", monthly_quota_gb: 50, sub_token: "TOKEN_SUSPENDED" });
  // Suspend via the real setter: insertClient's SQL does not carry suspend_reason
  // (it is in the type but absent from the column list), so seeding it inline
  // would silently leave the reason NULL.
  queries.setClientActive("s1", false, "monthly_quota");

  app = Fastify();
  // Registering must not throw — the plugin declares both HEAD and GET for the
  // same path alongside Fastify's exposeHeadRoutes default, and this is what
  // would catch that combination becoming a route conflict on a future upgrade.
  await app.register(subscriptionRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /sub/:token", () => {
  it("404s an unknown token", async () => {
    const res = await app.inject({ method: "GET", url: "/sub/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("does not echo the token back in the 404 body", async () => {
    const res = await app.inject({ method: "GET", url: "/sub/SECRET_TOKEN_VALUE" });
    expect(res.body).not.toContain("SECRET_TOKEN_VALUE");
  });

  it("404s a token attached to a wg-only client", async () => {
    // Never emit an empty or broken subscription.
    const res = await app.inject({ method: "GET", url: "/sub/TOKEN_WG" });
    expect(res.statusCode).toBe(404);
  });

  it("serves a decodable VLESS list", async () => {
    const res = await app.inject({ method: "GET", url: "/sub/TOKEN_XRAY" });
    expect(res.statusCode).toBe(200);

    const uris = Buffer.from(res.body, "base64").toString("utf8").split("\n");
    expect(uris).toHaveLength(1); // standalone test env → direct only
    expect(uris[0]).toMatch(/^vless:\/\//);
    expect(uris[0]).toContain("uuid-x1");
  });

  it("serves a Hysteria 2 list", async () => {
    const res = await app.inject({ method: "GET", url: "/sub/TOKEN_HY2" });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.body, "base64").toString("utf8")).toMatch(/^hysteria2:\/\//);
  });

  it("sets the subscription and security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/sub/TOKEN_XRAY" });
    expect(res.headers["subscription-userinfo"]).toMatch(/upload=0; download=\d+; total=\d+/);
    expect(res.headers["profile-title"]).toBe(
      `base64:${Buffer.from("xray_client").toString("base64")}`
    );
    expect(res.headers["profile-update-interval"]).toBe("24");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe("attachment; filename=xray_client.txt");
  });

  it("still returns 200 for a suspended client, marked exhausted", async () => {
    // The data plane already blocks the connection; 200 lets the app show WHY,
    // and lets service resume silently once the admin lifts the block.
    const res = await app.inject({ method: "GET", url: "/sub/TOKEN_SUSPENDED" });
    expect(res.statusCode).toBe(200);

    const info = res.headers["subscription-userinfo"] as string;
    const f = Object.fromEntries(
      info.split(";").map((s) => {
        const [k, v] = s.trim().split("=");
        return [k, v];
      })
    );
    expect(f.download).toBe(f.total); // quota suspend → 100% consumed
    expect(Number(f.expire)).toBeLessThan(Math.floor(Date.now() / 1000));
    expect(Buffer.from(res.body, "base64").toString("utf8")).toMatch(/^vless:\/\//);
  });
});

describe("HEAD /sub/:token", () => {
  it("returns the user-info headers with an empty body", async () => {
    // Hiddify fetches quota/expiry via HEAD.
    const res = await app.inject({ method: "HEAD", url: "/sub/TOKEN_XRAY" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    // Assert the headers that carry meaning — deliberately NOT a full diff
    // against GET, since an explicit HEAD legitimately differs on content-length.
    expect(res.headers["subscription-userinfo"]).toBeDefined();
    expect(res.headers["profile-title"]).toBeDefined();
    expect(res.headers["profile-update-interval"]).toBe("24");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });

  it("404s an unknown token", async () => {
    const res = await app.inject({ method: "HEAD", url: "/sub/nope" });
    expect(res.statusCode).toBe(404);
  });
});
