import { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import type { BotContext } from "../bot/context";
export declare function buildApiServer(bot: Bot<BotContext>): Promise<FastifyInstance>;
export declare function startApiServer(bot: Bot<BotContext>): Promise<FastifyInstance>;
//# sourceMappingURL=server.d.ts.map