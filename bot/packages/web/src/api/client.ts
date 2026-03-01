/**
 * API client — wraps fetch with TMA Authorization header.
 * initData comes from Telegram.WebApp.initData (injected by telegram-web-app.js).
 */

import type { Client, ClientsResponse, CreateClientRequest, PatchClientRequest } from "@vpn-relay/shared";

function getInitData(): string {
  return (window as typeof window & { Telegram?: { WebApp?: { initData: string } } })
    ?.Telegram?.WebApp?.initData ?? "";
}

async function apiFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${getInitData()}`,
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

// ─── Clients ─────────────────────────────────────────────────────────────────

export function fetchClients(params: {
  search?: string;
  filter?: "all" | "active" | "suspended";
  type?: "all" | "wg" | "xray" | "both";
  page?: number;
}): Promise<ClientsResponse> {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.filter) q.set("filter", params.filter);
  if (params.type) q.set("type", params.type);
  if (params.page !== undefined) q.set("page", String(params.page));
  return apiFetch<ClientsResponse>(`/api/clients?${q}`);
}

export function fetchClient(id: string): Promise<Client> {
  return apiFetch<Client>(`/api/clients/${id}`);
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

export function deleteClient(id: string): Promise<void> {
  return apiFetch<void>(`/api/clients/${id}`, { method: "DELETE" });
}

export function sendConfig(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/clients/${id}/send-config`, {
    method: "POST",
  });
}
