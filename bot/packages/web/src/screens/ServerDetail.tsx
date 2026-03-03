import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
} from "recharts";
import { Layout } from "../components/Layout";
import { ServerTrafficChart } from "../components/ServerTrafficChart";
import { fetchServersStatus, fetchServerTraffic, fetchServerMonthly, fetchServerDaily } from "../api/client";
import { formatBytesLong, formatMonth, formatDay } from "../utils/format";
import type { ServerId, ServerStatus } from "@vpn-relay/shared";

type Period = "24h" | "7d" | "30d";
type VolumeTab = "daily" | "monthly";

const PERIODS: Period[] = ["24h", "7d", "30d"];

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="text-tg-hint">{label}</div>
      <div className="text-tg">{value}</div>
    </>
  );
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 rounded-full bg-tg-secondary overflow-hidden mt-1">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

function cpuColor(pct: number): string {
  if (pct >= 85) return "#f38ba8";
  if (pct >= 60) return "#fab387";
  return "#a6e3a1";
}

function pingColor(ms: number, loss: number): string {
  if (loss > 0 || ms > 300) return "#f38ba8";
  if (ms > 150) return "#fab387";
  return "#a6e3a1";
}

export function ServerDetail() {
  const { id } = useParams<{ id: string }>();
  const serverId = id as ServerId;
  const [period, setPeriod] = useState<Period>("24h");
  const [volumeTab, setVolumeTab] = useState<VolumeTab>("daily");

  const { data: statusData, isLoading: statusLoading } = useQuery({
    queryKey: ["servers-status"],
    queryFn: fetchServersStatus,
    refetchInterval: 30_000,
    retry: false,
  });

  const { data: trafficData, isLoading: trafficLoading } = useQuery({
    queryKey: ["server-traffic", serverId, period],
    queryFn: () => fetchServerTraffic(serverId, period),
    enabled: !!serverId,
    retry: false,
  });

  const { data: monthlyData } = useQuery({
    queryKey: ["server-monthly", serverId],
    queryFn: () => fetchServerMonthly(serverId),
    enabled: !!serverId,
    retry: false,
  });

  const { data: dailyData } = useQuery({
    queryKey: ["server-daily", serverId],
    queryFn: () => fetchServerDaily(serverId),
    enabled: !!serverId && volumeTab === "daily",
    retry: false,
  });

  const isA = serverId === "a";
  const serverLabel = isA ? "Server A (entry)" : "Server B (exit)";
  const rawStatus = isA ? statusData?.serverA : statusData?.serverB;
  const status: ServerStatus | undefined =
    rawStatus && !("error" in rawStatus) ? rawStatus : undefined;
  const statusError: string | undefined =
    rawStatus && "error" in rawStatus ? rawStatus.error : undefined;

  const snapshots = trafficData?.snapshots ?? [];

  if (statusLoading) {
    return (
      <Layout backTo="/" title={serverLabel}>
        <div className="text-tg-hint py-8 text-center">Loading…</div>
      </Layout>
    );
  }

  const volumeBarData = volumeTab === "daily"
    ? (dailyData?.history ?? []).map((d) => ({ name: formatDay(d.day), rx: d.rx_total, tx: d.tx_total }))
    : [...(monthlyData?.history ?? [])].reverse().map((m) => ({ name: formatMonth(m.month).slice(0, 3), rx: m.rx_total, tx: m.tx_total }));

  return (
    <Layout backTo="/" title={serverLabel}>
      {statusError ? (
        <div className="bg-tg-secondary rounded-xl p-4 mb-4">
          <p className="text-tg-destructive text-sm">{statusError}</p>
        </div>
      ) : status ? (
        <div className="bg-tg-secondary rounded-xl p-4 mb-4 space-y-3">
          {/* CPU + Load */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-tg-hint">CPU</span>
              <span className="text-tg flex items-center gap-2">
                {status.cpuPercent.toFixed(0)}%
                {status.loadAvg1 !== undefined && (
                  <span className="text-tg-hint">
                    Load {status.loadAvg1.toFixed(2)} / {status.loadAvg5?.toFixed(2)} / {status.loadAvg15?.toFixed(2)}
                  </span>
                )}
              </span>
            </div>
            <ProgressBar value={status.cpuPercent} max={100} color={cpuColor(status.cpuPercent)} />
          </div>

          {/* RAM */}
          <div>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-tg-hint">RAM</span>
              <span className="text-tg">{status.ramUsedMb} / {status.ramTotalMb} MB</span>
            </div>
            <ProgressBar value={status.ramUsedMb} max={status.ramTotalMb} color="#89b4fa" />
          </div>

          {/* Swap */}
          {status.swapTotalMb !== undefined && status.swapTotalMb > 0 && (
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-tg-hint">Swap</span>
                <span className="text-tg">{status.swapUsedMb} / {status.swapTotalMb} MB</span>
              </div>
              <ProgressBar value={status.swapUsedMb ?? 0} max={status.swapTotalMb} color="#f9e2af" />
            </div>
          )}

          {/* Disk */}
          {status.diskTotalGb !== undefined && (
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-tg-hint">Disk</span>
                <span className="text-tg">{status.diskUsedGb} / {status.diskTotalGb} GB</span>
              </div>
              <ProgressBar value={status.diskUsedGb ?? 0} max={status.diskTotalGb} color="#cba6f7" />
            </div>
          )}

          {/* Throughput */}
          {(status.throughputRxMbps !== undefined || status.throughputTxMbps !== undefined) && (
            <div className="grid grid-cols-2 gap-2 text-sm pt-1">
              <StatRow
                label="Throughput ↓"
                value={status.throughputRxMbps !== undefined ? `${status.throughputRxMbps} Mbps` : "--"}
              />
              <StatRow
                label="Throughput ↑"
                value={status.throughputTxMbps !== undefined ? `${status.throughputTxMbps} Mbps` : "--"}
              />
            </div>
          )}

          {/* Ping */}
          {status.pingMs !== undefined && status.pingLossPercent !== undefined && (
            <div className="flex items-center gap-2 text-sm pt-1">
              <span
                className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: pingColor(status.pingMs, status.pingLossPercent) }}
              />
              <span className="text-tg-hint">A ↔ B Link:</span>
              <span className="text-tg">
                {status.pingLossPercent === 100
                  ? "unreachable"
                  : `${status.pingMs.toFixed(0)}ms (${status.pingLossPercent}% loss)`}
              </span>
            </div>
          )}

          {/* Uptime + badges */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-tg-hint">↑ {status.uptime}</span>
            {status.rebootRequired && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                Reboot required
              </span>
            )}
            {status.updatesAvailable > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
                {status.updatesAvailable} security update{status.updatesAvailable !== 1 ? "s" : ""}
              </span>
            )}
            {!status.rebootRequired && status.updatesAvailable === 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                Up to date
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* Network Speed chart */}
      <div className="bg-tg-secondary rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-tg">Network Speed</span>
          <div className="flex gap-1">
            {PERIODS.map((p) => (
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
        {trafficLoading ? (
          <div className="text-tg-hint text-sm text-center py-8">Loading…</div>
        ) : (
          <ServerTrafficChart snapshots={snapshots} period={period} />
        )}
      </div>

      {/* Traffic Volume */}
      <div className="bg-tg-secondary rounded-xl p-4 mt-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium text-tg">Traffic Volume</span>
          <div className="flex gap-1">
            {(["daily", "monthly"] as VolumeTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setVolumeTab(tab)}
                className={`px-2 py-0.5 rounded text-xs border capitalize ${
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
    </Layout>
  );
}
