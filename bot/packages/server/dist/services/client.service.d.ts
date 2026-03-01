/**
 * ClientService — shared business logic for creating, suspending,
 * resuming, deleting, and sending config for VPN clients.
 * Used by both the Telegram bot menus and the Fastify REST API.
 */
import { Bot } from "grammy";
import type { BotContext } from "../bot/context";
import type { Client, ClientType } from "@vpn-relay/shared";
export interface CreateClientResult {
    client: Client;
    wgConf?: string;
    xrayUris?: {
        direct: string;
        relay: string;
    };
}
export declare function createClient(name: string, type: ClientType, ttlDays?: number): Promise<CreateClientResult>;
export declare function suspendClient(client: Client): Promise<void>;
export declare function resumeClient(client: Client): Promise<void>;
export declare function deleteClient(client: Client): Promise<void>;
/**
 * Send client config + QR codes to a Telegram chat.
 * Used after creation via TMA (sends to admin chat) and via inline button.
 */
export declare function sendConfigToChat(bot: Bot<BotContext>, chatId: number, client: Client, wgConf?: string): Promise<void>;
//# sourceMappingURL=client.service.d.ts.map