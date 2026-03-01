"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    // Telegram
    BOT_TOKEN: zod_1.z.string().min(1),
    ADMIN_ID: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int().positive()),
    // Database
    DB_PATH: zod_1.z.string().default("/var/lib/vpn-bot/data.db"),
    // Server A (WireGuard, SSH access)
    SERVER_A_HOST: zod_1.z.string().min(1),
    SERVER_A_SSH_PORT: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int()).default("22"),
    SERVER_A_SSH_USER: zod_1.z.string().default("root"),
    SERVER_A_SSH_KEY_PATH: zod_1.z.string().default("/var/lib/vpn-bot/.ssh/id_ed25519"),
    SERVER_A_WG_PORT: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int()).default("51888"),
    // Server B (local XRay)
    SERVER_B_HOST: zod_1.z.string().min(1),
    SERVER_B_XRAY_PORT: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int()).default("8443"),
    XRAY_API_PORT: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int()).default("10085"),
    XRAY_KEYS_DIR: zod_1.z.string().default("/etc/xray/keys"),
    XRAY_CLIENTS_FILE: zod_1.z.string().default("/etc/xray/clients.json"),
    XRAY_CONFIG_FILE: zod_1.z.string().default("/etc/xray/config.json"),
    // XRay DPI evasion params
    XRAY_SNI: zod_1.z.string().default("www.googletagmanager.com"),
    XRAY_FINGERPRINT: zod_1.z.string().default("chrome"),
    XRAY_FLOW: zod_1.z.string().default("xtls-rprx-vision"),
    // Server A relay port (TCP relay entry)
    SERVER_A_RELAY_PORT: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int()).default("443"),
    // TMA (Telegram Web App)
    TMA_PORT: zod_1.z.string().transform(Number).pipe(zod_1.z.number().int()).default("3000"),
    TMA_DOMAIN: zod_1.z.string().optional(),
});
function loadEnv() {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
        console.error("Invalid environment configuration:");
        console.error(result.error.format());
        process.exit(1);
    }
    return result.data;
}
exports.env = loadEnv();
//# sourceMappingURL=env.js.map