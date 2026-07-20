import { randomBytes } from "crypto";

/**
 * Generate a subscription capability token: 192 bits of entropy rendered as 32
 * URL-safe characters.
 *
 * This lives in its own leaf module — rather than on subscription.service — so
 * that db/index.ts can mint tokens during the startup backfill. db/index.ts
 * cannot import from services/, because services/* -> db/queries -> db/index is
 * an existing import cycle.
 *
 * 192 bits makes the token unguessable, which is what lets GET /sub/<token> be
 * an unauthenticated capability URL with no rate limiting. The flip side: anyone
 * holding it can read the client's full credentials, so it must never be logged.
 */
export function generateSubToken(): string {
  return randomBytes(24).toString("base64url");
}
