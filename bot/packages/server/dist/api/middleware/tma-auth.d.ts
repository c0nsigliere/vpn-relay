import { FastifyReply, FastifyRequest } from "fastify";
/**
 * Validates Telegram Mini App initData per:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export declare function validateInitData(initData: string): {
    userId: number;
} | null;
export declare function tmaAuthMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void>;
//# sourceMappingURL=tma-auth.d.ts.map