/**
 * SubscriptionService — assembles the body and headers of GET /sub/<token>.
 *
 * The endpoint DELIVERS CONFIGURATION; it does not grant access. Access is gated
 * on the data plane: a suspended client is absent from /etc/xray/config.json,
 * /etc/sing-box/config.json and Server A's WG peer set. That is what makes it
 * safe to return a suspended client's URIs with HTTP 200 — the app can then show
 * the real reason (quota exhausted / expired) instead of a bare "update failed",
 * and service resumes silently on the next poll once the admin lifts the block.
 *
 * ── Layering ────────────────────────────────────────────────────────────────
 * The pure functions take the URI pair and the usage counters as ARGUMENTS and
 * never reach for env, fs, or the DB. That is deliberate and load-bearing for
 * testability: the test environment pins SERVER_A_HOST="" (standalone), so the
 * real generators can only ever produce relay=null. Passing the pair in is what
 * lets a unit test assert the two-line cascade body at all.
 *
 * The impure wrappers below them are plumbing with no branching worth testing.
 */

import { queries } from "../db/queries";
import { env } from "../config/env";
import { xrayService } from "./xray.service";
import { hysteriaService } from "./hysteria.service";
import { isSubscriptionCapable } from "@vpn-relay/shared";
import type { Client, SubUriPair, SubUsage } from "@vpn-relay/shared";

export { isSubscriptionCapable };
export { generateSubToken } from "../utils/sub-token";

const GIB = 1_073_741_824;

export interface SubResponsePayload {
  uris: string[];
  /** base64 of uris.join("\n") — the v2rayN/Hiddify/Streisand de-facto standard. */
  body: string;
  headers: Record<string, string>;
}

/** Quota fields the header needs. Narrow on purpose so tests can pass literals. */
type SubHeaderClient = Pick<
  Client,
  "name" | "is_active" | "suspend_reason" | "expires_at" | "daily_quota_gb" | "monthly_quota_gb"
>;

// ─── Pure ───────────────────────────────────────────────────────────────────

/**
 * Direct first, relay second.
 *
 * On a healthy link the direct route is lower latency; the relay is the
 * DPI-resilience fallback. Apps that pick "first working" therefore get the
 * better path by default, while both remain available for manual choice.
 */
export function buildSubBody(uris: SubUriPair): { uris: string[]; body: string } {
  const list = [uris.direct];
  if (uris.relay) list.push(uris.relay);
  return { uris: list, body: Buffer.from(list.join("\n"), "utf8").toString("base64") };
}

/**
 * Subscription-Userinfo, per the de-facto convention.
 *
 * The header renders as ONE used/total bar, so it must report one quota together
 * with its own period's usage — mixing a monthly total with daily usage produces
 * a bar that is simply a lie. When both quotas are set we report the MONTHLY plan:
 * that is the billing-period notion apps expect, whereas the daily cap is a rate
 * limiter rather than a plan size, and the two cannot be co-displayed honestly.
 */
export function buildSubscriptionUserinfo(
  client: SubHeaderClient,
  usage: SubUsage,
  nowMs: number
): string {
  let download: number;
  let total: number;

  if (client.monthly_quota_gb != null) {
    download = usage.monthlyUsedBytes;
    total = Math.round(client.monthly_quota_gb * GIB);
  } else if (client.daily_quota_gb != null) {
    download = usage.dailyUsedBytes;
    total = Math.round(client.daily_quota_gb * GIB);
  } else {
    // total=0 is how apps encode "unlimited". Month-to-date usage is still shown
    // as an informational "traffic so far".
    download = usage.monthlyUsedBytes;
    total = 0;
  }

  const suspended = client.is_active === 0;

  // A quota-suspended client should read as 100% consumed, not as "some left but
  // mysteriously offline".
  if (
    suspended &&
    (client.suspend_reason === "daily_quota" || client.suspend_reason === "monthly_quota") &&
    total > 0
  ) {
    download = total;
  }

  // We meter combined traffic, so reporting it all under `download` keeps the bar
  // honest against `total` rather than splitting it arbitrarily.
  const parts = [`upload=0`, `download=${Math.round(download)}`, `total=${total}`];

  if (suspended) {
    // Render as expired regardless of cause — the honest "you are blocked" signal.
    parts.push(`expire=${Math.floor(nowMs / 1000) - 1}`);
  } else if (client.expires_at) {
    // Account TTL, NOT a quota-reset date: apps that treat `expire` as a reset
    // would misreport, so keep it to the safe, common interpretation.
    parts.push(`expire=${Math.floor(Date.parse(client.expires_at) / 1000)}`);
  }
  // No expires_at and active → omit the segment entirely. Emitting expire=0 is
  // ambiguous: some apps read it as "never", others as "expired now".

  return parts.join("; ");
}

/** Filesystem-safe label for the Content-Disposition filename. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.length > 0 ? cleaned : "subscription";
}

export function buildSubResponse(
  client: SubHeaderClient,
  uris: SubUriPair,
  usage: SubUsage,
  nowMs: number = Date.now()
): SubResponsePayload {
  const { uris: list, body } = buildSubBody(uris);

  return {
    uris: list,
    body,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Subscription-Userinfo": buildSubscriptionUserinfo(client, usage, nowMs),
      // The `base64:` prefix is the Hiddify / XTLS convention — a literal marker
      // followed by base64, NOT raw base64.
      "Profile-Title": `base64:${Buffer.from(client.name, "utf8").toString("base64")}`,
      // Best-effort hint asking apps to re-poll daily. Support is uneven (v2rayNG
      // closed it as not-planned), so nothing may depend on it for propagation.
      "Profile-Update-Interval": "24",
      "Content-Disposition": `attachment; filename=${safeFilename(client.name)}.txt`,
      // Set at the ORIGIN so they hold on every path — including when the request
      // arrives via Server A's L4 fallback during a DPI incident, where nginx on B
      // is still the terminator but the vhost config is not in the loop.
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  };
}

/** null when there is no public origin configured (TMA_URL unset). */
export function buildSubUrl(base: string | undefined, token: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/+$/, "")}/sub/${token}`;
}

// ─── Impure (thin plumbing over the pure core) ──────────────────────────────

/** Selects the URI generator by client type. null when not subscription-capable. */
export function clientUriPair(client: Client): SubUriPair | null {
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    return xrayService.generateVlessUris(client.name, client.xray_uuid);
  }
  if (client.type === "hysteria2" && client.hy2_password) {
    return hysteriaService.generateUris(client.name, client.hy2_password);
  }
  return null;
}

/** Full payload for the route. null when the client cannot be represented. */
export function resolveSubResponse(client: Client): SubResponsePayload | null {
  const uris = clientUriPair(client);
  if (!uris) return null;

  return buildSubResponse(client, uris, {
    dailyUsedBytes: queries.getClientDailyUsageBytes(client.id),
    monthlyUsedBytes: queries.getClientMonthlyUsageBytes(client.id),
  });
}

/** The link shown in the bot card and the TMA. null when unavailable. */
export function subscriptionUrl(client: Client): string | null {
  if (!client.sub_token || !isSubscriptionCapable(client)) return null;
  return buildSubUrl(env.TMA_URL, client.sub_token);
}

/** Whether this deployment can serve subscriptions at all (needs a public origin). */
export function subscriptionsAvailable(): boolean {
  return !!env.TMA_URL;
}
