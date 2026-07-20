import { InlineKeyboard, InputFile } from "grammy";
import { BotContext } from "../context";
import { queries, Client } from "../../db/queries";
import { xrayService } from "../../services/xray.service";
import { hysteriaService } from "../../services/hysteria.service";
import {
  suspendClient as doSuspend,
  resumeClient as doResume,
  deleteClient as doDelete,
  updateWgTransport,
  ensureSubToken,
  rotateSubToken,
} from "../../services/client.service";
import {
  subscriptionUrl,
  subscriptionsAvailable,
  isSubscriptionCapable,
} from "../../services/subscription.service";
import { chartsService } from "../../services/charts.service";
import { qrService } from "../../services/qr.service";
import { formatBytes } from "../../utils/format";
import { wgHy2Available } from "../../config/standalone";

function clientSummary(c: Client): string {
  const status = c.is_active ? "Active" : "Suspended";
  const expiry = c.expires_at
    ? `\nExpires: ${c.expires_at.replace("T", " ").slice(0, 16)} UTC`
    : "";
  const TYPE_LABEL: Record<Client["type"], string> = {
    wg: "WG",
    xray: "XRAY",
    both: "WireGuard + XRay",
    hysteria2: "Hysteria 2",
  };
  const type = TYPE_LABEL[c.type];
  const isWg = c.type === "wg" || c.type === "both";
  const transport =
    isWg && wgHy2Available
      ? `\nCascade uplink: ${c.wg_cascade_transport === "hy2" ? "Hysteria 2" : "XRay (VLESS)"}`
      : "";
  return (
    `*${c.name}*\n` +
    `Type: ${type}\n` +
    `Status: ${status}${expiry}${transport}\n` +
    (c.wg_ip ? `IP: \`${c.wg_ip}\`` : "")
  );
}

function clientKeyboard(c: Client): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("Get Config", `card:config:${c.id}`)
    .text("Traffic Graph", `card:graph:${c.id}`)
    .row();

  // Gate on "can we actually produce a link", not merely on protocol capability:
  // without a configured public origin (TMA_URL) the button would lead nowhere.
  // Kept side-effect free — the token is minted lazily in the handler, because a
  // keyboard renderer must not write to the DB on every card view.
  if (isSubscriptionCapable(c) && subscriptionsAvailable()) {
    kb.text("🔗 Subscription", `card:sub:${c.id}`).row();
  }

  // WG cascade transport toggle — only when the Hy2 uplink is available.
  if ((c.type === "wg" || c.type === "both") && wgHy2Available) {
    const next = c.wg_cascade_transport === "hy2" ? "XRay" : "Hy2";
    kb.text(`Uplink → ${next}`, `card:transport:${c.id}`).row();
  }

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
  let totalWgRx = 0, totalWgTx = 0, totalXrayRx = 0, totalXrayTx = 0, totalHy2Rx = 0, totalHy2Tx = 0;
  for (const s of snapshots) {
    totalWgRx += s.wg_rx;
    totalWgTx += s.wg_tx;
    totalXrayRx += s.xray_rx;
    totalXrayTx += s.xray_tx;
    totalHy2Rx += s.hy2_rx;
    totalHy2Tx += s.hy2_tx;
  }

  // Positive per-type checks: show exactly the protocol lines a client uses.
  const showWg = client.type === "wg" || client.type === "both";
  const showXray = client.type === "xray" || client.type === "both";
  const showHy2 = client.type === "hysteria2";
  const trafficLine =
    (showWg ? `WG: ${formatBytes(totalWgRx)} / ${formatBytes(totalWgTx)}\n` : "") +
    (showXray ? `XRay: ${formatBytes(totalXrayRx)} / ${formatBytes(totalXrayTx)}` : "") +
    (showHy2 ? `Hy2: ${formatBytes(totalHy2Rx)} / ${formatBytes(totalHy2Tx)}` : "");

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
    case "transport":
      await toggleTransport(ctx, client);
      break;
    case "sub":
      await sendSubscription(ctx, client);
      break;
    case "subrotate":
      await rotateSubscription(ctx, client);
      break;
    default:
      await showClientCard(ctx, clientId);
  }
}

function subKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    // "Invalidate", never "revoke" — rotation kills the link, not the credentials
    // someone already imported. See rotateSubToken().
    .text("♻️ Invalidate & regenerate link", `card:subrotate:${id}`)
    .row()
    .text("Back", `client:${id}`);
}

async function sendSubscription(
  ctx: BotContext,
  client: Client,
  rotated = false
): Promise<void> {
  if (!isSubscriptionCapable(client)) {
    await ctx.reply("This client has no subscription-representable configuration.");
    return;
  }
  // Lazy mint: covers rows that predate the feature or whose credential arrived late.
  const c = ensureSubToken(client);
  const url = subscriptionUrl(c);
  if (!url) {
    await ctx.reply("Subscriptions require a configured TMA domain (TMA_URL is unset).");
    return;
  }

  const lines = [
    `🔗 *Subscription for ${client.name}*\n`,
    // Code span: base64url produces `_` and `-`, which Markdown would otherwise
    // try to read as emphasis and mangle the link.
    `\`${url}\`\n`,
    `_Add this as a subscription in Hiddify, v2rayN or Streisand — the app re-polls it and picks up server changes on its own._\n`,
    `⚠️ Treat this link like a password: anyone who opens it gets this client's credentials.`,
  ];
  if (rotated) {
    lines.push(
      `\n♻️ *Link regenerated.* The old link now returns 404. This does *not* disconnect anyone already using the config — to revoke access, suspend or delete the client.`
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  await ctx.replyWithPhoto(new InputFile(await qrService.generate(url), "sub-qr.png"), {
    caption: `Subscription QR: ${client.name}`,
    reply_markup: subKeyboard(client.id),
  });
}

async function rotateSubscription(ctx: BotContext, client: Client): Promise<void> {
  try {
    const { client: rotated } = rotateSubToken(client);
    await sendSubscription(ctx, rotated, true);
  } catch (err) {
    await ctx.reply(`Could not regenerate the link: ${(err as Error).message}`);
  }
}

async function toggleTransport(ctx: BotContext, client: Client): Promise<void> {
  if ((client.type !== "wg" && client.type !== "both") || !wgHy2Available) {
    await showClientCard(ctx, client.id);
    return;
  }
  const next = client.wg_cascade_transport === "hy2" ? "xray" : "hy2";
  await updateWgTransport(client, next);
  await showClientCard(ctx, client.id);
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

    const lines = [`*VLESS Config for ${client.name}*\n`];
    if (uris.relay) {
      lines.push(`*Direct:*`, `\`${uris.direct}\`\n`);
      lines.push(`*Via Relay:*`, `\`${uris.relay}\`\n`);
    } else {
      lines.push(`\`${uris.direct}\`\n`);
    }
    lines.push(`_Use Hiddify or Streisand app to import._`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });

    // Send QR codes
    await ctx.replyWithPhoto(
      new InputFile(await qrService.generate(uris.direct), "direct-qr.png"),
      { caption: `QR: ${client.name}${uris.relay ? " (Direct)" : ""}` }
    );
    if (uris.relay) {
      await ctx.replyWithPhoto(
        new InputFile(await qrService.generate(uris.relay), "relay-qr.png"),
        { caption: `QR: ${client.name} (Via Relay)` }
      );
    }
  }

  if (client.type === "hysteria2" && client.hy2_password) {
    const uris = hysteriaService.generateUris(client.name, client.hy2_password);

    const lines = [`*Hysteria 2 Config for ${client.name}*\n`];
    if (uris.relay) {
      lines.push(`*Direct:*`, `\`${uris.direct}\`\n`);
      lines.push(`*Via Relay:*`, `\`${uris.relay}\`\n`);
    } else {
      lines.push(`\`${uris.direct}\`\n`);
    }
    lines.push(`_Use Hiddify, NekoBox or Streisand app to import._`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });

    await ctx.replyWithPhoto(
      new InputFile(await qrService.generate(uris.direct), "hy2-direct-qr.png"),
      { caption: `QR: ${client.name}${uris.relay ? " (Direct)" : " (Hysteria 2)"}` }
    );
    if (uris.relay) {
      await ctx.replyWithPhoto(
        new InputFile(await qrService.generate(uris.relay), "hy2-relay-qr.png"),
        { caption: `QR: ${client.name} (Via Relay)` }
      );
    }
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
