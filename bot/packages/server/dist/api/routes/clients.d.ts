import { FastifyInstance } from "fastify";
import { Bot } from "grammy";
import type { BotContext } from "../../bot/context";
export declare function clientsRoutes(app: FastifyInstance, opts: {
    bot: Bot<BotContext>;
}): Promise<void>;
//# sourceMappingURL=clients.d.ts.map