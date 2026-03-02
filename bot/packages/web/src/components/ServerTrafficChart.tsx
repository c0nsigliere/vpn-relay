import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import type { ServerTrafficSnapshot } from "@vpn-relay/shared";
import { formatBytes, formatTs, formatTsDate } from "../utils/format";

const COLORS = {
  rx: "#89b4fa",  // blue — Download
  tx: "#a6e3a1",  // green — Upload
};

interface ServerTrafficChartProps {
  snapshots: ServerTrafficSnapshot[];
  period: string;
}

export function ServerTrafficChart({ snapshots, period }: ServerTrafficChartProps) {
  if (snapshots.length === 0) {
    return (
      <div className="text-center text-tg-hint py-8 text-sm">No traffic data yet.</div>
    );
  }

  const labelFn = period === "24h" ? formatTs : formatTsDate;

  // Downsample to at most 72 points
  const step = Math.max(1, Math.floor(snapshots.length / 72));
  const data = snapshots
    .filter((_, i) => i % step === 0)
    .map((s) => ({
      ts: labelFn(s.ts),
      rx: s.rx_bytes,
      tx: s.tx_bytes,
    }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="ts"
          tick={{ fontSize: 10, fill: "var(--tg-hint)" }}
          interval="preserveStartEnd"
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tickFormatter={formatBytes}
          tick={{ fontSize: 10, fill: "var(--tg-hint)" }}
          tickLine={false}
          axisLine={false}
          width={48}
        />
        <Tooltip
          formatter={(v: number) => formatBytes(v)}
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
        <Area type="monotone" dataKey="rx" name="↓ Download" stroke={COLORS.rx} fill={COLORS.rx} fillOpacity={0.15} dot={false} strokeWidth={1.5} isAnimationActive={false} />
        <Area type="monotone" dataKey="tx" name="↑ Upload" stroke={COLORS.tx} fill={COLORS.tx} fillOpacity={0.15} dot={false} strokeWidth={1.5} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
