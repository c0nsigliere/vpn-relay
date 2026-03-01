import { MiddlewareFn } from "grammy";
import { env } from "../../config/env";
import { BotContext } from "../context";

export const authMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId !== env.ADMIN_ID) {
    // Silently ignore unauthorized users
    return;
  }
  await next();
};
