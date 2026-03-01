import { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import type { BotContext } from "../../bot/context";
export declare function sendConfigRoutes(app: FastifyInstance, opts: {
    bot: Bot<BotContext>;
}): Promise<void>;
//# sourceMappingURL=send-config.d.ts.map