import { MiddlewareFn } from "grammy";
import { BotContext } from "../context";
import { queries } from "../../db/queries";
import { createClient } from "../../services/client.service";
import { xrayService } from "../../services/xray.service";
import { qrService } from "../../services/qr.service";
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
    const wgTransport = ctx.session.data.wgCascadeTransport ?? "xray";
    ctx.session.step = "idle";
    ctx.session.data = {};

    const baseLabel = clientType === "hysteria2" ? "Hysteria 2" : clientType.toUpperCase();
    const typeLabel =
      (clientType === "wg" || clientType === "both") && wgTransport === "hy2"
        ? `${baseLabel} via Hy2`
        : baseLabel;
    const statusMsg = await ctx.reply(`Creating *${text}* (${typeLabel})...`, {
      parse_mode: "Markdown",
    });

    try {
      const result = await createClient(text, clientType, undefined, undefined, undefined, wgTransport);

      if (result.wgConf) {
        await ctx.replyWithDocument(
          new InputFile(Buffer.from(result.wgConf), `${text}.conf`),
          { caption: `WireGuard config for *${text}*\nSave this — private key won't be shown again.`, parse_mode: "Markdown" }
        );
      }

      if (result.xrayUris) {
        const { direct, relay } = result.xrayUris;
        const lines = [`*VLESS Config for ${text}*\n`];
        if (relay) {
          lines.push(`*Direct:*\n\`${direct}\`\n`);
          lines.push(`*Via Relay:*\n\`${relay}\`\n`);
        } else {
          lines.push(`\`${direct}\`\n`);
        }
        lines.push(`_Import with Hiddify or Streisand app._`);
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      }

      if (result.hy2Uris) {
        const { direct, relay } = result.hy2Uris;
        const lines = [`*Hysteria 2 Config for ${text}*\n`];
        if (relay) {
          lines.push(`*Direct:*\n\`${direct}\`\n`);
          lines.push(`*Via Relay:*\n\`${relay}\`\n`);
        } else {
          lines.push(`\`${direct}\`\n`);
        }
        lines.push(`_Import with Hiddify, NekoBox or Streisand app._`);
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });

        await ctx.replyWithPhoto(
          new InputFile(await qrService.generate(direct), "hy2-direct-qr.png"),
          { caption: `QR: ${text}${relay ? " (Direct)" : " (Hysteria 2)"}` }
        );
        if (relay) {
          await ctx.replyWithPhoto(
            new InputFile(await qrService.generate(relay), "hy2-relay-qr.png"),
            { caption: `QR: ${text} (Via Relay)` }
          );
        }
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
