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
}

export interface ServersStatusResponse {
  serverA: ServerStatus | { error: string };
  serverB: ServerStatus | { error: string };
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
