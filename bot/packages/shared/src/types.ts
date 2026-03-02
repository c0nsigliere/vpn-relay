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
}

export interface PatchClientRequest {
  action: "suspend" | "resume";
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
  trafficSparkline?: Array<{ ts: string; rx: number; tx: number }>;
  trafficTotal24h?: { rx: number; tx: number };
}

export type ServerId = "a" | "b";

export interface AggregateTrafficSnapshot {
  ts: string;
  wg_rx: number;
  wg_tx: number;
  xray_rx: number;
  xray_tx: number;
}

export interface ServerTrafficResponse {
  serverId: ServerId;
  snapshots: AggregateTrafficSnapshot[];
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
