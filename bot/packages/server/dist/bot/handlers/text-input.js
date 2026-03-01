"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.textInputHandler = void 0;
const uuid_1 = require("uuid");
const queries_1 = require("../../db/queries");
const xray_service_1 = require("../../services/xray.service");
const wg_service_1 = require("../../services/wg.service");
const grammy_1 = require("grammy");
const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;
const textInputHandler = async (ctx, next) => {
    const step = ctx.session.step;
    const text = ctx.message?.text?.trim() ?? "";
    if (step === "awaiting_client_name") {
        if (!NAME_RE.test(text)) {
            await ctx.reply("❌ Invalid name. Use only letters, digits, and underscores (max 32 chars). Try again:");
            return;
        }
        if (queries_1.queries.getClientByName(text)) {
            await ctx.reply("❌ A client with that name already exists. Try a different name:");
            return;
        }
        const clientType = ctx.session.data.clientType ?? "xray";
        ctx.session.step = "idle";
        ctx.session.data = {};
        const statusMsg = await ctx.reply(`⏳ Creating *${text}* (${clientType.toUpperCase()})...`, {
            parse_mode: "Markdown",
        });
        try {
            const id = (0, uuid_1.v4)();
            let wgIp = null;
            let wgPubkey = null;
            let xrayUuid = null;
            if (clientType === "wg" || clientType === "both") {
                const wgResult = await wg_service_1.wgService.addClient(text);
                wgIp = wgResult.ip;
                wgPubkey = wgResult.publicKey;
                // Send WG config immediately (only time private key is available)
                await ctx.replyWithDocument(new grammy_1.InputFile(Buffer.from(wgResult.conf), `${text}.conf`), { caption: `🔐 WireGuard config for *${text}*\n⚠️ Save this — private key won't be shown again.`, parse_mode: "Markdown" });
            }
            if (clientType === "xray" || clientType === "both") {
                xrayUuid = await xray_service_1.xrayService.addClient(text);
                const uris = xray_service_1.xrayService.generateVlessUris(text, xrayUuid);
                const uriText = [
                    `⚡ *VLESS Config for ${text}*\n`,
                    `*Direct:*\n\`${uris.direct}\`\n`,
                    `*Via Relay:*\n\`${uris.relay}\`\n`,
                    `_Import with Hiddify or Streisand app._`,
                ].join("\n");
                await ctx.reply(uriText, { parse_mode: "Markdown" });
            }
            queries_1.queries.insertClient({
                id,
                name: text,
                type: clientType,
                wg_ip: wgIp,
                wg_pubkey: wgPubkey,
                xray_uuid: xrayUuid,
                expires_at: null,
                is_active: 1,
            });
            await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ *${text}* created.`, { parse_mode: "Markdown" });
        }
        catch (err) {
            await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `❌ Failed to create *${text}*: ${err.message}`, { parse_mode: "Markdown" });
        }
        return;
    }
    await next();
};
exports.textInputHandler = textInputHandler;
//# sourceMappingURL=text-input.js.map