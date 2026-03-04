import { AreaChart, Area, ResponsiveContainer } from "recharts";

interface SparklinePoint {
  ts: string;
  rx: number;
  tx: number;
}

interface SparklineProps {
  data: SparklinePoint[];
  /** Fixed pixel width. If omitted, fills container width. */
  width?: number;
  /** Fixed pixel height. Defaults to 40. */
  height?: number;
}

export function Sparkline({ data, width, height = 40 }: SparklineProps) {
  if (data.length === 0) {
    return <div className="w-full h-10 bg-tg-secondary rounded opacity-30" />;
  }

  const chart = (
    <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
      <Area
        type="monotone"
        dataKey="rx"
        stroke="#89b4fa"
        fill="#89b4fa"
        fillOpacity={0.15}
        strokeWidth={1}
        dot={false}
        isAnimationActive={false}
      />
      <Area
        type="monotone"
        dataKey="tx"
        stroke="#a6e3a1"
        fill="#a6e3a1"
        fillOpacity={0.15}
        strokeWidth={1}
        dot={false}
        isAnimationActive={false}
      />
    </AreaChart>
  );

  if (width !== undefined) {
    // Fixed-size chart (used in compact cards)
    return (
      <AreaChart
        width={width}
        height={height}
        data={data}
        margin={{ top: 2, right: 0, bottom: 0, left: 0 }}
      >
        <Area
          type="monotone"
          dataKey="rx"
          stroke="#89b4fa"
          fill="#89b4fa"
          fillOpacity={0.15}
          strokeWidth={1}
          dot={false}
          isAnimationActive={false}
        />
        <Area
          type="monotone"
          dataKey="tx"
          stroke="#a6e3a1"
          fill="#a6e3a1"
          fillOpacity={0.15}
          strokeWidth={1}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      {chart}
    </ResponsiveContainer>
  );
}
