/**
 * ClientService — shared business logic for creating, suspending,
 * resuming, deleting, and sending config for VPN clients.
 * Used by both the Telegram bot menus and the Fastify REST API.
 *
 * DB is the single source of truth. Every mutation writes to DB first,
 * then calls xrayService.syncConfigAndRestart() to rebuild config.json.
 */

import { v4 as uuidv4 } from "uuid";
import { InputFile, Bot } from "grammy";
import { queries } from "../db/queries";
import { xrayService } from "./xray.service";
import { wgService } from "./wg.service";
import { qrService } from "./qr.service";
import { isStandalone } from "../config/standalone";
import { createLogger } from "../utils/logger";
import { escapeMarkdown } from "../utils/telegram";
import type { BotContext } from "../bot/context";
import type { Client, ClientType } from "@vpn-relay/shared";

const logger = createLogger("client");

export interface CreateClientResult {
  client: Client;
  wgConf?: string;           // WG .conf file text (only at creation time)
  xrayUris?: { direct: string; relay: string | null };
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
  let xrayUris: { direct: string; relay: string | null } | undefined;

  const expiresAt = ttlDays
    ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
    : null;

  if (isStandalone && (type === "wg" || type === "both")) {
    throw new Error("WireGuard clients are not available in standalone mode — use 'xray' type");
  }

  if (type === "wg" || type === "both") {
    const wgResult = await wgService.addClient(name);
    wgIp = wgResult.ip;
    wgPubkey = wgResult.publicKey;
    wgConf = wgResult.conf;
  }

  if (type === "xray" || type === "both") {
    xrayUuid = xrayService.generateUuid();
    xrayUris = xrayService.generateVlessUris(name, xrayUuid);
  }

  // DB first — source of truth
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

  // Rebuild XRay config from DB
  if (type === "xray" || type === "both") {
    await xrayService.syncConfigAndRestart();
  }

  const client = queries.getClientById(id)!;
  logger.info(`Created client "${name}" (type=${type})`);
  return { client, wgConf, xrayUris };
}

export async function suspendClient(client: Client, reason: "manual" | "daily_quota" | "monthly_quota" | "expired" | "abnormal_traffic" = "manual"): Promise<void> {
  logger.info(`Suspending "${client.name}" (reason=${reason})`);
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
    await wgService.suspendClient(client.wg_pubkey);
  }
  // DB first — syncConfigAndRestart reads active clients from DB
  queries.setClientActive(client.id, false, reason);
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.syncConfigAndRestart();
  }
}

export async function resumeClient(client: Client): Promise<void> {
  logger.info(`Resuming "${client.name}"`);
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey && client.wg_ip) {
    await wgService.resumeClient(client.wg_pubkey, client.wg_ip);
  }
  // DB first — syncConfigAndRestart reads active clients from DB
  queries.setClientActive(client.id, true);
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.syncConfigAndRestart();
  }
}

export async function updateQuota(
  clientId: string,
  dailyQuotaGb: number | null,
  monthlyQuotaGb: number | null
): Promise<void> {
  const client = queries.getClientById(clientId);
  if (!client) return;

  queries.updateClientQuota(clientId, dailyQuotaGb, monthlyQuotaGb);
  logger.info(`Quota updated "${client.name}": daily ${client.daily_quota_gb} → ${dailyQuotaGb}, monthly ${client.monthly_quota_gb} → ${monthlyQuotaGb}`);

  // Auto-resume if suspended by quota that was removed or increased above current usage
  if (client.is_active === 0) {
    const GB = 1_073_741_824;
    const suspendedByDaily = client.suspend_reason === "daily_quota";
    const suspendedByMonthly = client.suspend_reason === "monthly_quota";
    let shouldResume = false;

    if (suspendedByDaily) {
      if (dailyQuotaGb === null) {
        shouldResume = true;
      } else {
        const dailyUsed = queries.getClientDailyUsageBytes(clientId);
        if (dailyUsed < dailyQuotaGb * GB) shouldResume = true;
      }
    }
    if (suspendedByMonthly) {
      if (monthlyQuotaGb === null) {
        shouldResume = true;
      } else {
        const monthlyUsed = queries.getClientMonthlyUsageBytes(clientId);
        if (monthlyUsed < monthlyQuotaGb * GB) shouldResume = true;
      }
    }

    if (shouldResume) {
      logger.info(`Auto-resuming "${client.name}" (quota raised above usage)`);
      const freshClient = queries.getClientById(clientId)!;
      await resumeClient(freshClient);
    }
  }
}

export async function updateExpiry(
  clientId: string,
  expiresAt: string | null
): Promise<void> {
  const client = queries.getClientById(clientId);
  if (!client) return;

  queries.updateClientExpiry(clientId, expiresAt);
  logger.info(`Expiry updated "${client.name}": ${client.expires_at ?? "none"} → ${expiresAt ?? "none"}`);

  // Auto-resume if suspended due to expiry and new expiry is in the future (or removed)
  if (client.is_active === 0 && client.suspend_reason === "expired") {
    const expiryCleared = expiresAt === null;
    const expiryExtended = expiresAt !== null && new Date(expiresAt) > new Date();
    if (expiryCleared || expiryExtended) {
      logger.info(`Auto-resuming "${client.name}" (expiry extended)`);
      const freshClient = queries.getClientById(clientId)!;
      await resumeClient(freshClient);
    }
  }
}

export async function renameClient(client: Client, newName: string): Promise<void> {
  logger.info(`Renaming "${client.name}" → "${newName}"`);
  if (client.type === "wg" || client.type === "both") {
    await wgService.renameClient(client.name, newName);
  }
  // DB first — syncConfigAndRestart reads names from DB
  queries.updateClientName(client.id, newName);
  if (client.type === "xray" || client.type === "both") {
    await xrayService.syncConfigAndRestart();
  }
}

export async function deleteClient(client: Client): Promise<void> {
  logger.info(`Deleting "${client.name}"`);
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
    await wgService.removeClient(client.name, client.wg_pubkey);
  }
  // DB first — syncConfigAndRestart reads active clients from DB
  queries.deleteClient(client.id);
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.syncConfigAndRestart();
  }
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
        caption: `🔐 WireGuard config for *${escapeMarkdown(client.name)}*\n⚠️ Save this — private key won't be shown again.`,
        parse_mode: "Markdown",
      }
    );
  }

  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    const uris = xrayService.generateVlessUris(client.name, client.xray_uuid);
    const lines = [`⚡ *VLESS Config for ${escapeMarkdown(client.name)}*\n`];
    if (uris.relay) {
      lines.push(`*Direct:*\n\`${uris.direct}\`\n`);
      lines.push(`*Via Relay:*\n\`${uris.relay}\`\n`);
    } else {
      lines.push(`\`${uris.direct}\`\n`);
    }
    lines.push(`_Import with Hiddify or Streisand app._`);

    await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });

    await bot.api.sendPhoto(
      chatId,
      new InputFile(await qrService.generate(uris.direct), "direct-qr.png"),
      { caption: `QR: ${client.name}${uris.relay ? " (Direct)" : ""}` }
    );

    if (uris.relay) {
      await bot.api.sendPhoto(
        chatId,
        new InputFile(await qrService.generate(uris.relay), "relay-qr.png"),
        { caption: `QR: ${client.name} (Via Relay)` }
      );
    }
  }
}
