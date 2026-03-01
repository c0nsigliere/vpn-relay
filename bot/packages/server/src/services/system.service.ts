import * as fs from "fs";
import * as os from "os";
import { sshPool } from "./ssh";

export interface ServerStatus {
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  uptime: string;
  updatesAvailable: number;
  rebootRequired: boolean;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function parseLocalStatus(): Promise<ServerStatus> {
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

  // APT updates
  let updatesAvailable = 0;
  let rebootRequired = false;
  try {
    const { execSync } = await import("child_process");
    const aptOut = execSync("/usr/lib/update-notifier/apt-check 2>&1", {
      encoding: "utf8",
      timeout: 10000,
    });
    const match = aptOut.match(/^(\d+);(\d+)/);
    if (match) updatesAvailable = parseInt(match[2], 10); // security updates
    rebootRequired = fs.existsSync("/var/run/reboot-required");
  } catch {
    // apt-check not available or failed
  }

  return { cpuPercent, ramUsedMb, ramTotalMb, uptime, updatesAvailable, rebootRequired };
}

async function parseRemoteStatus(): Promise<ServerStatus> {
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

  // Uptime
  const uptimeSec = parseFloat((results[2] as string).split(" ")[0]);
  const uptime = formatUptime(uptimeSec);

  // Updates
  const aptOut = results[3] as string;
  const aptMatch = aptOut.match(/^(\d+);(\d+)/m);
  const updatesAvailable = aptMatch ? parseInt(aptMatch[2], 10) : 0;
  const rebootRequired = aptOut.includes("REBOOT:1");

  return { cpuPercent, ramUsedMb, ramTotalMb, uptime, updatesAvailable, rebootRequired };
}

class SystemService {
  async getStatusA(): Promise<ServerStatus> {
    return parseRemoteStatus();
  }

  async getStatusB(): Promise<ServerStatus> {
    return parseLocalStatus();
  }
}

export const systemService = new SystemService();
