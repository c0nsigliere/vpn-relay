import { z } from "zod";

const envSchema = z.object({
  // Telegram
  BOT_TOKEN: z.string().min(1),
  ADMIN_ID: z.string().transform(Number).pipe(z.number().int().positive()),

  // Database
  DB_PATH: z.string().default("/var/lib/vpn-bot/data.db"),

  // Server A (WireGuard, SSH access)
  SERVER_A_HOST: z.string().min(1),
  SERVER_A_SSH_PORT: z.string().transform(Number).pipe(z.number().int()).default("22"),
  SERVER_A_SSH_USER: z.string().default("root"),
  SERVER_A_SSH_KEY_PATH: z.string().default("/var/lib/vpn-bot/.ssh/id_ed25519"),
  SERVER_A_WG_PORT: z.string().transform(Number).pipe(z.number().int()).default("51888"),

  // Server B (local XRay)
  SERVER_B_HOST: z.string().min(1),
  SERVER_B_XRAY_PORT: z.string().transform(Number).pipe(z.number().int()).default("8443"),
  XRAY_API_PORT: z.string().transform(Number).pipe(z.number().int()).default("10085"),
  XRAY_KEYS_DIR: z.string().default("/etc/xray/keys"),
  XRAY_CONFIG_FILE: z.string().default("/etc/xray/config.json"),
  XRAY_WG_UPLINK_UUID: z.string().default(""),

  // XRay DPI evasion params
  XRAY_SNI: z.string().default("www.googletagmanager.com"),
  XRAY_FINGERPRINT: z.string().default("chrome"),
  XRAY_FLOW: z.string().default("xtls-rprx-vision"),

  // Server A relay port (TCP relay entry)
  SERVER_A_RELAY_PORT: z.string().transform(Number).pipe(z.number().int()).default("443"),

  // TMA (Telegram Web App)
  TMA_PORT: z.string().transform(Number).pipe(z.number().int()).default("3000"),
  TMA_DOMAIN: z.string().optional(),
  TMA_URL: z.string().url().optional(),

  // Timezone offset for daily traffic grouping (e.g. "+3:00" for Moscow)
  TZ_OFFSET: z.string().default("+3:00"),
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

export const env = loadEnv();
export type Env = typeof env;
