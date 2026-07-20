/**
 * Subscription routes.
 *
 * This file holds TWO plugins with deliberately different auth postures, kept
 * side by side so the asymmetry reads as a decision rather than an oversight:
 *
 *   subscriptionRoutes — PUBLIC. GET/HEAD /sub/:token, no auth hook.
 *   clientSubRoutes    — authed. The admin-facing management endpoints.
 *
 * Fastify's per-register encapsulation guarantees clientSubRoutes' preHandler
 * cannot leak into subscriptionRoutes, so co-locating them is safe.
 *
 * Why the public one is safe: the token is a 192-bit unguessable capability URL,
 * and the body it returns grants no access by itself — the data plane is what
 * gates connections. VPN client apps cannot produce Telegram initData, so an
 * authenticated subscription endpoint is a contradiction in terms.
 */

import { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import { queries } from "../../db/queries";
import { tmaAuthMiddleware } from "../middleware/tma-auth";
import { env } from "../../config/env";
import { createLogger } from "../../utils/logger";
import {
  resolveSubResponse,
  subscriptionUrl,
  isSubscriptionCapable,
} from "../../services/subscription.service";
import {
  ensureSubToken,
  rotateSubToken,
  sendSubLinkToChat,
} from "../../services/client.service";
import type { BotContext } from "../../bot/context";
import type { SubInfoResponse, SubRotateResponse } from "@vpn-relay/shared";

const logger = createLogger("subscription");

// ─── Public: GET/HEAD /sub/:token — NO tmaAuthMiddleware (intentional) ──────

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  // NOTE: no app.addHook("preHandler", tmaAuthMiddleware) here, unlike every
  // other route plugin. That omission IS the design — see the file header.

  /**
   * Resolve a token to its response payload.
   *
   * Returns null for both "no such token" and "token belongs to a row that
   * cannot be represented" (wg-only, or a malformed row missing its credential).
   * Both collapse to 404: emitting an empty or broken subscription would leave a
   * client's app showing a successful update to an unusable profile.
   */
  function resolve(token: string) {
    const client = queries.getClientBySubToken(token);
    if (!client) return null;
    if (!isSubscriptionCapable(client)) return null;
    return resolveSubResponse(client);
  }

  // The 404 body is a constant. It must never echo the token back — that would
  // put the credential into logs and error trackers on every stray request.
  function notFound(reply: import("fastify").FastifyReply) {
    return reply
      .code(404)
      .header("Cache-Control", "no-store")
      .type("text/plain; charset=utf-8")
      .send("Not found");
  }

  /**
   * HEAD is declared explicitly because Hiddify fetches quota/expiry via HEAD,
   * so it is part of the contract and carries its own test.
   *
   * Fastify v4 would otherwise auto-generate a HEAD sibling from the GET
   * (exposeHeadRoutes defaults to true) which reuses the GET handler and strips
   * the body — verified working on 4.29.1. An explicit HEAD takes precedence
   * over the auto-generated one regardless of declaration order, so the two
   * handlers below can be reordered safely; the explicit route exists so the
   * behaviour is pinned and cannot regress if that default ever changes.
   */
  app.head<{ Params: { token: string } }>("/sub/:token", async (req, reply) => {
    try {
      const payload = resolve(req.params.token);
      if (!payload) return notFound(reply);
      for (const [k, v] of Object.entries(payload.headers)) reply.header(k, v);
      return reply.send();
    } catch (err) {
      logger.error(`HEAD /sub failed: ${(err as Error).message}`);
      return reply.code(500).type("text/plain; charset=utf-8").send("Internal error");
    }
  });

  app.get<{ Params: { token: string } }>("/sub/:token", async (req, reply) => {
    try {
      const payload = resolve(req.params.token);
      if (!payload) return notFound(reply);
      for (const [k, v] of Object.entries(payload.headers)) reply.header(k, v);
      return reply.send(payload.body);
    } catch (err) {
      // The URI generators read Reality/obfs key material from disk. A missing
      // key file must surface as a 500, not an unhandled rejection — and the
      // message must not leak paths to an unauthenticated caller.
      logger.error(`GET /sub failed: ${(err as Error).message}`);
      return reply.code(500).type("text/plain; charset=utf-8").send("Internal error");
    }
  });
}

// ─── Authed: admin-facing subscription management ───────────────────────────

export async function clientSubRoutes(
  app: FastifyInstance,
  opts: { bot: Bot<BotContext> }
): Promise<void> {
  const bot = opts.bot;
  app.addHook("preHandler", tmaAuthMiddleware);

  /** Never returns the raw token — the UI needs the URL, nothing more. */
  function info(client: Parameters<typeof subscriptionUrl>[0]): SubInfoResponse {
    return { capable: isSubscriptionCapable(client), url: subscriptionUrl(client) };
  }

  // GET /api/clients/:id/sub — current link state.
  app.get<{ Params: { id: string } }>("/api/clients/:id/sub", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    // Not capable is an expected state the UI renders, not an error.
    if (!isSubscriptionCapable(client)) {
      return reply.send({ capable: false, url: null } satisfies SubInfoResponse);
    }
    return reply.send(info(ensureSubToken(client)));
  });

  // POST /api/clients/:id/sub/rotate — invalidate the link, issue a new one.
  app.post<{ Params: { id: string } }>("/api/clients/:id/sub/rotate", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    try {
      const { client: rotated } = rotateSubToken(client);
      return reply.send(info(rotated));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/clients/:id/sub/send — push the link + QR to the admin chat.
  app.post<{ Params: { id: string } }>("/api/clients/:id/sub/send", async (req, reply) => {
    const client = queries.getClientById(req.params.id);
    if (!client) return reply.code(404).send({ error: "Client not found" });

    try {
      await sendSubLinkToChat(bot, env.ADMIN_ID, ensureSubToken(client));
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/clients/:id/sub/rotate-and-send
   *
   * Rotation is destructive and irreversible: the moment it succeeds, the old
   * link is dead. If the Telegram delivery then failed and we returned an error,
   * the admin would be left with no way to reach the NEW link — the worst
   * possible outcome of a button labelled "regenerate".
   *
   * So the new URL is returned either way, and `sent` reports the delivery
   * separately for the UI to surface.
   */
  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/sub/rotate-and-send",
    async (req, reply) => {
      const client = queries.getClientById(req.params.id);
      if (!client) return reply.code(404).send({ error: "Client not found" });

      let rotated;
      try {
        ({ client: rotated } = rotateSubToken(client));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }

      let sent = true;
      try {
        await sendSubLinkToChat(bot, env.ADMIN_ID, rotated, { rotated: true });
      } catch (err) {
        sent = false;
        logger.error(`Rotated link for "${client.name}" but delivery failed: ${(err as Error).message}`);
      }

      return reply.send({ ...info(rotated), sent } satisfies SubRotateResponse);
    }
  );
}
