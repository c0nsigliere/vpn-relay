// ─── Domain types ───────────────────────────────────────────────────────────

export type ClientType = "wg" | "xray" | "both" | "hysteria2";

export interface Client {
  id: string;
  name: string;
  type: ClientType;
  wg_ip: string | null;
  wg_pubkey: string | null;
  xray_uuid: string | null;
  hy2_password: string | null;
  created_at: string;
  expires_at: string | null;
  is_active: number; // 1 = active, 0 = suspended
  last_seen_at: string | null;
  daily_quota_gb: number | null;
  monthly_quota_gb: number | null;
  suspend_reason: "manual" | "daily_quota" | "monthly_quota" | "expired" | "abnormal_traffic" | null;
  last_ip: string | null;
  last_ip_isp: string | null;
  // "direct" (client → exit node B) or "relay" (client → entry node A → B).
  // Set for xray/both (TCP relay) and hysteria2 (phase 4 UDP relay).
  last_connection_route: "direct" | "relay" | null;
  // WG cascade uplink transport: which A→B tunnel this client's WireGuard traffic
  // takes. Only meaningful for wg/both clients; ignored for xray/hysteria2.
  wg_cascade_transport: WgCascadeTransport;
  // Opaque 192-bit capability token for GET /sub/<token>. NULL for wg-only and
  // other non-subscription-capable rows. Anyone holding it can read this client's
  // full credentials — treat it like a password, never log it.
  sub_token: string | null;
}

// Transport for the WG cascade uplink (Server A → Server B). Extensible.
export type WgCascadeTransport = "xray" | "hy2";

export interface ClientQuotaUsage {
  daily_used_bytes: number;
  daily_quota_bytes: number | null;
  monthly_used_bytes: number;
  monthly_quota_bytes: number | null;
}

export interface TrafficSnapshot {
  id: number;
  client_id: string;
  ts: string;
  wg_rx: number;
  wg_tx: number;
  xray_rx: number;
  xray_tx: number;
  hy2_rx: number;
  hy2_tx: number;
}

// ─── API request / response types ───────────────────────────────────────────

export interface CreateClientRequest {
  name: string;
  type: ClientType;
  ttlDays?: number;
  dailyQuotaGb?: number;
  monthlyQuotaGb?: number;
  // WG cascade uplink transport (wg clients only; ignored otherwise).
  wgCascadeTransport?: WgCascadeTransport;
}

export interface PatchClientRequest {
  action: "suspend" | "resume" | "rename" | "update-quota" | "update-expiry" | "set-transport";
  transport?: WgCascadeTransport;
  newName?: string;        // required when action === "rename"
  dailyQuotaGb?: number | null;
  monthlyQuotaGb?: number | null;
  expiresAt?: string | null; // ISO string or null; required when action === "update-expiry"
}

