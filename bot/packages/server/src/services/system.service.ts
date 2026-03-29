import * as fs from "fs";
import * as os from "os";
import { sshPool } from "./ssh";
import { requireCascade } from "../config/standalone";

export interface ServerStatus {
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  uptime: string;
  updatesAvailable: number;
  updatesTotalAvailable: number;
  rebootRequired: boolean;
  diskUsedGb?: number;
  diskTotalGb?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  loadAvg1?: number;
  loadAvg5?: number;
  loadAvg15?: number;
  throughputRxMbps?: number;
  throughputTxMbps?: number;
  pingMs?: number;
  pingLossPercent?: number;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Returns the first non-loopback interface found under /sys/class/net */
function detectLocalInterface(): string {
  try {
    const ifaces = fs.readdirSync("/sys/class/net").filter((i) => i !== "lo");
    // prefer eth0, else first
    return ifaces.includes("eth0") ? "eth0" : (ifaces[0] ?? "eth0");
  } catch {
    return "eth0";
  }
}

async function parseLocalStatus(
  lastNet: Map<"a" | "b", { ts: number; rx: number; tx: number }>
): Promise<ServerStatus> {
  // CPU: read /proc/stat twice with 500ms gap
  const readCpu = () => {
    const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + parts[4]; // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  const s1 = readCpu();
  await new Promise((r) => setTimeout(r, 500));
  const s2 = readCpu();

  const totalDiff = s2.total - s1.total;
  const idleDiff = s2.idle - s1.idle;
  const cpuPercent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;

  // RAM
  const ramTotalMb = Math.round(os.totalmem() / (1024 * 1024));
  const ramUsedMb = Math.round((os.totalmem() - os.freemem()) / (1024 * 1024));

  // Uptime
  const uptime = formatUptime(os.uptime());

  // Disk
  let diskUsedGb: number | undefined;
  let diskTotalGb: number | undefined;
  try {
    const stat = (fs as typeof fs & { statfsSync: (path: string) => { bsize: number; blocks: number; bfree: number } }).statfsSync("/");
    diskTotalGb = parseFloat(((stat.blocks * stat.bsize) / 1e9).toFixed(1));
    diskUsedGb = parseFloat((((stat.blocks - stat.bfree) * stat.bsize) / 1e9).toFixed(1));
  } catch {
    // statfsSync not available (Node < 19)
  }

  // Swap
  let swapUsedMb: number | undefined;
  let swapTotalMb: number | undefined;
  try {
    const memLines = fs.readFileSync("/proc/meminfo", "utf8")
      .split("\n")
      .reduce<Record<string, number>>((acc, line) => {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) acc[m[1]] = parseInt(m[2], 10);
        return acc;
      }, {});
    swapTotalMb = Math.round((memLines["SwapTotal"] ?? 0) / 1024);
    swapUsedMb = Math.round(((memLines["SwapTotal"] ?? 0) - (memLines["SwapFree"] ?? 0)) / 1024);
  } catch {
    // ignore
  }

  // Load average
  let loadAvg1: number | undefined;
  let loadAvg5: number | undefined;
  let loadAvg15: number | undefined;
  try {
    const loadStr = fs.readFileSync("/proc/loadavg", "utf8");
    const parts = loadStr.trim().split(/\s+/);
    loadAvg1 = parseFloat(parts[0]);
    loadAvg5 = parseFloat(parts[1]);
    loadAvg15 = parseFloat(parts[2]);
  } catch {
    // ignore
  }

  // Throughput
  let throughputRxMbps: number | undefined;
  let throughputTxMbps: number | undefined;
  try {
    const iface = detectLocalInterface();
    const rxBytes = parseInt(fs.readFileSync(`/sys/class/net/${iface}/statistics/rx_bytes`, "utf8").trim(), 10);
    const txBytes = parseInt(fs.readFileSync(`/sys/class/net/${iface}/statistics/tx_bytes`, "utf8").trim(), 10);
    const now = Date.now();
    const prev = lastNet.get("b");
    if (prev && rxBytes >= prev.rx && txBytes >= prev.tx) {
      const elapsedSec = (now - prev.ts) / 1000;
      if (elapsedSec > 0) {
        throughputRxMbps = parseFloat((((rxBytes - prev.rx) * 8) / 1_000_000 / elapsedSec).toFixed(2));
        throughputTxMbps = parseFloat((((txBytes - prev.tx) * 8) / 1_000_000 / elapsedSec).toFixed(2));
      }
    }
    lastNet.set("b", { ts: now, rx: rxBytes, tx: txBytes });
  } catch {
    // ignore
  }

  // APT updates
  let updatesAvailable = 0;
  let updatesTotalAvailable = 0;
  let rebootRequired = false;
  try {
    const { execSync } = await import("child_process");
    const aptOut = execSync("/usr/lib/update-notifier/apt-check 2>&1", {
      encoding: "utf8",
      timeout: 10000,
    });
    const match = aptOut.match(/^(\d+);(\d+)/);
    if (match) {
      updatesTotalAvailable = parseInt(match[1], 10); // all updates
      updatesAvailable = parseInt(match[2], 10);       // security updates
    }
    rebootRequired = fs.existsSync("/var/run/reboot-required");
  } catch {
    // apt-check not available or failed
  }

  return {
    cpuPercent,
    ramUsedMb,
    ramTotalMb,
    uptime,
    updatesAvailable,
    updatesTotalAvailable,
    rebootRequired,
    diskUsedGb,
    diskTotalGb,
    swapUsedMb,
    swapTotalMb,
    loadAvg1,
    loadAvg5,
    loadAvg15,
    throughputRxMbps,
    throughputTxMbps,
  };
}

async function parseRemoteStatus(
  lastNet: Map<"a" | "b", { ts: number; rx: number; tx: number }>
): Promise<ServerStatus> {
  // Run multiple commands via SSH and parse results
  const results = await Promise.all([
    sshPool.exec("cat /proc/stat").then((stat) => {
      const line = stat.split("\n")[0];
      const parts = line.split(/\s+/).slice(1).map(Number);
      const idle = parts[3] + parts[4];
      const total = parts.reduce((a: number, b: number) => a + b, 0);
      return { idle, total };
    }),
    sshPool.exec("cat /proc/meminfo"),
    sshPool.exec("cat /proc/uptime"),
    sshPool.exec(
      "bash -c '/usr/lib/update-notifier/apt-check 2>&1; echo EXIT:$?; test -f /var/run/reboot-required && echo REBOOT:1 || echo REBOOT:0'"
    ),
    sshPool.exec("df / --output=size,used -B1 | tail -1"),
    sshPool.exec("cat /proc/loadavg"),
    sshPool.exec(
      "IFACE=$(ls /sys/class/net | grep -v '^lo$' | head -1); cat /sys/class/net/$IFACE/statistics/rx_bytes /sys/class/net/$IFACE/statistics/tx_bytes"
    ),
  ]);

  // Wait 500ms and re-read CPU for delta
  await new Promise((r) => setTimeout(r, 500));
  const cpu2 = await sshPool.exec("cat /proc/stat").then((stat) => {
    const line = stat.split("\n")[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + parts[4];
    const total = parts.reduce((a: number, b: number) => a + b, 0);
    return { idle, total };
  });

  const totalDiff = cpu2.total - results[0].total;
  const idleDiff = cpu2.idle - results[0].idle;
  const cpuPercent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;

  // Memory
  const memLines = (results[1] as string)
    .split("\n")
    .reduce<Record<string, number>>((acc, line) => {
      const m = line.match(/^(\w+):\s+(\d+)/);
      if (m) acc[m[1]] = parseInt(m[2], 10);
      return acc;
    }, {});
  const ramTotalMb = Math.round((memLines["MemTotal"] ?? 0) / 1024);
  const ramUsedMb = Math.round(
    ((memLines["MemTotal"] ?? 0) - (memLines["MemAvailable"] ?? 0)) / 1024
  );
  const swapTotalMb = Math.round((memLines["SwapTotal"] ?? 0) / 1024);
  const swapUsedMb = Math.round(
    ((memLines["SwapTotal"] ?? 0) - (memLines["SwapFree"] ?? 0)) / 1024
  );

  // Uptime
  const uptimeSec = parseFloat((results[2] as string).split(" ")[0]);
  const uptime = formatUptime(uptimeSec);

  // Updates
  const aptOut = results[3] as string;
  const aptMatch = aptOut.match(/^(\d+);(\d+)/m);
  const updatesTotalAvailable = aptMatch ? parseInt(aptMatch[1], 10) : 0;
  const updatesAvailable = aptMatch ? parseInt(aptMatch[2], 10) : 0;
  const rebootRequired = aptOut.includes("REBOOT:1");

  // Disk: df output is "size used" in bytes
  let diskUsedGb: number | undefined;
  let diskTotalGb: number | undefined;
  try {
    const dfOut = (results[4] as string).trim().split(/\s+/);
    const totalBytes = parseInt(dfOut[0], 10);
    const usedBytes = parseInt(dfOut[1], 10);
    diskTotalGb = parseFloat((totalBytes / 1e9).toFixed(1));
    diskUsedGb = parseFloat((usedBytes / 1e9).toFixed(1));
  } catch {
    // ignore
  }

  // Load average
  let loadAvg1: number | undefined;
  let loadAvg5: number | undefined;
  let loadAvg15: number | undefined;
  try {
    const loadParts = (results[5] as string).trim().split(/\s+/);
    loadAvg1 = parseFloat(loadParts[0]);
    loadAvg5 = parseFloat(loadParts[1]);
    loadAvg15 = parseFloat(loadParts[2]);
  } catch {
    // ignore
  }

  // Throughput
  let throughputRxMbps: number | undefined;
  let throughputTxMbps: number | undefined;
  try {
    const netLines = (results[6] as string).trim().split("\n");
    const rxBytes = parseInt(netLines[0], 10);
    const txBytes = parseInt(netLines[1], 10);
    const now = Date.now();
    const prev = lastNet.get("a");
    if (prev && rxBytes >= prev.rx && txBytes >= prev.tx) {
      const elapsedSec = (now - prev.ts) / 1000;
      if (elapsedSec > 0) {
        throughputRxMbps = parseFloat((((rxBytes - prev.rx) * 8) / 1_000_000 / elapsedSec).toFixed(2));
        throughputTxMbps = parseFloat((((txBytes - prev.tx) * 8) / 1_000_000 / elapsedSec).toFixed(2));
      }
    }
    lastNet.set("a", { ts: now, rx: rxBytes, tx: txBytes });
  } catch {
    // ignore
  }

  return {
    cpuPercent,
    ramUsedMb,
    ramTotalMb,
    uptime,
    updatesAvailable,
    updatesTotalAvailable,
    rebootRequired,
    diskUsedGb,
    diskTotalGb,
    swapUsedMb,
    swapTotalMb,
    loadAvg1,
    loadAvg5,
    loadAvg15,
    throughputRxMbps,
    throughputTxMbps,
  };
}

class SystemService {
  private lastNet: Map<"a" | "b", { ts: number; rx: number; tx: number }> = new Map();

  async getStatusA(): Promise<ServerStatus> {
    requireCascade("Server A status");
    return parseRemoteStatus(this.lastNet);
  }

  async getStatusB(): Promise<ServerStatus> {
    return parseLocalStatus(this.lastNet);
  }
}

export const systemService = new SystemService();
