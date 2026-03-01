"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateInitData = validateInitData;
exports.tmaAuthMiddleware = tmaAuthMiddleware;
const crypto_1 = require("crypto");
const env_1 = require("../../config/env");
/**
 * Validates Telegram Mini App initData per:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get("hash");
        if (!hash)
            return null;
        // Build data-check-string: sorted key=value pairs (excluding hash), joined by \n
        params.delete("hash");
        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join("\n");
        // Secret key = HMAC-SHA256(bot_token, "WebAppData")
        const secretKey = (0, crypto_1.createHmac)("sha256", "WebAppData")
            .update(env_1.env.BOT_TOKEN)
            .digest();
        // Computed hash
        const expectedHash = (0, crypto_1.createHmac)("sha256", secretKey)
            .update(dataCheckString)
            .digest("hex");
        if (expectedHash !== hash)
            return null;
        // Check auth_date not older than 1 hour
        const authDate = parseInt(params.get("auth_date") ?? "0", 10);
        if (Date.now() / 1000 - authDate > 3600)
            return null;
        // Extract user id
        const userRaw = params.get("user");
        if (!userRaw)
            return null;
        const user = JSON.parse(userRaw);
        return { userId: user.id };
    }
    catch {
        return null;
    }
}
async function tmaAuthMiddleware(request, reply) {
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
    if (result.userId !== env_1.env.ADMIN_ID) {
        reply.code(403).send({ error: "Forbidden" });
        return;
    }
}
//# sourceMappingURL=tma-auth.js.map