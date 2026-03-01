"use strict";
/**
 * ClientService — shared business logic for creating, suspending,
 * resuming, deleting, and sending config for VPN clients.
 * Used by both the Telegram bot menus and the Fastify REST API.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createClient = createClient;
exports.suspendClient = suspendClient;
exports.resumeClient = resumeClient;
exports.deleteClient = deleteClient;
exports.sendConfigToChat = sendConfigToChat;
const uuid_1 = require("uuid");
const grammy_1 = require("grammy");
const queries_1 = require("../db/queries");
const xray_service_1 = require("./xray.service");
const wg_service_1 = require("./wg.service");
const qr_service_1 = require("./qr.service");
async function createClient(name, type, ttlDays) {
    const id = (0, uuid_1.v4)();
    let wgIp = null;
    let wgPubkey = null;
    let wgConf;
    let xrayUuid = null;
    let xrayUris;
    const expiresAt = ttlDays
        ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
        : null;
    if (type === "wg" || type === "both") {
        const wgResult = await wg_service_1.wgService.addClient(name);
        wgIp = wgResult.ip;
        wgPubkey = wgResult.publicKey;
        wgConf = wgResult.conf;
    }
    if (type === "xray" || type === "both") {
        xrayUuid = await xray_service_1.xrayService.addClient(name);
        xrayUris = xray_service_1.xrayService.generateVlessUris(name, xrayUuid);
    }
    queries_1.queries.insertClient({
        id,
        name,
        type,
        wg_ip: wgIp,
        wg_pubkey: wgPubkey,
        xray_uuid: xrayUuid,
        expires_at: expiresAt,
        is_active: 1,
    });
    const client = queries_1.queries.getClientById(id);
    return { client, wgConf, xrayUris };
}
async function suspendClient(client) {
    if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
        await wg_service_1.wgService.suspendClient(client.wg_pubkey);
    }
    if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
        await xray_service_1.xrayService.removeClient(client.name, client.xray_uuid);
    }
    queries_1.queries.setClientActive(client.id, false);
}
async function resumeClient(client) {
    if ((client.type === "wg" || client.type === "both") && client.wg_pubkey && client.wg_ip) {
        await wg_service_1.wgService.resumeClient(client.wg_pubkey, client.wg_ip);
    }
    if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
        await xray_service_1.xrayService.addClient(client.name, client.xray_uuid);
    }
    queries_1.queries.setClientActive(client.id, true);
}
async function deleteClient(client) {
    if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
        await wg_service_1.wgService.removeClient(client.name, client.wg_pubkey);
    }
    if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
        await xray_service_1.xrayService.removeClient(client.name, client.xray_uuid);
    }
    queries_1.queries.deleteClient(client.id);
}
/**
 * Send client config + QR codes to a Telegram chat.
 * Used after creation via TMA (sends to admin chat) and via inline button.
 */
async function sendConfigToChat(bot, chatId, client, wgConf) {
    if ((client.type === "wg" || client.type === "both") && wgConf) {
        await bot.api.sendDocument(chatId, new grammy_1.InputFile(Buffer.from(wgConf), `${client.name}.conf`), {
            caption: `🔐 WireGuard config for *${client.name}*\n⚠️ Save this — private key won't be shown again.`,
            parse_mode: "Markdown",
        });
    }
    if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
        const uris = xray_service_1.xrayService.generateVlessUris(client.name, client.xray_uuid);
        const text = [
            `⚡ *VLESS Config for ${client.name}*\n`,
            `*Direct:*\n\`${uris.direct}\`\n`,
            `*Via Relay:*\n\`${uris.relay}\`\n`,
            `_Import with Hiddify or Streisand app._`,
        ].join("\n");
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
        const [directQr, relayQr] = await Promise.all([
            qr_service_1.qrService.generate(uris.direct),
            qr_service_1.qrService.generate(uris.relay),
        ]);
        await bot.api.sendPhoto(chatId, new grammy_1.InputFile(directQr, "direct-qr.png"), {
            caption: `QR: ${client.name} (Direct)`,
        });
        await bot.api.sendPhoto(chatId, new grammy_1.InputFile(relayQr, "relay-qr.png"), {
            caption: `QR: ${client.name} (Via Relay)`,
        });
    }
}
//# sourceMappingURL=client.service.js.map