/**
 * Updates service — fetches upgradable packages and changelogs from both servers.
 *
 * Server A: via SSH (sshPool)
 * Server B: local (execSync)
 *
 * `apt list --upgradable` output format:
 *   openssl/jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
 *
 * Security detection: source component contains "-security".
 */

import { execSync } from "child_process";
import { sshPool } from "./ssh";

export interface PackageInfo {
  name: string;
  oldVersion: string;
  newVersion: string;
  isSecurity: boolean;
}

export interface ChangelogSummary {
  cves: string[];
  summary: string; // first meaningful changelog line (trimmed)
}

const APT_LIST_CMD = "apt list --upgradable 2>/dev/null";

/**
 * Parse `apt list --upgradable` output into structured package info.
 * Lines look like: "openssl/jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]"
 * First line is always "Listing..." — skip it.
 */
function parseAptList(raw: string): PackageInfo[] {
  const packages: PackageInfo[] = [];
  for (const line of raw.split("\n")) {
    // Skip header and empty lines
    if (!line || line.startsWith("Listing") || !line.includes("[upgradable from:")) continue;

    const match = line.match(
      /^([^/]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s+(\S+)\]/
    );
    if (!match) continue;

    const [, name, source, newVersion, oldVersion] = match;
    packages.push({
      name,
      oldVersion,
      newVersion,
      isSecurity: source.includes("-security"),
    });
  }
  return packages;
}

export async function getUpgradablePackages(server: "a" | "b"): Promise<PackageInfo[]> {
  const raw = server === "a"
    ? await sshPool.exec(APT_LIST_CMD)
    : execSync(APT_LIST_CMD, { encoding: "utf8", timeout: 30_000 });
  return parseAptList(raw);
}

/**
 * Fetch changelogs for a list of packages in a single batched command.
 * Uses `===PKG:name===` delimiters to split output.
 */
export async function getChangelogs(
  server: "a" | "b",
  packageNames: string[]
): Promise<Map<string, string>> {
  if (packageNames.length === 0) return new Map();

  // Build a for-loop that echoes delimiters between each package's changelog
  const pkgList = packageNames.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
  const cmd = `for pkg in ${pkgList}; do echo "===PKG:$pkg==="; apt-get changelog "$pkg" 2>/dev/null | head -40; done`;

  let raw: string;
  if (server === "a") {
    raw = await sshPool.exec(cmd, 120_000);
  } else {
    raw = execSync(cmd, { encoding: "utf8", timeout: 120_000 });
  }

  const result = new Map<string, string>();
  const chunks = raw.split(/===PKG:([^=]+)===/);
  // chunks: ["", "openssl", "\nchangelog text...", "curl", "\nchangelog text...", ...]
  for (let i = 1; i < chunks.length; i += 2) {
    const pkgName = chunks[i].trim();
    const changelog = (chunks[i + 1] ?? "").trim();
    if (changelog) result.set(pkgName, changelog);
  }

  return result;
}

/**
 * Extract CVEs and a short summary from raw changelog text using regex.
 *
 * Ubuntu changelogs follow a consistent format:
 *   package (version) suite; urgency=...
 *
 *     * SECURITY UPDATE: description of the fix
 *       - CVE-2024-1234
 *     * Some other change description
 *
 * We extract:
 *   - All CVE-YYYY-NNNNN patterns
 *   - First line starting with "* " as the summary (stripped of "SECURITY UPDATE:" prefix)
 */
const CVE_RE = /CVE-\d{4}-\d{4,}/g;

export function parseChangelog(raw: string): ChangelogSummary {
  // Extract all unique CVEs
  const cveSet = new Set<string>();
  for (const m of raw.matchAll(CVE_RE)) {
    cveSet.add(m[0]);
  }

  // Find first meaningful bullet line as summary
  let summary = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Skip header lines (package name, empty, --maintainer)
    if (!trimmed.startsWith("* ") && !trimmed.startsWith("- ")) continue;
    let text = trimmed.replace(/^[*-]\s+/, "").trim();
    // Strip common prefixes
    text = text.replace(/^SECURITY UPDATE:\s*/i, "");
    // Skip lines that are just CVE references
    if (/^CVE-\d{4}-\d{4,}$/.test(text)) continue;
    if (text.length > 0) {
      // Truncate long summaries
      summary = text.length > 100 ? text.slice(0, 97) + "..." : text;
      break;
    }
  }

  return { cves: [...cveSet], summary };
}
