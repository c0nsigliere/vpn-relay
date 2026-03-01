"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = void 0;
const env_1 = require("../../config/env");
const authMiddleware = async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId !== env_1.env.ADMIN_ID) {
        // Silently ignore unauthorized users
        return;
    }
    await next();
};
exports.authMiddleware = authMiddleware;
//# sourceMappingURL=auth.js.map