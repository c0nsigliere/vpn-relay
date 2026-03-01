"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.systemService = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const ssh_1 = require("./ssh");
function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h ${m}m`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}
async function parseLocalStatus() {
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
        const { execSync } = await Promise.resolve().then(() => __importStar(require("child_process")));
        const aptOut = execSync("/usr/lib/update-notifier/apt-check 2>&1", {
            encoding: "utf8",
            timeout: 10000,
        });
        const match = aptOut.match(/^(\d+);(\d+)/);
        if (match)
            updatesAvailable = parseInt(match[2], 10); // security updates
        rebootRequired = fs.existsSync("/var/run/reboot-required");
    }
    catch {
        // apt-check not available or failed
    }
    return { cpuPercent, ramUsedMb, ramTotalMb, uptime, updatesAvailable, rebootRequired };
}
async function parseRemoteStatus() {
    // Run multiple commands via SSH and parse results
    const results = await Promise.all([
        ssh_1.sshPool.exec("cat /proc/stat").then((stat) => {
            const line = stat.split("\n")[0];
            const parts = line.split(/\s+/).slice(1).map(Number);
            const idle = parts[3] + parts[4];
            const total = parts.reduce((a, b) => a + b, 0);
            return { idle, total };
        }),
        ssh_1.sshPool.exec("cat /proc/meminfo"),
        ssh_1.sshPool.exec("cat /proc/uptime"),
        ssh_1.sshPool.exec("bash -c '/usr/lib/update-notifier/apt-check 2>&1; echo EXIT:$?; test -f /var/run/reboot-required && echo REBOOT:1 || echo REBOOT:0'"),
    ]);
    // Wait 500ms and re-read CPU for delta
    await new Promise((r) => setTimeout(r, 500));
    const cpu2 = await ssh_1.sshPool.exec("cat /proc/stat").then((stat) => {
        const line = stat.split("\n")[0];
        const parts = line.split(/\s+/).slice(1).map(Number);
        const idle = parts[3] + parts[4];
        const total = parts.reduce((a, b) => a + b, 0);
        return { idle, total };
    });
    const totalDiff = cpu2.total - results[0].total;
    const idleDiff = cpu2.idle - results[0].idle;
    const cpuPercent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
    // Memory
    const memLines = results[1]
        .split("\n")
        .reduce((acc, line) => {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m)
            acc[m[1]] = parseInt(m[2], 10);
        return acc;
    }, {});
    const ramTotalMb = Math.round((memLines["MemTotal"] ?? 0) / 1024);
    const ramUsedMb = Math.round(((memLines["MemTotal"] ?? 0) - (memLines["MemAvailable"] ?? 0)) / 1024);
    // Uptime
    const uptimeSec = parseFloat(results[2].split(" ")[0]);
    const uptime = formatUptime(uptimeSec);
    // Updates
    const aptOut = results[3];
    const aptMatch = aptOut.match(/^(\d+);(\d+)/m);
    const updatesAvailable = aptMatch ? parseInt(aptMatch[2], 10) : 0;
    const rebootRequired = aptOut.includes("REBOOT:1");
    return { cpuPercent, ramUsedMb, ramTotalMb, uptime, updatesAvailable, rebootRequired };
}
class SystemService {
    async getStatusA() {
        return parseRemoteStatus();
    }
    async getStatusB() {
        return parseLocalStatus();
    }
}
exports.systemService = new SystemService();
//# sourceMappingURL=system.service.js.map