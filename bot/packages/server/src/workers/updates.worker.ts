/**
 * Updates worker — enriched package update alerts with changelogs and AI summaries.
 *
 * 2 tiers of message quality:
 *   Tier 1: Regex-parsed changelogs (CVEs + first bullet summary) — always works
 *           Optional: OpenAI polishes summaries into more readable descriptions
 *   Tier 2: Bare count fallback (apt list failed, uses apt-check counts)
 *
 * Integrates with the alert system (alert_settings / alert_state) for
 * enable/disable, cooldown, and hash-based dedup via alert_state.context.
 */

import { Bot } from "grammy";
import { createHash } from "crypto";
import type { BotContext } from "../bot/context";
import { systemService } from "../services/system.service";
import { getUpgradablePackages, getChangelogs, parseChangelog, type PackageInfo, type ChangelogSummary } from "../services/updates.service";
import { summarizeUpdates, type PackageSummary } from "../services/openai.service";
import { queries } from "../db/queries";
import { env } from "../config/env";
import { createLogger, logOnError } from "../utils/logger";

const logger = createLogger("updates");

const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_REGULAR_SHOWN = 5;
const MAX_MESSAGE_LEN = 4000;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Abbreviate version transition when versions share a long common prefix.
 * e.g. "3.0.2-0ubuntu1.14" → "3.0.2-0ubuntu1.15" becomes "3.0.2-0ubuntu1.14 → .15"
 */
function abbreviateVersion(oldVer: string, newVer: string): string {
  // Find the last common '.' or '-' boundary
  let commonEnd = 0;
  const minLen = Math.min(oldVer.length, newVer.length);
  for (let i = 0; i < minLen; i++) {
    if (oldVer[i] !== newVer[i]) break;
    if (oldVer[i] === "." || oldVer[i] === "-") commonEnd = i;
  }
  // Only abbreviate if we share a meaningful prefix (at least 4 chars)
  if (commonEnd >= 4) {
    return `${oldVer} → .${newVer.slice(commonEnd + 1)}`;
  }
  return `${oldVer} → ${newVer}`;
}

function computeHash(packages: PackageInfo[]): string {
  const data = packages
    .map((p) => `${p.name}:${p.newVersion}`)
    .sort()
    .join("|");
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Split a long message at the nearest `\n\n` boundary before maxLen.
 */
function splitMessage(text: string, maxLen = MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    parts.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
  }
  if (remaining) parts.push(remaining);
  return parts;
}

// ── Message formatting ──────────────────────────────────────────────────────

/**
 * Merge regex-parsed and AI summaries. AI takes precedence when available,
 * regex is the baseline that always works.
 */
function mergeSummary(
  pkgName: string,
  regexParsed: Map<string, ChangelogSummary>,
  aiSummaries: Map<string, PackageSummary> | null
): { cves: string[]; summary: string } {
  const ai = aiSummaries?.get(pkgName);
  const rx = regexParsed.get(pkgName);

  // CVEs: union of both sources (AI may find more context, regex catches all patterns)
  const cveSet = new Set<string>([...(rx?.cves ?? []), ...(ai?.cves ?? [])]);
  // Summary: prefer AI (more readable), fall back to regex
  const summary = ai?.summary || rx?.summary || "";

  return { cves: [...cveSet], summary };
}

