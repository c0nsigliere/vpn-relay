/** Parse a UTC timestamp string — appends 'Z' if missing so JS treats it as UTC */
function parseUtc(ts: string): Date {
  return new Date(ts.endsWith("Z") ? ts : ts + "Z");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${(bytes / 1073741824).toFixed(2)}GB`;
}

export function formatBytesLong(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function formatTs(ts: string): string {
  const d = parseUtc(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export function formatTsDate(ts: string): string {
  const d = parseUtc(ts);
  return `${(d.getMonth() + 1).toString().padStart(2, "0")}/${d.getDate().toString().padStart(2, "0")} ${d.getHours().toString().padStart(2, "0")}h`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-03" → "March 2026" */
export function formatMonth(month: string): string {
  const [year, m] = month.split("-");
  const idx = parseInt(m, 10) - 1;
  return `${MONTH_NAMES[idx] ?? m} ${year}`;
}

/** "2026-03-15" → "Mar 15" */
export function formatDay(day: string): string {
  const [, m, d] = day.split("-");
  return `${MONTH_SHORT[parseInt(m, 10) - 1] ?? m} ${parseInt(d, 10)}`;
}

/** Convert bytes transferred over a 10-minute interval to Mbps */
export function toMbps(bytes: number): number {
  return (bytes * 8) / (10 * 60) / 1_000_000;
}

/** Format Mbps value for display */
export function formatMbps(mbps: number): string {
  if (mbps < 0.001) return "0 Mbps";
  if (mbps < 1) return `${(mbps * 1000).toFixed(0)} Kbps`;
  return `${mbps.toFixed(2)} Mbps`;
}

/** Format a UTC timestamp as relative time ("2h ago", "Just now", etc.) */
export function formatRelativeTime(ts: string | null): string {
  if (!ts) return "Never";
  const d = parseUtc(ts);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}
