import { AreaChart, Area, ResponsiveContainer } from "recharts";

interface SparklinePoint {
  ts: string;
  rx: number;
  tx: number;
}

interface SparklineProps {
  data: SparklinePoint[];
}

export function Sparkline({ data }: SparklineProps) {
  if (data.length === 0) {
    return <div className="w-full h-10 bg-tg-secondary rounded opacity-30" />;
  }

  return (
    <ResponsiveContainer width="100%" height={40}>
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
    </ResponsiveContainer>
  );
}
