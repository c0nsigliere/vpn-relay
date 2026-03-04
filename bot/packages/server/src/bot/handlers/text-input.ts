import { MiddlewareFn } from "grammy";
import { v4 as uuidv4 } from "uuid";
import { BotContext } from "../context";
import { queries } from "../../db/queries";
import { xrayService } from "../../services/xray.service";
import { wgService } from "../../services/wg.service";
import { InputFile } from "grammy";

const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;

export const textInputHandler: MiddlewareFn<BotContext> = async (ctx, next) => {
  const step = ctx.session.step;
  const text = ctx.message?.text?.trim() ?? "";

  if (step === "awaiting_client_name") {
    if (!NAME_RE.test(text)) {
      await ctx.reply(
        "❌ Invalid name. Use only letters, digits, and underscores (max 32 chars). Try again:"
      );
      return;
    }

    if (queries.getClientByName(text)) {
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
      const id = uuidv4();
      let wgIp: string | null = null;
      let wgPubkey: string | null = null;
      let xrayUuid: string | null = null;

      if (clientType === "wg" || clientType === "both") {
        const wgResult = await wgService.addClient(text);
        wgIp = wgResult.ip;
        wgPubkey = wgResult.publicKey;

        // Send WG config immediately (only time private key is available)
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(wgResult.conf), `${text}.conf`),
          { caption: `🔐 WireGuard config for *${text}*\n⚠️ Save this — private key won't be shown again.`, parse_mode: "Markdown" }
        );
      }

      if (clientType === "xray" || clientType === "both") {
        xrayUuid = await xrayService.addClient(text);
        const uris = xrayService.generateVlessUris(text, xrayUuid);
        const uriText = [
          `⚡ *VLESS Config for ${text}*\n`,
          `*Direct:*\n\`${uris.direct}\`\n`,
          `*Via Relay:*\n\`${uris.relay}\`\n`,
          `_Import with Hiddify or Streisand app._`,
        ].join("\n");
        await ctx.reply(uriText, { parse_mode: "Markdown" });
      }

      queries.insertClient({
        id,
        name: text,
        type: clientType,
        wg_ip: wgIp,
        wg_pubkey: wgPubkey,
        xray_uuid: xrayUuid,
        expires_at: null,
        is_active: 1,
        daily_quota_gb: null,
        monthly_quota_gb: null,
        suspend_reason: null,
      });

      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `✅ *${text}* created.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `❌ Failed to create *${text}*: ${(err as Error).message}`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  await next();
};
