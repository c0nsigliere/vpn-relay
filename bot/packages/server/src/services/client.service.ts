/**
 * ClientService — shared business logic for creating, suspending,
 * resuming, deleting, and sending config for VPN clients.
 * Used by both the Telegram bot menus and the Fastify REST API.
 */

import { v4 as uuidv4 } from "uuid";
import { InputFile, Bot } from "grammy";
import { queries } from "../db/queries";
import { xrayService } from "./xray.service";
import { wgService } from "./wg.service";
import { qrService } from "./qr.service";
import type { BotContext } from "../bot/context";
import type { Client, ClientType } from "@vpn-relay/shared";

export interface CreateClientResult {
  client: Client;
  wgConf?: string;           // WG .conf file text (only at creation time)
  xrayUris?: { direct: string; relay: string };
}

export async function createClient(
  name: string,
  type: ClientType,
  ttlDays?: number,
  dailyQuotaGb?: number,
  monthlyQuotaGb?: number
): Promise<CreateClientResult> {
  const id = uuidv4();
  let wgIp: string | null = null;
  let wgPubkey: string | null = null;
  let wgConf: string | undefined;
  let xrayUuid: string | null = null;
  let xrayUris: { direct: string; relay: string } | undefined;

  const expiresAt = ttlDays
    ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
    : null;

  if (type === "wg" || type === "both") {
    const wgResult = await wgService.addClient(name);
    wgIp = wgResult.ip;
    wgPubkey = wgResult.publicKey;
    wgConf = wgResult.conf;
  }

  if (type === "xray" || type === "both") {
    xrayUuid = await xrayService.addClient(name);
    xrayUris = xrayService.generateVlessUris(name, xrayUuid);
  }

  queries.insertClient({
    id,
    name,
    type,
    wg_ip: wgIp,
    wg_pubkey: wgPubkey,
    xray_uuid: xrayUuid,
    expires_at: expiresAt,
    is_active: 1,
    daily_quota_gb: dailyQuotaGb ?? null,
    monthly_quota_gb: monthlyQuotaGb ?? null,
    suspend_reason: null,
  });

  const client = queries.getClientById(id)!;
  return { client, wgConf, xrayUris };
}

export async function suspendClient(client: Client, reason: "manual" | "daily_quota" | "monthly_quota" | "expired" | "abnormal_traffic" = "manual"): Promise<void> {
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
    await wgService.suspendClient(client.wg_pubkey);
  }
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.removeClient(client.name, client.xray_uuid);
  }
  queries.setClientActive(client.id, false, reason);
}

export async function resumeClient(client: Client): Promise<void> {
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey && client.wg_ip) {
    await wgService.resumeClient(client.wg_pubkey, client.wg_ip);
  }
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.addClient(client.name, client.xray_uuid);
  }
  queries.setClientActive(client.id, true);
}

export async function updateQuota(
  clientId: string,
  dailyQuotaGb: number | null,
  monthlyQuotaGb: number | null
): Promise<void> {
  const client = queries.getClientById(clientId);
  if (!client) return;

  queries.updateClientQuota(clientId, dailyQuotaGb, monthlyQuotaGb);

  // Auto-resume if suspended by quota that was removed
  if (client.is_active === 0) {
    const suspendedByDaily = client.suspend_reason === "daily_quota";
    const suspendedByMonthly = client.suspend_reason === "monthly_quota";
    if ((suspendedByDaily && dailyQuotaGb === null) || (suspendedByMonthly && monthlyQuotaGb === null)) {
      const freshClient = queries.getClientById(clientId)!;
      await resumeClient(freshClient);
    }
  }
}

export async function renameClient(client: Client, newName: string): Promise<void> {
  if (client.type === "wg" || client.type === "both") {
    await wgService.renameClient(client.name, newName);
  }
  if (client.type === "xray" || client.type === "both") {
    await xrayService.renameClient(client.name, newName);
  }
  queries.updateClientName(client.id, newName);
}

export async function deleteClient(client: Client): Promise<void> {
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
    await wgService.removeClient(client.name, client.wg_pubkey);
  }
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.removeClient(client.name, client.xray_uuid);
  }
  queries.deleteClient(client.id);
}

/**
 * Send client config + QR codes to a Telegram chat.
 * Used after creation via TMA (sends to admin chat) and via inline button.
 */
export async function sendConfigToChat(
  bot: Bot<BotContext>,
  chatId: number,
  client: Client,
  wgConf?: string
): Promise<void> {
  if ((client.type === "wg" || client.type === "both") && wgConf) {
    await bot.api.sendDocument(
      chatId,
      new InputFile(Buffer.from(wgConf), `${client.name}.conf`),
      {
        caption: `🔐 WireGuard config for *${client.name}*\n⚠️ Save this — private key won't be shown again.`,
        parse_mode: "Markdown",
      }
    );
  }

  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    const uris = xrayService.generateVlessUris(client.name, client.xray_uuid);
    const text = [
      `⚡ *VLESS Config for ${client.name}*\n`,
      `*Direct:*\n\`${uris.direct}\`\n`,
      `*Via Relay:*\n\`${uris.relay}\`\n`,
      `_Import with Hiddify or Streisand app._`,
    ].join("\n");

    await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });

    const [directQr, relayQr] = await Promise.all([
      qrService.generate(uris.direct),
      qrService.generate(uris.relay),
    ]);
    await bot.api.sendPhoto(chatId, new InputFile(directQr, "direct-qr.png"), {
      caption: `QR: ${client.name} (Direct)`,
    });
    await bot.api.sendPhoto(chatId, new InputFile(relayQr, "relay-qr.png"), {
      caption: `QR: ${client.name} (Via Relay)`,
    });
  }
}
