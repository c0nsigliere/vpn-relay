import { Context, SessionFlavor } from "grammy";
import type { ClientType, WgCascadeTransport } from "@vpn-relay/shared";

export interface SessionData {
  step:
    | "idle"
    | "awaiting_client_name"
    | "awaiting_client_type"
    | "awaiting_delete_confirm";
  data: {
    clientType?: ClientType;
    wgCascadeTransport?: WgCascadeTransport;
    clientId?: string;
    page?: number;
  };
}

export function initialSession(): SessionData {
  return { step: "idle", data: {} };
}

export type BotContext = Context & SessionFlavor<SessionData>;
