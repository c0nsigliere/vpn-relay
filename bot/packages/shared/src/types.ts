// ─── Domain types ───────────────────────────────────────────────────────────

export type ClientType = "wg" | "xray" | "both";

export interface Client {
  id: string;
  name: string;
  type: ClientType;
  wg_ip: string | null;
  wg_pubkey: string | null;
  xray_uuid: string | null;
  created_at: string;
  expires_at: string | null;
  is_active: number; // 1 = active, 0 = suspended
  last_seen_at: string | null;
  daily_quota_gb: number | null;
  monthly_quota_gb: number | null;
  suspend_reason: "manual" | "daily_quota" | "monthly_quota" | "expired" | "abnormal_traffic" | null;
  last_ip: string | null;
  last_ip_isp: string | null;
  last_connection_route: "direct" | "relay" | null;
}

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
}

// ─── API request / response types ───────────────────────────────────────────

export interface CreateClientRequest {
  name: string;
  type: ClientType;
  ttlDays?: number;
  dailyQuotaGb?: number;
  monthlyQuotaGb?: number;
}

export interface PatchClientRequest {
  action: "suspend" | "resume" | "rename" | "update-quota" | "update-expiry";
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

// ─── Server status ───────────────────────────────────────────────────────────

export interface ServerStatus {
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  uptime: string;
  updatesAvailable: number;
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
  serverA: ServerStatus | { error: string };
  serverB: ServerStatus | { error: string };
  serverAIp?: string;
  serverBIp?: string;
  trafficSparklineA?: Array<{ ts: string; rx: number; tx: number }>;
  trafficSparklineB?: Array<{ ts: string; rx: number; tx: number }>;
  trafficTotal24hA?: { rx: number; tx: number };
  trafficTotal24hB?: { rx: number; tx: number };
}

export type ServerId = "a" | "b";

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

// ─── Alert settings ──────────────────────────────────────────────────────────

export type AlertKey =
  | "cascade_down"
  | "cascade_degradation"
  | "service_dead_xray"
  | "service_dead_wg"
  | "disk_full"
  | "network_saturation"
  | "cpu_overload"
  | "abnormal_traffic"
  | "quota_warning"
  | "cert_expiry"
  | "reboot_detected"
  | "channel_capacity";

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
