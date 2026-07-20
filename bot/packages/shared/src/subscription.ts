// ─── Subscription (GET /sub/<token>) ────────────────────────────────────────
//
// This module is deliberately dependency-free and runtime-safe in BOTH the
// browser bundle and Node. It is the one place the "is this client
// subscription-capable?" question is answered, because three very different
// call sites need the identical answer and must never drift:
//
//   1. db/index.ts       — the startup backfill (cannot import services/:
//                          services/* -> db/queries -> db/index is a cycle)
//   2. server services   — token minting, the /sub route, the bot card
//   3. packages/web      — gating the TMA client screen (cannot import server code)
//
// Anything needing Buffer (base64 body/header assembly) lives in the server's
// services/subscription.service.ts instead — Buffer is not available in the browser.

import type { Client } from "./types";

/** The direct/relay URI pair both URI generators return. Relay is null in standalone mode. */
export interface SubUriPair {
  direct: string;
  relay: string | null;
}

/** Usage counters for the Subscription-Userinfo header, in bytes. */
export interface SubUsage {
  dailyUsedBytes: number;
  monthlyUsedBytes: number;
}

/**
 * Whether a client can be represented as a subscription at all.
 *
 * Stricter than `type !== 'wg'` on purpose: a malformed or imported row with
 * type='xray' but no xray_uuid (or type='hysteria2' with no hy2_password) would
 * otherwise produce a broken/empty subscription. WireGuard is excluded by
 * construction — it has no reproducible URI, only a one-time .conf whose private
 * key is shown at creation and never stored.
 *
 * Takes a narrow shape rather than a full Client because it is called before the
 * DB row exists (createClient) and over partial SELECTs (the backfill).
 */
export function isSubscriptionCapable(
  c: Pick<Client, "type" | "xray_uuid" | "hy2_password">
): boolean {
  if (c.type === "xray" || c.type === "both") return !!c.xray_uuid;
  if (c.type === "hysteria2") return !!c.hy2_password;
  return false;
}
