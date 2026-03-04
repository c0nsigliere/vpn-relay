interface QuotaProgressBarProps {
  label: string;
  usedBytes: number;
  quotaBytes: number;
}

function formatGb(bytes: number): string {
  const gb = bytes / 1_073_741_824;
  return gb < 10 ? gb.toFixed(2) : gb.toFixed(1);
}

export function QuotaProgressBar({ label, usedBytes, quotaBytes }: QuotaProgressBarProps) {
  const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;

  let barColor = "#a6e3a1"; // green
  if (pct >= 90) barColor = "#f38ba8"; // red
  else if (pct >= 70) barColor = "#f9e2af"; // yellow

  return (
    <div>
      <div className="flex justify-between text-xs text-tg-hint mb-1">
        <span>{label}</span>
        <span>{formatGb(usedBytes)} / {formatGb(quotaBytes)} GB</span>
      </div>
      <div className="h-2 rounded-full bg-tg overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: barColor }}
        />
      </div>
    </div>
  );
}
