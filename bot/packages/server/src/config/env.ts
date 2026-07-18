import { z } from "zod";

const envSchema = z.object({
  // Telegram
  BOT_TOKEN: z.string().min(1),
  ADMIN_ID: z.string().transform(Number).pipe(z.number().int().positive()),

  // Database
  DB_PATH: z.string().default("/var/lib/vpn-bot/data.db"),

  // Server A (cascade mode only — empty or unset = standalone mode)
  SERVER_A_HOST: z.string().default(""),
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

  // Server country codes (2-letter ISO, e.g. "RU", "NL" — auto-resolved by Ansible GeoIP)
  SERVER_A_COUNTRY: z.string().default(""),
  SERVER_B_COUNTRY: z.string().default(""),

  // Server A relay port (TCP relay entry)
  SERVER_A_RELAY_PORT: z.string().transform(Number).pipe(z.number().int()).default("443"),
  // Server A Hysteria 2 relay entry (UDP; port_a_udp). Mirrors SERVER_A_RELAY_PORT
  // for the UDP/QUIC relay path. Unused in standalone (no relay URI).
  SERVER_A_HY2_PORT: z.string().transform(Number).pipe(z.number().int()).default("443"),

  // Hysteria 2 (sing-box) — direct-only in phase 1. HY2_HOST may be a bare IP even
  // when HY2_DOMAIN is a real domain: Hy2 validates the cert by sni=, not by host.
  HY2_ENABLED: z.string().transform((v) => v === "true" || v === "1").default("false"),
  HY2_HOST: z.string().default(""),
  HY2_DOMAIN: z.string().default(""),
  HY2_PORT: z.string().transform(Number).pipe(z.number().int()).default("443"),
  SINGBOX_CONFIG_FILE: z.string().default("/etc/sing-box/config.json"),
  SINGBOX_OBFS_FILE: z.string().default("/etc/sing-box/obfs.pw"),
  SINGBOX_V2RAY_API_PORT: z.string().transform(Number).pipe(z.number().int()).default("10086"),
  // Static uplink password for the WG-over-Hy2 cascade (phase 3). Empty in phase 1.
  HY2_UPLINK_PASSWORD: z.string().default(""),

  // TMA (Telegram Web App)
  TMA_PORT: z.string().transform(Number).pipe(z.number().int()).default("3000"),
  TMA_DOMAIN: z.string().optional(),
  TMA_URL: z.string().url().optional(),

  // Maintenance (on-demand update/reboot). These must stay in lockstep with the
  // Ansible-rendered helper and path units on BOTH hosts, hence env-configurable
  // (unlike the xray/singbox restart triggers, which are local to Server B).
  MAINTENANCE_STATE_DIR: z.string().default("/var/lib/vpn-maintenance"),
  MAINTENANCE_TRIGGER_DIR: z.string().default("/run/vpn-maintenance"),
  MAINTENANCE_AGENT_BIN: z.string().default("/usr/local/sbin/vpn-maintenance"),

  // Timezone offset for daily traffic grouping (e.g. "+3:00" for Moscow)
  TZ_OFFSET: z.string().default("+3:00"),

  // OpenAI API key for AI-powered update summaries (optional — degrades gracefully)
  OPENAI_API_KEY: z.string().optional(),

  // Log level gate (read early by logger from process.env; validated here for docs)
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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

/** Standalone mode: no entry node (Server A), XRay-only deployment */
export const isStandalone = !env.SERVER_A_HOST;