function formatServerMessage(
  label: string,
  packages: PackageInfo[],
  regexParsed: Map<string, ChangelogSummary>,
  aiSummaries: Map<string, PackageSummary> | null
): string {
  const security = packages.filter((p) => p.isSecurity);
  const regular = packages.filter((p) => !p.isSecurity);

  const lines: string[] = [];
  lines.push(`📦 *${label}* — ${packages.length} update${packages.length !== 1 ? "s" : ""}`);
  lines.push("");

  if (security.length > 0) {
    lines.push(`🔒 *Security (${security.length}):*`);
    for (const pkg of security) {
      const ver = abbreviateVersion(pkg.oldVersion, pkg.newVersion);
      const pkgLink = `[${pkg.name}](https://launchpad.net/ubuntu/+source/${pkg.name}/+changelog)`;
      const { cves, summary } = mergeSummary(pkg.name, regexParsed, aiSummaries);
      lines.push(`• ${pkgLink} ${ver}`);
      if (cves.length > 0 || summary) {
        const cveStr = cves.length > 0
          ? cves.map((c) => `[${c}](https://nvd.nist.gov/vuln/detail/${c})`).join(", ")
          : "";
        const parts = [cveStr, summary].filter(Boolean);
        lines.push(`  ${parts.join(": ")}`);
      }
    }
    lines.push("");
  }

  if (regular.length > 0) {
    lines.push(`📦 *Regular (${regular.length}):*`);
    const shown = regular.slice(0, MAX_REGULAR_SHOWN);
    for (const pkg of shown) {
      const ver = abbreviateVersion(pkg.oldVersion, pkg.newVersion);
      const pkgLink = `[${pkg.name}](https://launchpad.net/ubuntu/+source/${pkg.name}/+changelog)`;
      const { summary } = mergeSummary(pkg.name, regexParsed, aiSummaries);
      if (summary) {
        lines.push(`• ${pkgLink} ${ver} — ${summary}`);
      } else {
        lines.push(`• ${pkgLink} ${ver}`);
      }
    }
    const remaining = regular.length - MAX_REGULAR_SHOWN;
    if (remaining > 0) {
      lines.push(`• … and ${remaining} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Tier 3 fallback — bare count from systemService (apt-check).
 */
function formatFallbackMessage(label: string, securityCount: number, totalCount: number): string | null {
  if (securityCount === 0 && totalCount === 0) return null;
  const parts: string[] = [];
  if (securityCount > 0) parts.push(`${securityCount} security`);
  if (totalCount > securityCount) parts.push(`${totalCount - securityCount} regular`);
  return `⚠️ *${label}*: ${parts.join(" + ")} updates pending.`;
}

// ── Alert integration ───────────────────────────────────────────────────────

function isEnabled(): boolean {
  const s = queries.getAlertSetting("updates_pending");
  return s ? s.enabled === 1 : true;
}

function shouldFire(stateKey: string): boolean {
  const state = queries.getAlertState(stateKey);
  if (!state || state.status === "clear") return true;
  const s = queries.getAlertSetting("updates_pending");
  const cooldownMin = s?.cooldown_min ?? 720;
  if (!state.fired_at) return true;
  const firedAt = new Date(state.fired_at).getTime();
  return (Date.now() - firedAt) >= cooldownMin * 60_000;
}

interface CachedContext {
  hash: string;
  message: string;
}

function getCachedContext(stateKey: string): CachedContext | null {
  const state = queries.getAlertState(stateKey);
  if (!state?.context) return null;
  try {
    return JSON.parse(state.context) as CachedContext;
  } catch {
    return null;
  }
}

// ── Per-server processing ───────────────────────────────────────────────────

async function processServer(
  server: "a" | "b",
  label: string,
  bot: Bot<BotContext>
): Promise<void> {
  const stateKey = `updates_pending:${server}`;

  // Step 1: Try enriched package list (Tier 1/2)
  let packages: PackageInfo[] | null = null;
  try {
    packages = await getUpgradablePackages(server);
  } catch (err) {
    logger.warn(`apt list failed for ${label}`, err);
  }

  // No packages available — try Tier 3 fallback
  if (packages === null) {
    try {
      const status = server === "a"
        ? await systemService.getStatusA()
        : await systemService.getStatusB();
      const msg = formatFallbackMessage(label, status.updatesAvailable, status.updatesTotalAvailable);
      if (msg && shouldFire(stateKey)) {
        queries.upsertAlertState(stateKey, "fired", JSON.stringify({ hash: "fallback", message: msg }));
        await sendMessages(bot, [msg]);
      }
    } catch (err) {
      logger.error(`Fallback also failed for ${label}`, err);
    }
    return;
  }

  // No updates pending — clear state and done
  if (packages.length === 0) {
    const state = queries.getAlertState(stateKey);
    if (state?.status === "fired") {
      queries.upsertAlertState(stateKey, "clear");
    }
    return;
  }

  // Step 2: Compute hash, check cache
  const hash = computeHash(packages);
  const cached = getCachedContext(stateKey);

  if (cached && cached.hash === hash) {
    // Package list unchanged — just check cooldown
    if (shouldFire(stateKey)) {
      queries.upsertAlertState(stateKey, "fired", JSON.stringify(cached));
      await sendMessages(bot, splitMessage(cached.message));
    }
    return;
  }

  // Step 3: Hash changed — fetch changelogs
  const security = packages.filter((p) => p.isSecurity);
  const regular = packages.filter((p) => !p.isSecurity);
  // Changelogs: always for security, capped for regular
  const changelogTargets = [
    ...security.map((p) => p.name),
    ...regular.slice(0, MAX_REGULAR_SHOWN).map((p) => p.name),
  ];

  let changelogs = new Map<string, string>();
  try {
    changelogs = await getChangelogs(server, changelogTargets);
  } catch (err) {
    logger.warn(`Changelog fetch failed for ${label}`, err);
  }

  // Step 4: Regex-parse changelogs (always works, no external deps)
  const regexParsed = new Map<string, ChangelogSummary>();
  for (const [name, text] of changelogs) {
    regexParsed.set(name, parseChangelog(text));
  }

  // Step 5: Optional AI polish (only if OPENAI_API_KEY is set)
  let aiSummaries: Map<string, PackageSummary> | null = null;
  if (changelogs.size > 0) {
    const forAI = changelogTargets
      .filter((name) => changelogs.has(name))
      .map((name) => ({
        name,
        changelog: changelogs.get(name)!,
        isSecurity: security.some((p) => p.name === name),
      }));
    aiSummaries = await summarizeUpdates(forAI);
  }

  // Step 6: Format and send
  const message = formatServerMessage(label, packages, regexParsed, aiSummaries);

  if (shouldFire(stateKey)) {
    queries.upsertAlertState(stateKey, "fired", JSON.stringify({ hash, message }));
    await sendMessages(bot, splitMessage(message));
  } else {
    // Still cache the new message even if cooldown hasn't expired
    queries.upsertAlertState(stateKey, "fired", JSON.stringify({ hash, message }));
  }
}

async function sendMessages(bot: Bot<BotContext>, parts: string[]): Promise<void> {
  for (const part of parts) {
    try {
      await bot.api.sendMessage(env.ADMIN_ID, part, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error("Send failed", err);
    }
  }
}

// ── Worker entry point ──────────────────────────────────────────────────────

export function updatesWorker(bot: Bot<BotContext>): { stop: () => void } {
  const run = async () => {
    if (!isEnabled()) return;
    logger.info("Checking for updates...");

    try {
      const results = await Promise.allSettled([
        processServer("a", "Server A", bot),
        processServer("b", "Server B", bot),
      ]);

      for (const r of results) {
        if (r.status === "rejected") {
          logger.error("Server check failed", r.reason);
        }
      }
    } catch (err) {
      logger.error("Worker error", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Run after 60s on startup to avoid false alerts during init
  const initTimer = setTimeout(() => run().catch(logOnError(logger, "initial run")), 60_000);

  logger.info("started (every 12h, first run in 60s)");
  return {
    stop: () => {
      clearInterval(timer);
      clearTimeout(initTimer);
    },
  };
}
