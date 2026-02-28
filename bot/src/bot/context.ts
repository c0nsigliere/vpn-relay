import { Context, SessionFlavor } from "grammy";

export interface SessionData {
  step:
    | "idle"
    | "awaiting_client_name"
    | "awaiting_client_type"
    | "awaiting_delete_confirm";
  data: {
    clientType?: "wg" | "xray" | "both";
    clientId?: string;
    page?: number;
  };
}

export function initialSession(): SessionData {
  return { step: "idle", data: {} };
}

export type BotContext = Context & SessionFlavor<SessionData>;
