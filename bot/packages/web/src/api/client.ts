/**
 * API client — wraps fetch with TMA Authorization header.
 * initData comes from Telegram.WebApp.initData (injected by telegram-web-app.js).
 */

import type {
  Client,
  ClientsResponse,
  ClientsWithTrafficResponse,
  CreateClientRequest,
  DailyTraffic,
  MonthlyTraffic,
  PatchClientRequest,
  ServersStatusResponse,
  ServerTrafficResponse,
  ServerId,
  TrafficHistoryResponse,
  AlertSetting,
  AlertSettingsResponse,
  PatchAlertSettingRequest,
  MaintenanceAction,
  MaintenanceJob,
  MaintenanceStatusResponse,
  DbInfoResponse,
  BackupConfig,
  UpdateBackupConfigRequest,
  SubInfoResponse,
  SubRotateResponse,
} from "@vpn-relay/shared";

function getInitData(): string {
  return (window as typeof window & { Telegram?: { WebApp?: { initData: string } } })
    ?.Telegram?.WebApp?.initData ?? "";
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `tma ${getInitData()}`,
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function apiFetchBlob(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(path, {
    headers: { Authorization: `tma ${getInitData()}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : "backup.db";
  return { blob, filename };
}

// ─── Clients ─────────────────────────────────────────────────────────────────

export function fetchClients(params: {
  search?: string;
  filter?: "all" | "active" | "suspended" | "quota_exceeded";
  type?: "all" | "wg" | "xray" | "both" | "hysteria2";
  page?: number;
}): Promise<ClientsResponse> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.filter) q.set("filter", params.filter);
  if (params.type) q.set("type", params.type);
  if (params.page !== undefined) q.set("page", String(params.page));
  return apiFetch<ClientsResponse>(`/api/clients?${q}`);
}

export function fetchClient(id: string): Promise<Client & { quota?: import("@vpn-relay/shared").ClientQuotaUsage }> {
  return apiFetch(`/api/clients/${id}`);
}

export function createClient(body: CreateClientRequest): Promise<{ client: Client }> {
  return apiFetch<{ client: Client }>("/api/clients", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function patchClient(id: string, body: PatchClientRequest): Promise<Client> {
  return apiFetch<Client>(`/api/clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function setTransport(id: string, transport: "xray" | "hy2"): Promise<Client> {
  return apiFetch<Client>(`/api/clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "set-transport", transport }),
  });
}

export function renameClient(id: string, newName: string): Promise<Client> {
  return apiFetch<Client>(`/api/clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "rename", newName }),
  });
}

export function deleteClient(id: string): Promise<void> {
  return apiFetch<void>(`/api/clients/${id}`, { method: "DELETE" });
}

export function updateQuota(id: string, dailyQuotaGb: number | null, monthlyQuotaGb: number | null): Promise<Client> {
  return apiFetch<Client>(`/api/clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "update-quota", dailyQuotaGb, monthlyQuotaGb }),
  });
}

export function updateExpiry(id: string, expiresAt: string | null): Promise<Client> {
  return apiFetch<Client>(`/api/clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "update-expiry", expiresAt }),
  });
}

export function sendConfig(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/clients/${id}/send-config`, {
    method: "POST",
  });
}

// ─── Subscription ───

export function fetchSubInfo(id: string): Promise<SubInfoResponse> {
  return apiFetch<SubInfoResponse>(`/api/clients/${id}/sub`);
}

export function sendSubLink(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/clients/${id}/sub/send`, { method: "POST" });
}

/**
 * Regenerate the link and push it to the admin chat.
 *
 * Resolves with the NEW url even when `sent` is false: rotation has already
 * invalidated the old link by then, so the caller must show the new one rather
 * than treat a delivery failure as "nothing happened".
 */
export function rotateAndSendSub(id: string): Promise<SubRotateResponse> {
  return apiFetch<SubRotateResponse>(`/api/clients/${id}/sub/rotate-and-send`, {
    method: "POST",
  });
}

export function fetchClientsWithTraffic(params: {
  search?: string;
  filter?: "all" | "active" | "suspended" | "quota_exceeded";
  type?: "all" | "wg" | "xray" | "both" | "hysteria2";
  page?: number;
}): Promise<ClientsWithTrafficResponse> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.filter) q.set("filter", params.filter);
  if (params.type) q.set("type", params.type);
  if (params.page !== undefined) q.set("page", String(params.page));
  q.set("withTraffic", "1");
  return apiFetch<ClientsWithTrafficResponse>(`/api/clients?${q}`);
}

export function fetchTrafficHistory(clientId: string, limit = 144): Promise<TrafficHistoryResponse> {
  return apiFetch<TrafficHistoryResponse>(`/api/clients/${clientId}/traffic?limit=${limit}`);
}

export function fetchServersStatus(): Promise<ServersStatusResponse> {
  return apiFetch<ServersStatusResponse>("/api/servers/status");
}

export function fetchServerTraffic(serverId: string, period: string): Promise<ServerTrafficResponse> {
  return apiFetch<ServerTrafficResponse>(`/api/servers/${serverId}/traffic?period=${period}`);
}

export function fetchServerMonthly(serverId: ServerId): Promise<{ serverId: ServerId; history: MonthlyTraffic[] }> {
  return apiFetch(`/api/servers/${serverId}/monthly`);
}

export function fetchClientMonthly(clientId: string): Promise<{ clientName: string; history: MonthlyTraffic[] }> {
  return apiFetch(`/api/clients/${clientId}/monthly`);
}

export function fetchServerDaily(serverId: ServerId): Promise<{ serverId: ServerId; history: DailyTraffic[] }> {
  return apiFetch(`/api/servers/${serverId}/daily`);
}

export function fetchClientDaily(clientId: string): Promise<{ clientId: string; history: DailyTraffic[] }> {
  return apiFetch(`/api/clients/${clientId}/daily`);
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

export function fetchMaintenance(serverId: ServerId): Promise<MaintenanceStatusResponse> {
  return apiFetch<MaintenanceStatusResponse>(`/api/servers/${serverId}/maintenance`);
}

export function startMaintenance(serverId: ServerId, action: MaintenanceAction): Promise<{ job: MaintenanceJob }> {
  return apiFetch<{ job: MaintenanceJob }>(`/api/servers/${serverId}/maintenance`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

// ─── Alert settings ───────────────────────────────────────────────────────────

export function fetchAlertSettings(): Promise<AlertSettingsResponse> {
  return apiFetch<AlertSettingsResponse>("/api/settings/alerts");
}

export function patchAlertSetting(key: string, body: PatchAlertSettingRequest): Promise<AlertSetting> {
  return apiFetch<AlertSetting>(`/api/settings/alerts/${key}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function fetchDbInfo(): Promise<DbInfoResponse> {
  return apiFetch<DbInfoResponse>("/api/settings/db-info");
}

export function fetchBackupConfig(): Promise<BackupConfig> {
  return apiFetch<BackupConfig>("/api/settings/backup-config");
}

export function patchBackupConfig(body: UpdateBackupConfigRequest): Promise<BackupConfig> {
  return apiFetch<BackupConfig>("/api/settings/backup-config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function downloadBackup(): Promise<void> {
  const { blob, filename } = await apiFetchBlob("/api/settings/backup");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
