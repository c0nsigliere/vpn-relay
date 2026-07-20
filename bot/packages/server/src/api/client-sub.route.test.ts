/**
 * Authed subscription management endpoints.
 *
 * initData is plain HMAC-SHA256 over the sorted params, and setup.ts supplies
 * BOT_TOKEN="0:test" / ADMIN_ID=1, so valid credentials can be minted here
 * without stubbing the middleware — which means the auth posture itself is under
 * test rather than assumed.
 */

import * as crypto from "crypto";
import Fastify, { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { clientSubRoutes } from "./routes/subscription";
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

/** Mint initData the real middleware will accept. */
function initData(userId = 1): string {
  const params: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  };
  const checkString = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN!).digest();
  const hash = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}

function auth(userId = 1) {
  return { authorization: `tma ${initData(userId)}` };
}

/** Telegram delivery double — `fail` makes sendPhoto/sendMessage reject. */
function fakeBot(fail = false) {
  const calls: string[] = [];
  const guard = async (name: string) => {
    calls.push(name);
    if (fail) throw new Error("telegram unreachable");
  };
  return {
    calls,
    api: {
      sendMessage: () => guard("sendMessage"),
      sendPhoto: () => guard("sendPhoto"),
    },
  } as never;
}

async function build(bot = fakeBot()): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(clientSubRoutes, { bot });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  seed({ id: "a1", name: "capable_client", sub_token: "TOKEN_A" });
  seed({ id: "a2", name: "no_token_yet" }); // capable, sub_token NULL
  seed({ id: "a3", name: "wg_client", type: "wg", xray_uuid: null });
  seed({ id: "a4", name: "rotates_client", sub_token: "TOKEN_OLD" });
  seed({ id: "a5", name: "rotate_send_fails", sub_token: "TOKEN_BEFORE" });
  app = await build();
});

afterAll(async () => {
  await app.close();
});

describe("auth", () => {
  it("401s without an Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients/a1/sub" });
    expect(res.statusCode).toBe(401);
  });

  it("401s on a forged hash", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients/a1/sub",
      headers: { authorization: "tma auth_date=1&user=%7B%22id%22%3A1%7D&hash=deadbeef" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("403s a valid non-admin user", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/clients/a1/sub",
      headers: auth(999),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/clients/:id/sub", () => {
  it("404s an unknown client", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients/nope/sub", headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("returns the link for a capable client", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients/a1/sub", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      capable: true,
      url: "https://tma.test.example:8444/sub/TOKEN_A",
    });
  });

  it("never returns the raw token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients/a1/sub", headers: auth() });
    expect(res.json()).not.toHaveProperty("token");
  });

  it("reports a wg client as not capable rather than erroring", async () => {
    const res = await app.inject({ method: "GET", url: "/api/clients/a3/sub", headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ capable: false, url: null });
  });

  it("lazily mints a token for a capable client that has none", async () => {
    expect(queries.getClientById("a2")!.sub_token).toBeNull();

    const res = await app.inject({ method: "GET", url: "/api/clients/a2/sub", headers: auth() });
    expect(res.statusCode).toBe(200);

    const minted = queries.getClientById("a2")!.sub_token;
    expect(minted).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.json().url).toBe(`https://tma.test.example:8444/sub/${minted}`);
  });
});

describe("POST /api/clients/:id/sub/rotate", () => {
  it("issues a new token and invalidates the old one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/a4/sub/rotate",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const token = queries.getClientById("a4")!.sub_token!;
    expect(token).not.toBe("TOKEN_OLD");
    expect(res.json().url).toBe(`https://tma.test.example:8444/sub/${token}`);
    expect(queries.getClientBySubToken("TOKEN_OLD")).toBeUndefined();
  });

  it("400s a client with nothing to subscribe to", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/a3/sub/rotate",
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/clients/:id/sub/rotate-and-send", () => {
  it("returns the new link even when Telegram delivery fails", async () => {
    // The whole point: rotation already destroyed the old link, so failing the
    // request here would strand the admin with no way to reach the new one.
    const failing = await build(fakeBot(true));
    try {
      const res = await failing.inject({
        method: "POST",
        url: "/api/clients/a5/sub/rotate-and-send",
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sent).toBe(false);

      const token = queries.getClientById("a5")!.sub_token!;
      expect(token).not.toBe("TOKEN_BEFORE");
      expect(res.json().url).toBe(`https://tma.test.example:8444/sub/${token}`);
    } finally {
      await failing.close();
    }
  });

  it("reports sent=true on success", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clients/a1/sub/rotate-and-send",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(true);
    expect(res.json().url).toBeTruthy();
  });
});
