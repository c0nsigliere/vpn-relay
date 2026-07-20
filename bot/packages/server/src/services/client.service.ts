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
import { hysteriaService } from "./hysteria.service";
import { xrayUplinkService } from "./xray-uplink.service";
import { wgService } from "./wg.service";
import { qrService } from "./qr.service";
import { isStandalone, wgHy2Available } from "../config/standalone";
import { createLogger } from "../utils/logger";
import { escapeMarkdown } from "../utils/telegram";
import { generateSubToken } from "../utils/sub-token";
import { subscriptionUrl } from "./subscription.service";
import type { BotContext } from "../bot/context";
import { isSubscriptionCapable } from "@vpn-relay/shared";
import type { Client, ClientType, WgCascadeTransport } from "@vpn-relay/shared";

const logger = createLogger("client");

export interface CreateClientResult {
  client: Client;
  wgConf?: string;           // WG .conf file text (only at creation time)
  xrayUris?: { direct: string; relay: string | null };
  hy2Uris?: { direct: string; relay: string | null };
}

export async function createClient(
  name: string,
  type: ClientType,
  ttlDays?: number,
  dailyQuotaGb?: number,
  monthlyQuotaGb?: number,
  wgCascadeTransport: WgCascadeTransport = "xray"
): Promise<CreateClientResult> {
  const id = uuidv4();
  let wgIp: string | null = null;
  let wgPubkey: string | null = null;
  let wgConf: string | undefined;
  let xrayUuid: string | null = null;
  let xrayUris: { direct: string; relay: string | null } | undefined;
  let hy2Password: string | null = null;
  let hy2Uris: { direct: string; relay: string | null } | undefined;

  const expiresAt = ttlDays
    ? new Date(Date.now() + ttlDays * 86_400_000).toISOString()
    : null;

  if (isStandalone && (type === "wg" || type === "both")) {
    throw new Error("WireGuard clients are not available in standalone mode — use 'xray' type");
  }

  // Hy2 cascade uplink may be unavailable (standalone / HY2_UPLINK_PASSWORD unset).
  // Creation is best-effort about this secondary choice: fall back to the default
  // VLESS transport rather than record one Server A can't honour. (The explicit
  // toggle in updateWgTransport is strict and rejects instead.)
  const effectiveTransport: WgCascadeTransport =
    wgCascadeTransport === "hy2" && !wgHy2Available ? "xray" : wgCascadeTransport;
  if (effectiveTransport !== wgCascadeTransport) {
    logger.warn(`Hy2 uplink unavailable — creating "${name}" on the VLESS cascade transport`);
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

  if (type === "hysteria2") {
    hy2Password = hysteriaService.generatePassword();
    hy2Uris = hysteriaService.generateUris(name, hy2Password);
  }

  // Mint the subscription token only now that the credentials exist. Keying on
  // the predicate rather than on `type` means a row that ends up without a usable
  // credential never receives a token — and so never serves a broken subscription.
  const subToken = isSubscriptionCapable({
    type,
    xray_uuid: xrayUuid,
    hy2_password: hy2Password,
  })
    ? generateSubToken()
    : null;

  // DB first — source of truth
  queries.insertClient({
    id,
    name,
    type,
    wg_ip: wgIp,
    wg_pubkey: wgPubkey,
    xray_uuid: xrayUuid,
    hy2_password: hy2Password,
    expires_at: expiresAt,
    is_active: 1,
    daily_quota_gb: dailyQuotaGb ?? null,
    monthly_quota_gb: monthlyQuotaGb ?? null,
    suspend_reason: null,
    wg_cascade_transport: effectiveTransport,
    sub_token: subToken,
  });

  // Rebuild XRay config from DB
  if (type === "xray" || type === "both") {
    await xrayService.syncConfigAndRestart();
  }

  // Rebuild sing-box config from DB
  if (type === "hysteria2") {
    await hysteriaService.syncConfigAndRestart();
  }

  // Write the new peer into Server A's conf (DB is now current) and apply the
  // cascade transport choice to Server A's XRay routing
  if (type === "wg" || type === "both") {
    await wgService.syncPeersFromDb();
    await xrayUplinkService.syncRoutingAndRestart();
  }

  const client = queries.getClientById(id)!;
  logger.info(`Created client "${name}" (type=${type})`);
  return { client, wgConf, xrayUris, hy2Uris };
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
  if (client.type === "hysteria2" && client.hy2_password) {
    await hysteriaService.syncConfigAndRestart();
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
  if (client.type === "hysteria2" && client.hy2_password) {
    await hysteriaService.syncConfigAndRestart();
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
  // DB first — every sync below reads names from DB. A WG rename is purely a
  // change of the conf's comment markers, so the peer-region rebuild covers it;
  // live state is keyed on the pubkey and needs no touching at all.
  queries.updateClientName(client.id, newName);
  if (client.type === "wg" || client.type === "both") {
    await wgService.syncPeersFromDb();
  }
  if (client.type === "xray" || client.type === "both") {
    await xrayService.syncConfigAndRestart();
  }
  if (client.type === "hysteria2") {
    await hysteriaService.syncConfigAndRestart();
  }
}

export async function deleteClient(client: Client): Promise<void> {
  logger.info(`Deleting "${client.name}"`);
  if ((client.type === "wg" || client.type === "both") && client.wg_pubkey) {
    await wgService.removeClient(client.wg_pubkey);
  }
  // DB first — syncConfigAndRestart reads active clients from DB
  queries.deleteClient(client.id);
  if ((client.type === "xray" || client.type === "both") && client.xray_uuid) {
    await xrayService.syncConfigAndRestart();
  }
  if (client.type === "hysteria2" && client.hy2_password) {
    await hysteriaService.syncConfigAndRestart();
  }
  // Drop the peer block, then the client's A-routing rule, before its WG IP can be reused
  if (client.type === "wg" || client.type === "both") {
    await wgService.syncPeersFromDb();
    await xrayUplinkService.syncRoutingAndRestart();
  }
}

/**
 * Change the WG cascade uplink transport (xray ↔ hy2) for a WG client.
 * DB first, then rebuild Server A's XRay routing. No client-side config change.
 */
export async function updateWgTransport(client: Client, transport: WgCascadeTransport): Promise<void> {
  if (client.type !== "wg" && client.type !== "both") {
    throw new Error("Cascade transport applies only to WireGuard clients");
  }
  if (transport === "hy2" && !wgHy2Available) {
    // No Hy2 uplink on this deployment (standalone, or HY2_UPLINK_PASSWORD unset):
    // refuse rather than record a transport that Server A can't honour.
    throw new Error("Hy2 cascade uplink is not available on this deployment");
  }
  logger.info(`Setting cascade transport for "${client.name}" → ${transport}`);
  queries.updateClientTransport(client.id, transport);
  await xrayUplinkService.syncRoutingAndRestart();
}

/**
 * Mint a subscription token for a capable client that somehow has none.
 *
 * Covers rows created before this feature existed whose backfill has not run,
 * and any row whose credential arrived after creation. Idempotent.
 */
export function ensureSubToken(client: Client): Client {
  if (!isSubscriptionCapable(client) || client.sub_token) return client;
  const token = generateSubToken();
  queries.setClientSubToken(client.id, token);
  return { ...client, sub_token: token };
}

/**
 * Rotate a client's subscription token.
 *
 * SCOPE, stated honestly: this invalidates the LINK. Future fetches of the old
 * token 404, which cuts off anyone still polling it and stops a shared link from
 * spreading further. It does NOT revoke access already extracted — whoever
 * imported the config still holds the live xray_uuid / hy2_password, and those
 * keep working while the client is active. Real revocation is suspend/delete
 * (data plane) or reissuing the credentials themselves.
 *
 * Every piece of user-facing copy must say "invalidate this link", never
 * "revoke access". Synchronous by nature: nothing on the data plane changes.
 */
export function rotateSubToken(client: Client): { client: Client; url: string | null } {
  if (!isSubscriptionCapable(client)) {
    throw new Error("This client has no subscription-representable configuration");
  }
  const token = generateSubToken();
  queries.setClientSubToken(client.id, token);
  logger.info(`Rotated subscription token for "${client.name}"`); // never log the token
  const updated = { ...client, sub_token: token };
  return { client: updated, url: subscriptionUrl(updated) };
}

/**
 * Send the subscription link + a QR of it to a Telegram chat.
 *
 * Kept separate from sendConfigToChat on purpose: that message is the one an
 * admin forwards to an end user, and the subscription link is a capability URL
 * granting the client's full credentials. Bundling them would hand the keys to
 * whoever receives a forwarded config.
 */
export async function sendSubLinkToChat(
  bot: Bot<BotContext>,
  chatId: number,
  client: Client,
  opts: { rotated?: boolean } = {}
): Promise<void> {
  const url = subscriptionUrl(client);
  if (!url) {
    throw new Error("No subscription link available for this client");
  }

  const lines = [
    `🔗 *Subscription for ${escapeMarkdown(client.name)}*\n`,
    // Code span: base64url yields `_` and `-`, which Markdown would otherwise
    // try to parse as emphasis.
    `\`${url}\`\n`,
    `_Add this as a subscription in Hiddify, v2rayN or Streisand — the app re-polls it and picks up server changes on its own._\n`,
    `⚠️ Treat this link like a password: anyone who opens it gets this client's credentials.`,
  ];
  if (opts.rotated) {
    lines.push(
      `\n♻️ *Link regenerated.* The old link now returns 404. This does *not* disconnect anyone already using the config — to revoke access, suspend or delete the client.`
    );
  }

  await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });
  await bot.api.sendPhoto(chatId, new InputFile(await qrService.generate(url), "sub-qr.png"), {
    caption: `Subscription QR: ${client.name}`,
  });
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

  if (client.type === "hysteria2" && client.hy2_password) {
    const uris = hysteriaService.generateUris(client.name, client.hy2_password);
    const lines = [`🚀 *Hysteria 2 Config for ${escapeMarkdown(client.name)}*\n`];
    if (uris.relay) {
      lines.push(`*Direct:*\n\`${uris.direct}\`\n`);
      lines.push(`*Via Relay:*\n\`${uris.relay}\`\n`);
    } else {
      lines.push(`\`${uris.direct}\`\n`);
    }
    lines.push(`_Import with Hiddify, NekoBox or Streisand app._`);

    await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "Markdown" });

    await bot.api.sendPhoto(
      chatId,
      new InputFile(await qrService.generate(uris.direct), "hy2-direct-qr.png"),
      { caption: `QR: ${client.name}${uris.relay ? " (Direct)" : " (Hysteria 2)"}` }
    );

    if (uris.relay) {
      await bot.api.sendPhoto(
        chatId,
        new InputFile(await qrService.generate(uris.relay), "hy2-relay-qr.png"),
        { caption: `QR: ${client.name} (Via Relay)` }
      );
    }
  }
}