export interface ClientsResponse {
  clients: Client[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  error: string;
}

/**
 * Subscription link state for one client.
 *
 * Deliberately carries NO raw token: the TMA only ever needs the URL, and the
 * token is a bearer secret — there is no reason to hand it across one more hop.
 *
 * `capable` false = the client has no URI-representable credential (wg-only or a
 * malformed row); `url` null with capable=true = no public origin configured
 * (TMA_URL unset), which the UI must render as "requires a domain", not as a link.
 */
export interface SubInfoResponse {
  capable: boolean;
  url: string | null;
}

/** Result of rotate-and-send: `url` is always the NEW link, even when the send failed. */
export interface SubRotateResponse extends SubInfoResponse {
  sent: boolean;
}

// ─── Server status ───────────────────────────────────────────────────────────

export interface ServerStatus {
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  uptime: string;
  updatesAvailable: number;
  updatesTotalAvailable: number;
  rebootRequired: boolean;
  diskUsedGb?: number;
  diskTotalGb?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  loadAvg1?: number;
  loadAvg5?: number;
  loadAvg15?: number;
  throughputRxMbps?: number;
  throughputTxMbps?: number;
  pingMs?: number;
  pingLossPercent?: number;
}

export interface ServersStatusResponse {
  serverA?: ServerStatus | { error: string } | null;  // null = standalone mode
  serverB: ServerStatus | { error: string };
  serverAIp?: string | null;
  serverBIp?: string;
  serverACountry?: string | null;  // 2-letter ISO code, null in standalone
  serverBCountry?: string;         // 2-letter ISO code
  trafficSparklineA?: Array<{ ts: string; rx: number; tx: number }>;
  trafficSparklineB?: Array<{ ts: string; rx: number; tx: number }>;
  trafficTotal24hA?: { rx: number; tx: number };
  trafficTotal24hB?: { rx: number; tx: number };
  /** Deployment mode: true = single server, no entry node */
  standalone?: boolean;
  /** True when WG clients can choose the Hy2 cascade uplink (cascade + uplink configured) */
  wgHy2Available?: boolean;
  /** Active maintenance job, if any — drives the read-only progress pill on the dashboard */
  maintenanceA?: MaintenanceJob | null;
  maintenanceB?: MaintenanceJob | null;
}

export type ServerId = "a" | "b";

// ─── Maintenance (on-demand update / reboot) ───

export type MaintenanceAction = "update" | "update-reboot" | "reboot";

/** Terminal: succeeded | failed | unknown. The rest keep the job "active". */
export type MaintenanceStatus =
  | "queued"
  | "running"
  | "rebooting"
  | "succeeded"
  | "failed"
  | "unknown";

/** DB row (snake_case, like Client / AlertSetting). */
export interface MaintenanceJob {
  id: string;
  server_id: ServerId;
  action: MaintenanceAction;
  status: MaintenanceStatus;
  /** preflight | apt-update | dist-upgrade | clean | rebooting | done | busy */
  phase: string | null;
  requested_by: "tma" | "bot";
  /** /proc/sys/kernel/random/boot_id as of job start — how a reboot is distinguished from a hang */
  boot_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  reboot_at: string | null;
  exit_code: number | null;
  error: string | null;
  packages_upgraded: number | null;
  packages: string | null;
  log_tail: string | null;
}

export interface StartMaintenanceRequest {
  action: MaintenanceAction;
}

export interface MaintenanceStatusResponse {
  active: MaintenanceJob | null;
  last: MaintenanceJob | null;
}

export interface AggregateTrafficSnapshot {
  ts: string;
  wg_rx: number;
  wg_tx: number;
  xray_rx: number;
  xray_tx: number;
}

export interface ServerTrafficSnapshot {
  id: number;
  server_id: "a" | "b";
  ts: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface MonthlyTraffic {
  month: string;   // "YYYY-MM"
  rx_total: number;
  tx_total: number;
}

export interface DailyTraffic {
  day: string;      // "YYYY-MM-DD"
  rx_total: number;
  tx_total: number;
}

export interface ServerTrafficResponse {
  serverId: ServerId;
  snapshots: ServerTrafficSnapshot[];
}

// ─── Traffic ─────────────────────────────────────────────────────────────────

export interface TrafficTotals {
  wgRx: number;
  wgTx: number;
  xrayRx: number;
  xrayTx: number;
  hy2Rx: number;
  hy2Tx: number;
}

export interface ClientWithTraffic extends Client {
  traffic?: TrafficTotals;
  quota?: ClientQuotaUsage;
}

export interface ClientsWithTrafficResponse {
  clients: ClientWithTraffic[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TrafficHistoryResponse {
  clientName: string;
  snapshots: TrafficSnapshot[];
}

// ─── Backups ─────────────────────────────────────────────────────────────────

export type BackupTrigger = "scheduled" | "manual";

/**
 * `degraded` is the load-bearing one: a valid encrypted bundle exists locally but
 * did not reach Telegram, so a backup exists and is NOT off-site. It counts as
 * "a backup exists" for staleness, and still raises backup_failed so a persistent
 * delivery outage is visible rather than silently un-alarming.
 */
export type BackupStatus = "running" | "success" | "degraded" | "failed";

/** DB row (snake_case, like Client / MaintenanceJob). */
export interface BackupRun {
  id: string;
  trigger: BackupTrigger;
  status: BackupStatus;
  started_at: string;
  finished_at: string | null;
  bundle_bytes: number | null;
  db_bytes: number | null;
  /** 1 sent, 0 failed or skipped (too large) */
  telegram_ok: number | null;
  local_path: string | null;
  /** 0 when Server A was unreachable at backup time — the bundle still restores. */
  wg_key_included: number | null;
  error: string | null;
}

export interface DbInfoResponse {
  size: number;
  lastBackup: Pick<
    BackupRun,
    "finished_at" | "status" | "bundle_bytes" | "telegram_ok"
  > | null;
}

/**
 * Runtime-editable backup schedule. Lives in the DB, not in .env — the .env values
 * only seed it on first run, exactly like alert_settings seeds from code defaults.
 * Changing the Ansible variable after the first deploy therefore has no effect.
 */
export interface BackupConfig {
  enabled: boolean;
  /** 1 = daily, 7 = weekly. Grid is anchored so 7 lands on Mondays. */
  intervalDays: number;
  /** UTC hour of the run, 0-23. */
  hourUtc: number;
  /** Local bundles kept. Not runtime-editable — Ansible only. */
  retention: number;
  /** ISO timestamp of the next scheduled run, computed from the above. */
  nextRun: string;
}

export type UpdateBackupConfigRequest = Partial<
  Pick<BackupConfig, "enabled" | "intervalDays" | "hourUtc">
>;

/** Presets offered in the UI. Any other value is accepted as "custom". */
export const BACKUP_INTERVAL_PRESETS = [
  { days: 1, label: "Daily" },
  { days: 3, label: "Every 3 days" },
  { days: 7, label: "Weekly" },
] as const;

// ─── Alert settings ──────────────────────────────────────────────────────────

export type AlertKey =
  | "cascade_down"
  | "cascade_degradation"
  | "service_dead_xray"
  | "service_dead_singbox"
  | "service_dead_wg"
  | "disk_full"
  | "network_saturation"
  | "cpu_overload"
  | "abnormal_traffic"
  | "quota_warning"
  | "cert_expiry"
  | "reboot_detected"
  | "reboot_required"
  | "channel_capacity"
  | "updates_pending"
  | "backup_failed"
  | "backup_stale";

export interface AlertSetting {
  alert_key: string;
  enabled: number; // 1 = on, 0 = off
  threshold: number | null;
  threshold2: number | null;
  cooldown_min: number;
}

export interface AlertSettingsResponse {
  alerts: AlertSetting[];
}

export interface PatchAlertSettingRequest {
  enabled?: number;
  threshold?: number | null;
  threshold2?: number | null;
  cooldown_min?: number;
}
