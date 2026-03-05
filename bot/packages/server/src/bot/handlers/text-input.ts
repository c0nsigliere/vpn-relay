import { MiddlewareFn } from "grammy";
import { BotContext } from "../context";
import { queries } from "../../db/queries";
import { createClient } from "../../services/client.service";
import { xrayService } from "../../services/xray.service";
import { InputFile } from "grammy";

const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;

export const textInputHandler: MiddlewareFn<BotContext> = async (ctx, next) => {
  const step = ctx.session.step;
  const text = ctx.message?.text?.trim() ?? "";

  if (step === "awaiting_client_name") {
    if (!NAME_RE.test(text)) {
      await ctx.reply(
        "Invalid name. Use only letters, digits, and underscores (max 32 chars). Try again:"
      );
      return;
    }

    if (queries.getClientByName(text)) {
      await ctx.reply("A client with that name already exists. Try a different name:");
      return;
    }

    const clientType = ctx.session.data.clientType ?? "xray";
    ctx.session.step = "idle";
    ctx.session.data = {};

    const statusMsg = await ctx.reply(`Creating *${text}* (${clientType.toUpperCase()})...`, {
      parse_mode: "Markdown",
    });

    try {
      const result = await createClient(text, clientType);

      if (result.wgConf) {
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(result.wgConf), `${text}.conf`),
          { caption: `WireGuard config for *${text}*\nSave this — private key won't be shown again.`, parse_mode: "Markdown" }
        );
      }

      if (result.xrayUris) {
        const uriText = [
          `*VLESS Config for ${text}*\n`,
          `*Direct:*\n\`${result.xrayUris.direct}\`\n`,
          `*Via Relay:*\n\`${result.xrayUris.relay}\`\n`,
          `_Import with Hiddify or Streisand app._`,
        ].join("\n");
        await ctx.reply(uriText, { parse_mode: "Markdown" });
      }

      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `*${text}* created.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `Failed to create *${text}*: ${(err as Error).message}`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  await next();
};
