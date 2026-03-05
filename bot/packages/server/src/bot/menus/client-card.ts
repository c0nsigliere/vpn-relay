import { InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../context";
import { queries, Client } from "../../db/queries";
import { xrayService } from "../../services/xray.service";
import {
  suspendClient as doSuspend,
  resumeClient as doResume,
  deleteClient as doDelete,
} from "../../services/client.service";
import { chartsService } from "../../services/charts.service";
import { qrService } from "../../services/qr.service";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function clientSummary(c: Client): string {
  const status = c.is_active ? "Active" : "Suspended";
  const expiry = c.expires_at
    ? `\nExpires: ${c.expires_at.replace("T", " ").slice(0, 16)} UTC`
    : "";
  const type = c.type === "both" ? "WireGuard + XRay" : c.type.toUpperCase();
  return (
    `*${c.name}*\n` +
    `Type: ${type}\n` +
    `Status: ${status}${expiry}\n` +
    (c.wg_ip ? `IP: \`${c.wg_ip}\`` : "")
  );
}

function clientKeyboard(c: Client): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("Get Config", `card:config:${c.id}`)
    .text("Traffic Graph", `card:graph:${c.id}`)
    .row();

  if (c.is_active) {
    kb.text("Suspend", `card:suspend:${c.id}`);
  } else {
    kb.text("Resume", `card:resume:${c.id}`);
  }
  kb.text("Delete", `card:delete_confirm:${c.id}`).row();
  kb.text("Back", "menu:client_list");
  return kb;
}

export async function showClientCard(ctx: BotContext, clientId: string): Promise<void> {
  await ctx.answerCallbackQuery?.();
  const client = queries.getClientById(clientId);
  if (!client) {
    await ctx.editMessageText("Client not found.", {
      reply_markup: new InlineKeyboard().text("Back", "menu:client_list"),
    });
    return;
  }

  // Fetch traffic totals from snapshots
  const snapshots = queries.getTrafficHistory(clientId, 1000);
  let totalWgRx = 0, totalWgTx = 0, totalXrayRx = 0, totalXrayTx = 0;
  for (const s of snapshots) {
    totalWgRx += s.wg_rx;
    totalWgTx += s.wg_tx;
    totalXrayRx += s.xray_rx;
    totalXrayTx += s.xray_tx;
  }

  const trafficLine =
    (client.type !== "xray" ? `WG: ${formatBytes(totalWgRx)} / ${formatBytes(totalWgTx)}\n` : "") +
    (client.type !== "wg" ? `XRay: ${formatBytes(totalXrayRx)} / ${formatBytes(totalXrayTx)}` : "");

  const text = `${clientSummary(client)}\n\nTraffic:\n${trafficLine || "No data yet"}`;
  await ctx.editMessageText(text, {
    parse_mode: "Markdown",
    reply_markup: clientKeyboard(client),
  });
}

export async function handleClientCardCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  await ctx.answerCallbackQuery();

  const [, action, clientId] = data.split(":");
  if (!clientId) return;

  const client = queries.getClientById(clientId);
  if (!client) {
    await ctx.editMessageText("Client not found.");
    return;
  }

  switch (action) {
    case "config":
      await sendConfig(ctx, client);
      break;
    case "graph":
      await sendTrafficGraph(ctx, client);
      break;
    case "suspend":
      await suspend(ctx, client);
      break;
    case "resume":
      await resume(ctx, client);
      break;
    case "delete_confirm":
      await confirmDelete(ctx, client);
      break;
    case "delete":
      await deleteClient(ctx, client);
      break;
    default:
      await showClientCard(ctx, clientId);
  }
}

async function sendConfig(ctx: BotContext, client: Client): Promise<void> {
  if (client.type === "wg" || client.type === "both") {
    await ctx.reply(
      "WireGuard private key was only shown at creation time. Re-add client to get a new config.",
      { reply_markup: clientKeyboard(client) }
    );
  }

  if (client.type === "xray" || client.type === "both") {
    if (!client.xray_uuid) return;
    const uris = xrayService.generateVlessUris(client.name, client.xray_uuid);

    const text = [
      `*VLESS Config for ${client.name}*\n`,
      `*Direct (Server B):*`,
      `\`${uris.direct}\`\n`,
      `*Via Relay (Server A):*`,
      `\`${uris.relay}\`\n`,
      `_Use Hiddify or Streisand app to import._`,
    ].join("\n");

    await ctx.reply(text, { parse_mode: "Markdown" });

    // Send QR codes
    const directQr = await qrService.generate(uris.direct);
    const relayQr = await qrService.generate(uris.relay);
    await ctx.replyWithPhoto(new InputFile(directQr, "direct-qr.png"), {
      caption: `QR: ${client.name} (Direct)`,
    });
    await ctx.replyWithPhoto(new InputFile(relayQr, "relay-qr.png"), {
      caption: `QR: ${client.name} (Via Relay)`,
    });
  }
}

async function sendTrafficGraph(ctx: BotContext, client: Client): Promise<void> {
  const snapshots = queries.getTrafficHistory(client.id, 144).reverse();
  if (snapshots.length < 2) {
    await ctx.reply("Not enough traffic data yet. Check back later.");
    return;
  }
  const png = await chartsService.renderTrafficChart(client.name, snapshots);
  await ctx.replyWithPhoto(new InputFile(png, "traffic.png"), {
    caption: `Traffic — ${client.name}`,
  });
}

async function suspend(ctx: BotContext, client: Client): Promise<void> {
  try {
    await doSuspend(client);
    client.is_active = 0;
    await ctx.editMessageText(
      `${client.name} suspended.`,
      { reply_markup: clientKeyboard(client) }
    );
  } catch (err) {
    await ctx.reply(`Suspend failed: ${(err as Error).message}`);
  }
}

async function resume(ctx: BotContext, client: Client): Promise<void> {
  try {
    await doResume(client);
    client.is_active = 1;
    await ctx.editMessageText(
      `${client.name} resumed.`,
      { reply_markup: clientKeyboard(client) }
    );
  } catch (err) {
    await ctx.reply(`Resume failed: ${(err as Error).message}`);
  }
}

async function confirmDelete(ctx: BotContext, client: Client): Promise<void> {
  ctx.session.step = "awaiting_delete_confirm";
  ctx.session.data.clientId = client.id;
  await ctx.editMessageText(
    `*Delete ${client.name}?*\n\nThis will remove the client from WireGuard and XRay. This cannot be undone.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("Yes, delete", `card:delete:${client.id}`)
        .text("Cancel", `client:${client.id}`),
    }
  );
}

async function deleteClient(ctx: BotContext, client: Client): Promise<void> {
  try {
    await doDelete(client);
    ctx.session.step = "idle";
    ctx.session.data = {};
    await ctx.editMessageText(
      `*${client.name}* deleted.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("Client List", "menu:client_list"),
      }
    );
  } catch (err) {
    await ctx.reply(`Delete failed: ${(err as Error).message}`);
  }
}
