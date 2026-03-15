import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import { Layout } from "../components/Layout";
import { TrafficChart } from "../components/TrafficChart";
import { useTelegram } from "../hooks/useTelegram";
import {
  fetchClient, patchClient, deleteClient, sendConfig, renameClient,
  fetchTrafficHistory, fetchClientMonthly, fetchClientDaily, updateQuota, updateExpiry,
} from "../api/client";
import { QuotaProgressBar } from "../components/QuotaProgressBar";
import { formatBytesLong, formatMonth, formatDay, formatRelativeTime } from "../utils/format";

type Period = "24h" | "7d" | "14d";
type VolumeTab = "daily" | "monthly";

const PERIOD_LIMITS: Record<Period, number> = {
  "24h": 144,
  "7d": 1008,
  "14d": 2016,
};

const SUSPEND_REASON_LABEL: Record<string, string> = {
  manual: "Suspended (manual)",
  daily_quota: "Suspended (daily quota)",
  monthly_quota: "Suspended (monthly quota)",
  expired: "Suspended (expired)",
};

function clientStatus(isActive: boolean, lastSeenAt: string | null, suspendReason?: string | null) {
  if (!isActive) return { dot: "#f38ba8", label: SUSPEND_REASON_LABEL[suspendReason ?? ""] ?? "Suspended" };
  if (!lastSeenAt) return { dot: "#6c7086", label: "Offline" };
  const diffMs = Date.now() - new Date(lastSeenAt.endsWith("Z") ? lastSeenAt : lastSeenAt + "Z").getTime();
  const diffMin = diffMs / 60_000;
  if (diffMin <= 15) return { dot: "#a6e3a1", label: "Online" };
  if (diffMin <= 1440) return { dot: "#f9e2af", label: formatRelativeTime(lastSeenAt) };
  return { dot: "#6c7086", label: formatRelativeTime(lastSeenAt) };
}

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { haptic } = useTelegram();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<Period>("24h");
  const [volumeTab, setVolumeTab] = useState<VolumeTab>("daily");
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [editingQuota, setEditingQuota] = useState(false);
  const [quotaDaily, setQuotaDaily] = useState<string>("");
  const [quotaMonthly, setQuotaMonthly] = useState<string>("");
  const [editingExpiry, setEditingExpiry] = useState(false);
  const [expiryDate, setExpiryDate] = useState<string>("");

  const { data: client, isLoading, error } = useQuery({
    queryKey: ["client", id],
    queryFn: () => fetchClient(id!),
    enabled: !!id,
  });

  const { data: trafficData } = useQuery({
    queryKey: ["traffic", id, period],
    queryFn: () => fetchTrafficHistory(id!, PERIOD_LIMITS[period]),
    enabled: !!id,
  });

  const { data: monthlyData } = useQuery({
    queryKey: ["client-monthly", id],
    queryFn: () => fetchClientMonthly(id!),
    enabled: !!id,
  });

  const { data: dailyData } = useQuery({
    queryKey: ["client-daily", id],
    queryFn: () => fetchClientDaily(id!),
    enabled: !!id && volumeTab === "daily",
    retry: false,
  });

  const patchMutation = useMutation({
    mutationFn: (action: "suspend" | "resume") => patchClient(id!, { action }),
    onSuccess: () => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["client", id] });
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteClient(id!),
    onSuccess: () => {
      haptic.notification("success");
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      navigate("/clients");
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) => renameClient(id!, name),
    onSuccess: () => {
      haptic.notification("success");
      setRenaming(false);
      void queryClient.invalidateQueries({ queryKey: ["client", id] });
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const quotaMutation = useMutation({
    mutationFn: ({ daily, monthly }: { daily: number | null; monthly: number | null }) =>
      updateQuota(id!, daily, monthly),
    onSuccess: () => {
      haptic.notification("success");
      setEditingQuota(false);
      void queryClient.invalidateQueries({ queryKey: ["client", id] });
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const expiryMutation = useMutation({
    mutationFn: (expiresAt: string | null) => updateExpiry(id!, expiresAt),
    onSuccess: () => {
      haptic.notification("success");
      setEditingExpiry(false);
      void queryClient.invalidateQueries({ queryKey: ["client", id] });
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  const configMutation = useMutation({
    mutationFn: () => sendConfig(id!),
    onSuccess: () => {
      haptic.notification("success");
      alert("Config sent to your Telegram chat!");
    },
    onError: (err: Error) => {
      haptic.notification("error");
      alert(err.message);
    },
  });

  if (isLoading) {
    return <Layout backTo="/clients" title="Client"><div className="text-tg-hint py-8 text-center">Loading…</div></Layout>;
  }

  if (error || !client) {
    return <Layout backTo="/clients" title="Client"><div className="text-tg-destructive py-8 text-center">Client not found.</div></Layout>;
  }

  const typeLabel = client.type === "both" ? "WireGuard + XRay" : client.type.toUpperCase();
  const isActive = client.is_active === 1;
  const status = clientStatus(isActive, client.last_seen_at, client.suspend_reason);

  // Compute totals from snapshots
  const snapshots = trafficData?.snapshots ?? [];
  const totals = snapshots.reduce(
    (acc, s) => ({
      wgRx: acc.wgRx + s.wg_rx,
      wgTx: acc.wgTx + s.wg_tx,
      xrayRx: acc.xrayRx + s.xray_rx,
      xrayTx: acc.xrayTx + s.xray_tx,
    }),
    { wgRx: 0, wgTx: 0, xrayRx: 0, xrayTx: 0 }
  );

  const nameValid = /^[a-zA-Z0-9_]{1,32}$/.test(newName);

  const handleRenameStart = () => {
    setNewName(client.name);
    setRenaming(true);
  };

  const handleRenameSubmit = () => {
    if (!nameValid || newName === client.name) return;
    renameMutation.mutate(newName);
  };

  const handleEditQuotaStart = () => {
    setQuotaDaily(client.daily_quota_gb !== null ? String(client.daily_quota_gb) : "");
    setQuotaMonthly(client.monthly_quota_gb !== null ? String(client.monthly_quota_gb) : "");
    setEditingQuota(true);
  };

  const handleQuotaSave = () => {
    const daily = quotaDaily ? parseFloat(quotaDaily) : null;
    const monthly = quotaMonthly ? parseFloat(quotaMonthly) : null;
    quotaMutation.mutate({ daily, monthly });
  };

  const handleEditExpiryStart = () => {
    if (client?.expires_at) {
      // Extract YYYY-MM-DD from ISO string for <input type="date">
      setExpiryDate(client.expires_at.slice(0, 10));
    } else {
      // Default to 30 days from now
      const d = new Date(Date.now() + 30 * 86_400_000);
      setExpiryDate(d.toISOString().slice(0, 10));
    }
    setEditingExpiry(true);
  };

  const handleExpirySave = () => {
    if (!expiryDate) return;
    // Set to end of day UTC
    const iso = new Date(expiryDate + "T23:59:59Z").toISOString();
    expiryMutation.mutate(iso);
  };

  const handleExpiryRemove = () => {
    expiryMutation.mutate(null);
  };

  const handleDelete = () => {
    if (window.confirm(`Delete ${client.name}? This cannot be undone.`)) {
      deleteMutation.mutate();
    }
  };

  const volumeBarData = volumeTab === "daily"
    ? (dailyData?.history ?? []).map((d) => ({ name: formatDay(d.day), rx: d.rx_total, tx: d.tx_total }))
    : [...(monthlyData?.history ?? [])].reverse().map((m) => ({ name: formatMonth(m.month).slice(0, 3), rx: m.rx_total, tx: m.tx_total }));

  return (
    <Layout backTo="/clients" title={client.name}>
      {/* Rename inline */}
      {renaming && (
        <div className="bg-tg-secondary rounded-xl p-3 mb-4 flex gap-2 items-start">
          <div className="flex-1">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRenameSubmit(); if (e.key === "Escape") setRenaming(false); }}
              maxLength={32}
              className="w-full bg-tg rounded-lg px-3 py-2 text-sm text-tg outline-none border border-tg focus:border-tg-button"
              placeholder="New name"
            />
            {newName && !nameValid && (
              <div className="text-tg-destructive text-xs mt-1">Letters, digits, underscores only (max 32)</div>
            )}
          </div>
          <button
            onClick={handleRenameSubmit}
            disabled={!nameValid || newName === client.name || renameMutation.isPending}
            className="px-3 py-2 rounded-lg bg-tg-button text-tg-button text-sm font-medium disabled:opacity-40"
          >
            {renameMutation.isPending ? "..." : "Save"}
          </button>
          <button
            onClick={() => setRenaming(false)}
            className="px-3 py-2 rounded-lg bg-tg text-tg-hint text-sm border border-tg"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Info card */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-tg-hint">Status</div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs" style={{ color: status.dot }}>●</span>
            <span className="font-medium text-tg">{status.label}</span>
          </div>

          {client.last_ip && (
            <>
              <div className="text-tg-hint">Last IP</div>
              <div className="text-tg font-mono text-xs">
                {client.last_ip}
                {client.last_ip_isp && (
                  <span className="font-sans text-tg-hint ml-1">({client.last_ip_isp})</span>
                )}
              </div>
            </>
          )}

          {client.last_connection_route && (client.type === "xray" || client.type === "both") && (
            <>
              <div className="text-tg-hint">Route</div>
              <div>
                <span
                  className="text-xs px-1.5 py-0.5 rounded font-medium"
                  style={{
                    backgroundColor: client.last_connection_route === "direct" ? "#89b4fa20" : "#cba6f720",
                    color: client.last_connection_route === "direct" ? "#89b4fa" : "#cba6f7",
                  }}
                >
                  {client.last_connection_route === "direct" ? "Direct (Server B)" : "Relay (Server A)"}
                </span>
              </div>
            </>
          )}

          <div className="text-tg-hint">Type</div>
          <div className="text-tg">{typeLabel}</div>

          {client.wg_ip && (
            <>
              <div className="text-tg-hint">WG IP</div>
              <div className="text-tg font-mono text-xs">{client.wg_ip}</div>
            </>
          )}

          <div className="text-tg-hint">Expires</div>
          <div className="text-tg flex items-center gap-1.5">
            <span>{client.expires_at ? new Date(client.expires_at).toLocaleDateString() : "Never"}</span>
            <button
              onClick={handleEditExpiryStart}
              className="text-xs text-tg-hint border border-tg px-1.5 py-0 rounded"
            >
              {client.expires_at ? "Edit" : "Set"}
            </button>
          </div>

          <div className="text-tg-hint">Created</div>
          <div className="text-tg">{new Date(client.created_at).toLocaleDateString()}</div>

          {/* Traffic totals */}
          {(client.type === "wg" || client.type === "both") && (
            <>
              <div className="text-tg-hint">WG Traffic ({period})</div>
              <div className="text-tg text-xs">↓{formatBytesLong(totals.wgRx)} ↑{formatBytesLong(totals.wgTx)}</div>
            </>
          )}
          {(client.type === "xray" || client.type === "both") && (
            <>
              <div className="text-tg-hint">XRay Traffic ({period})</div>
              <div className="text-tg text-xs">↓{formatBytesLong(totals.xrayRx)} ↑{formatBytesLong(totals.xrayTx)}</div>
            </>
          )}
        </div>
      </div>

      {/* Quota section */}
      {(client.quota || client.daily_quota_gb !== null || client.monthly_quota_gb !== null) && (
        <div className="bg-tg-secondary rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-tg">Traffic Quota</span>
            <button
              onClick={handleEditQuotaStart}
              className="text-xs text-tg-hint border border-tg px-2 py-0.5 rounded"
            >
              Edit Quota
            </button>
          </div>
          <div className="space-y-3">
            {client.quota?.daily_quota_bytes != null && (
              <QuotaProgressBar
                label="Daily"
                usedBytes={client.quota.daily_used_bytes}
                quotaBytes={client.quota.daily_quota_bytes}
              />
            )}
            {client.quota?.monthly_quota_bytes != null && (
              <QuotaProgressBar
                label="Monthly"
                usedBytes={client.quota.monthly_used_bytes}
                quotaBytes={client.quota.monthly_quota_bytes}
              />
            )}
          </div>
        </div>
      )}

      {/* Edit Quota inline form */}
      {editingQuota && (
        <div className="bg-tg-secondary rounded-xl p-4 mb-4 space-y-3">
          <div className="text-sm font-medium text-tg mb-1">Edit Quota</div>
          <div>
            <label className="text-xs text-tg-hint block mb-1">Daily Quota (GB)</label>
            <input
              type="number"
              value={quotaDaily}
              onChange={(e) => setQuotaDaily(e.target.value)}
              placeholder="No limit"
              min="0.001"
              step="0.1"
              className="w-full bg-tg rounded-lg px-3 py-2 text-sm text-tg outline-none border border-tg focus:border-tg-button"
            />
          </div>
          <div>
            <label className="text-xs text-tg-hint block mb-1">Monthly Quota (GB)</label>
            <input
              type="number"
              value={quotaMonthly}
              onChange={(e) => setQuotaMonthly(e.target.value)}
              placeholder="No limit"
              min="0.001"
              step="1"
              className="w-full bg-tg rounded-lg px-3 py-2 text-sm text-tg outline-none border border-tg focus:border-tg-button"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleQuotaSave}
              disabled={quotaMutation.isPending}
              className="flex-1 px-3 py-2 rounded-lg bg-tg-button text-tg-button text-sm font-medium disabled:opacity-40"
            >
              {quotaMutation.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditingQuota(false)}
              className="px-3 py-2 rounded-lg bg-tg text-tg-hint text-sm border border-tg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Edit Expiry inline form */}
      {editingExpiry && (
        <div className="bg-tg-secondary rounded-xl p-4 mb-4 space-y-3">
          <div className="text-sm font-medium text-tg mb-1">Edit Expiry</div>
          <div>
            <label className="text-xs text-tg-hint block mb-1">Expiry Date</label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
              className="w-full bg-tg rounded-lg px-3 py-2 text-sm text-tg outline-none border border-tg focus:border-tg-button"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleExpirySave}
              disabled={!expiryDate || expiryMutation.isPending}
              className="flex-1 px-3 py-2 rounded-lg bg-tg-button text-tg-button text-sm font-medium disabled:opacity-40"
            >
              {expiryMutation.isPending ? "Saving…" : "Save"}
            </button>
            {client.expires_at && (
              <button
                onClick={handleExpiryRemove}
                disabled={expiryMutation.isPending}
                className="px-3 py-2 rounded-lg bg-tg text-tg-destructive text-sm border border-tg disabled:opacity-40"
              >
                Remove
              </button>
            )}
            <button
              onClick={() => setEditingExpiry(false)}
              className="px-3 py-2 rounded-lg bg-tg text-tg-hint text-sm border border-tg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Network Speed chart */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-tg">Network Speed</span>
          <div className="flex gap-1">
            {(["24h", "7d", "14d"] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  period === p
                    ? "bg-tg-button text-tg-button border-transparent"
                    : "bg-tg text-tg-hint border-tg"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <TrafficChart snapshots={snapshots} clientType={client.type} />
      </div>

      {/* Traffic Volume */}
      <div className="bg-tg-secondary rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-tg">Traffic Volume</span>
          <div className="flex gap-1">
            {(["daily", "monthly"] as VolumeTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setVolumeTab(tab)}
                className={`px-2 py-0.5 rounded text-xs border ${
                  volumeTab === tab
                    ? "bg-tg-button text-tg-button border-transparent"
                    : "bg-tg text-tg-hint border-tg"
                }`}
              >
                {tab === "daily" ? "Daily" : "Monthly"}
              </button>
            ))}
          </div>
        </div>
        {volumeBarData.length === 0 ? (
          <div className="text-tg-hint text-sm text-center py-4">No data yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <BarChart
              width={Math.max(volumeBarData.length * 28 + 60, 280)}
              height={200}
              data={volumeBarData}
              margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            >
              <XAxis
                dataKey="name"
                tick={{ fontSize: 10, fill: "var(--tg-hint)" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tickFormatter={formatBytesLong}
                tick={{ fontSize: 10, fill: "var(--tg-hint)" }}
                tickLine={false}
                axisLine={false}
                width={52}
              />
              <Tooltip
                formatter={(v: number) => formatBytesLong(v)}
                contentStyle={{
                  backgroundColor: "var(--tg-secondary-bg)",
                  border: "1px solid var(--tg-section-separator)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--tg-hint)", marginBottom: 4 }}
                itemStyle={{ color: "var(--tg-text)" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                formatter={(value) => <span style={{ color: "var(--tg-hint)" }}>{value}</span>}
              />
              <Bar dataKey="rx" name="↓ Download" fill="#89b4fa" stackId="a" isAnimationActive={false} />
              <Bar dataKey="tx" name="↑ Upload" fill="#a6e3a1" stackId="a" isAnimationActive={false} />
            </BarChart>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-2">
        <button
          onClick={handleRenameStart}
          disabled={renaming}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
        >
          Rename
        </button>

        <button
          onClick={handleEditQuotaStart}
          disabled={editingQuota}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
        >
          Edit Quota
        </button>

        <button
          onClick={handleEditExpiryStart}
          disabled={editingExpiry}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
        >
          {client.expires_at ? "Edit Expiry" : "Set Expiry"}
        </button>

        <button
          onClick={() => configMutation.mutate()}
          disabled={configMutation.isPending}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
        >
          {configMutation.isPending ? "Sending…" : "📩 Send Config to Chat"}
        </button>

        {isActive ? (
          <button
            onClick={() => patchMutation.mutate("suspend")}
            disabled={patchMutation.isPending}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            {patchMutation.isPending ? "Suspending…" : "⏸ Suspend"}
          </button>
        ) : (
          <button
            onClick={() => patchMutation.mutate("resume")}
            disabled={patchMutation.isPending}
            className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg font-medium text-sm border border-tg disabled:opacity-60"
          >
            {patchMutation.isPending ? "Resuming…" : "▶ Resume"}
          </button>
        )}

        <button
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
          className="w-full px-4 py-3 rounded-xl bg-tg-secondary text-tg-destructive font-medium text-sm border border-tg disabled:opacity-60"
        >
          {deleteMutation.isPending ? "Deleting…" : "🗑 Delete Client"}
        </button>
      </div>
    </Layout>
  );
}
