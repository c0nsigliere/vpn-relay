"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showClientCard = showClientCard;
exports.handleClientCardCallback = handleClientCardCallback;
const grammy_1 = require("grammy");
const queries_1 = require("../../db/queries");
const xray_service_1 = require("../../services/xray.service");
const wg_service_1 = require("../../services/wg.service");
const charts_service_1 = require("../../services/charts.service");
const qr_service_1 = require("../../services/qr.service");
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
function clientSummary(c) {
    const status = c.is_active ? "🟢 Active" : "🔴 Suspended";
    const expiry = c.expires_at
        ? `\n⏰ Expires: ${c.expires_at.replace("T", " ").slice(0, 16)} UTC`
        : "";
    const type = c.type === "both" ? "WireGuard + XRay" : c.type.toUpperCase();
    return (`👤 *${c.name}*\n` +
        `Type: ${type}\n` +
        `Status: ${status}${expiry}\n` +
        (c.wg_ip ? `IP: \`${c.wg_ip}\`` : ""));
}
function clientKeyboard(c) {
    const kb = new grammy_1.InlineKeyboard()
        .text("🔑 Get Config", `card:config:${c.id}`)
        .text("📈 Traffic Graph", `card:graph:${c.id}`)
        .row();
    if (c.is_active) {
        kb.text("⏸ Suspend", `card:suspend:${c.id}`);
    }
    else {
        kb.text("▶️ Resume", `card:resume:${c.id}`);
    }
    kb.text("🗑 Delete", `card:delete_confirm:${c.id}`).row();
    kb.text("« Back", "menu:client_list");
    return kb;
}
async function showClientCard(ctx, clientId) {
    await ctx.answerCallbackQuery?.();
    const client = queries_1.queries.getClientById(clientId);
    if (!client) {
        await ctx.editMessageText("❌ Client not found.", {
            reply_markup: new grammy_1.InlineKeyboard().text("« Back", "menu:client_list"),
        });
        return;
    }
    // Fetch traffic totals from snapshots
    const snapshots = queries_1.queries.getTrafficHistory(clientId, 1000);
    let totalWgRx = 0, totalWgTx = 0, totalXrayRx = 0, totalXrayTx = 0;
    for (const s of snapshots) {
        totalWgRx += s.wg_rx;
        totalWgTx += s.wg_tx;
        totalXrayRx += s.xray_rx;
        totalXrayTx += s.xray_tx;
    }
    const trafficLine = (client.type !== "xray" ? `WG: ↓${formatBytes(totalWgRx)} ↑${formatBytes(totalWgTx)}\n` : "") +
        (client.type !== "wg" ? `XRay: ↓${formatBytes(totalXrayRx)} ↑${formatBytes(totalXrayTx)}` : "");
    const text = `${clientSummary(client)}\n\n📊 Traffic:\n${trafficLine || "No data yet"}`;
    await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: clientKeyboard(client),
    });
}
async function handleClientCardCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? "";
    await ctx.answerCallbackQuery();
    const [, action, clientId] = data.split(":");
    if (!clientId)
        return;
    const client = queries_1.queries.getClientById(clientId);
    if (!client) {
        await ctx.editMessageText("❌ Client not found.");
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
async function sendConfig(ctx, client) {
    if (client.type === "wg" || client.type === "both") {
        await ctx.reply("⚠️ WireGuard private key was only shown at creation time. Re-add client to get a new config.", { reply_markup: clientKeyboard(client) });
    }
    if (client.type === "xray" || client.type === "both") {
        if (!client.xray_uuid)
            return;
        const uris = xray_service_1.xrayService.generateVlessUris(client.name, client.xray_uuid);
        const text = [
            `🔑 *VLESS Config for ${client.name}*\n`,
            `*Direct (Server B):*`,
            `\`${uris.direct}\`\n`,
            `*Via Relay (Server A):*`,
            `\`${uris.relay}\`\n`,
            `_Use Hiddify or Streisand app to import._`,
        ].join("\n");
        await ctx.reply(text, { parse_mode: "Markdown" });
        // Send QR codes
        const directQr = await qr_service_1.qrService.generate(uris.direct);
        const relayQr = await qr_service_1.qrService.generate(uris.relay);
        await ctx.replyWithPhoto(new grammy_1.InputFile(directQr, "direct-qr.png"), {
            caption: `QR: ${client.name} (Direct)`,
        });
        await ctx.replyWithPhoto(new grammy_1.InputFile(relayQr, "relay-qr.png"), {
            caption: `QR: ${client.name} (Via Relay)`,
        });
    }
}
async function sendTrafficGraph(ctx, client) {
    const snapshots = queries_1.queries.getTrafficHistory(client.id, 144).reverse();
    if (snapshots.length < 2) {
        await ctx.reply("📊 Not enough traffic data yet. Check back later.");
        return;
    }
    const png = await charts_service_1.chartsService.renderTrafficChart(client.name, snapshots);
    await ctx.replyWithPhoto(new grammy_1.InputFile(png, "traffic.png"), {
        caption: `📈 Traffic — ${client.name}`,
    });
}
async function suspend(ctx, client) {
    try {
        if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
            await wg_service_1.wgService.suspendClient(client.wg_pubkey);
        }
        if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
            await xray_service_1.xrayService.removeClient(client.name, client.xray_uuid);
        }
        queries_1.queries.setClientActive(client.id, false);
        client.is_active = 0;
        await ctx.editMessageText(`✅ ${client.name} suspended.`, { reply_markup: clientKeyboard(client) });
    }
    catch (err) {
        await ctx.reply(`❌ Suspend failed: ${err.message}`);
    }
}
async function resume(ctx, client) {
    try {
        if ((client.type === "wg" || client.type === "both") && client.wg_pubkey && client.wg_ip) {
            await wg_service_1.wgService.resumeClient(client.wg_pubkey, client.wg_ip);
        }
        if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
            await xray_service_1.xrayService.addClient(client.name, client.xray_uuid);
        }
        queries_1.queries.setClientActive(client.id, true);
        client.is_active = 1;
        await ctx.editMessageText(`✅ ${client.name} resumed.`, { reply_markup: clientKeyboard(client) });
    }
    catch (err) {
        await ctx.reply(`❌ Resume failed: ${err.message}`);
    }
}
async function confirmDelete(ctx, client) {
    ctx.session.step = "awaiting_delete_confirm";
    ctx.session.data.clientId = client.id;
    await ctx.editMessageText(`⚠️ *Delete ${client.name}?*\n\nThis will remove the client from WireGuard and XRay. This cannot be undone.`, {
        parse_mode: "Markdown",
        reply_markup: new grammy_1.InlineKeyboard()
            .text("🗑 Yes, delete", `card:delete:${client.id}`)
            .text("« Cancel", `client:${client.id}`),
    });
}
async function deleteClient(ctx, client) {
    try {
        if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
            await wg_service_1.wgService.removeClient(client.name, client.wg_pubkey);
        }
        if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
            await xray_service_1.xrayService.removeClient(client.name, client.xray_uuid);
        }
        queries_1.queries.deleteClient(client.id);
        ctx.session.step = "idle";
        ctx.session.data = {};
        await ctx.editMessageText(`🗑 *${client.name}* deleted.`, {
            parse_mode: "Markdown",
            reply_markup: new grammy_1.InlineKeyboard().text("« Client List", "menu:client_list"),
        });
    }
    catch (err) {
        await ctx.reply(`❌ Delete failed: ${err.message}`);
    }
}
//# sourceMappingURL=client-card.js.map