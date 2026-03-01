import { createHmac } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../../config/env";

/**
 * Validates Telegram Mini App initData per:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string): { userId: number } | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    // Build data-check-string: sorted key=value pairs (excluding hash), joined by \n
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // Secret key = HMAC-SHA256(bot_token, "WebAppData")
    const secretKey = createHmac("sha256", "WebAppData")
      .update(env.BOT_TOKEN)
      .digest();

    // Computed hash
    const expectedHash = createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (expectedHash !== hash) return null;

    // Check auth_date not older than 1 hour
    const authDate = parseInt(params.get("auth_date") ?? "0", 10);
    if (Date.now() / 1000 - authDate > 3600) return null;

    // Extract user id
    const userRaw = params.get("user");
    if (!userRaw) return null;
    const user = JSON.parse(userRaw) as { id: number };
    return { userId: user.id };
  } catch {
    return null;
  }
}

export async function tmaAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const auth = request.headers.authorization ?? "";
  if (!auth.startsWith("tma ")) {
    reply.code(401).send({ error: "Missing TMA authorization" });
    return;
  }

  const initData = auth.slice(4);
  const result = validateInitData(initData);

  if (!result) {
    reply.code(401).send({ error: "Invalid initData" });
    return;
  }

  if (result.userId !== env.ADMIN_ID) {
    reply.code(403).send({ error: "Forbidden" });
    return;
  }
}
