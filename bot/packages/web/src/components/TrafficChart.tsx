import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { TrafficSnapshot, ClientType } from "@vpn-relay/shared";
import { formatTs, toMbps, formatMbps } from "../utils/format";

// Catppuccin-inspired palette matching the bot
const COLORS = {
  wgRx: "#89b4fa",   // blue
  wgTx: "#74c7ec",   // sky
  xrayRx: "#a6e3a1", // green
  xrayTx: "#94e2d5", // teal
};

interface TrafficChartProps {
  snapshots: TrafficSnapshot[];
  clientType: ClientType;
}

export function TrafficChart({ snapshots, clientType }: TrafficChartProps) {
  if (snapshots.length === 0) {
    return (
      <div className="text-center text-tg-hint py-8 text-sm">No traffic data yet.</div>
    );
  }

  // Downsample to at most 72 points for readability
  const step = Math.max(1, Math.floor(snapshots.length / 72));
  const data = snapshots
    .filter((_, i) => i % step === 0)
    .map((s) => ({
      ts: formatTs(s.ts),
      wgRx: toMbps(s.wg_rx),
      wgTx: toMbps(s.wg_tx),
      xrayRx: toMbps(s.xray_rx),
      xrayTx: toMbps(s.xray_tx),
    }));

  const showWg = clientType === "wg" || clientType === "both";
  const showXray = clientType === "xray" || clientType === "both";

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="ts"
          tick={{ fontSize: 10, fill: "var(--tg-hint)" }}
          interval="preserveStartEnd"
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={(v: number) => formatMbps(v)}
          tick={{ fontSize: 10, fill: "var(--tg-hint)" }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <Tooltip
          formatter={(v: number) => formatMbps(v)}
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
        {showWg && (
          <>
            <Line type="monotone" dataKey="wgRx" name="WG ↓" stroke={COLORS.wgRx} dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line type="monotone" dataKey="wgTx" name="WG ↑" stroke={COLORS.wgTx} dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </>
        )}
        {showXray && (
          <>
            <Line type="monotone" dataKey="xrayRx" name="XRay ↓" stroke={COLORS.xrayRx} dot={false} strokeWidth={1.5} isAnimationActive={false} />
            <Line type="monotone" dataKey="xrayTx" name="XRay ↑" stroke={COLORS.xrayTx} dot={false} strokeWidth={1.5} isAnimationActive={false} />
          </>
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}
