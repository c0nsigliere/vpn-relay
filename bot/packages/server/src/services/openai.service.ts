/**
 * OpenAI summarization — single-purpose wrapper around the chat completions API.
 *
 * Uses native fetch (Node 18+) to avoid the 120+ transitive deps of the `openai` npm package.
 * Returns null on any error — caller degrades to Tier 2 (list without summaries).
 */

import { env } from "../config/env";
import { createLogger } from "../utils/logger";

const logger = createLogger("openai");

export interface PackageSummary {
  summary: string;
  cves: string[];
}

interface OpenAIResponseItem {
  pkg: string;
  summary: string;
  cves: string[];
}

export async function summarizeUpdates(
  packages: Array<{ name: string; changelog: string; isSecurity: boolean }>
): Promise<Map<string, PackageSummary> | null> {
  if (!env.OPENAI_API_KEY) return null;
  if (packages.length === 0) return new Map();

  // Build a set of real CVEs per package to filter out hallucinated ones
  const realCves = new Map<string, Set<string>>();
  for (const p of packages) {
    const cves = new Set<string>();
    for (const m of p.changelog.matchAll(/CVE-\d{4}-\d{4,}/g)) cves.add(m[0]);
    realCves.set(p.name, cves);
  }

  const packageList = packages
    .map((p) => `### ${p.name} (${p.isSecurity ? "SECURITY" : "regular"})\n${p.changelog}`)
    .join("\n\n");

  const systemPrompt = `You summarize Linux package updates for a non-technical audience. Use a light, witty tone — like a sysadmin who's had just the right amount of coffee. Given changelogs, produce a JSON object with a "packages" array. Each element: {"pkg": "name", "summary": "witty plain-English explanation of the impact (max 160 chars)", "cves": ["CVE-XXXX-YYYY", ...]}.

Rules:
- Explain WHY the update matters, not internal code details. E.g. "Plugs a hole that let bad guys crash your VPN — rude!" instead of "Fix NULL-ptr deref in ssl_verify_cb".
- For security updates: describe the real-world risk (data leak, crash, remote access) with a dash of humor, and extract all CVE IDs.
- For regular updates: describe the user-visible improvement (faster, uses less memory, new feature) in a fun way.
- Keep summaries short, jargon-free, and entertaining. No abbreviations like "DoS" — write "denial of service".
- ONLY return CVE IDs that appear verbatim in the changelog text. Never invent, guess, or use placeholder CVE IDs.
- If no CVEs found in the text, return empty array.
- Return ONLY valid JSON.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-nano",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: packageList },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 2000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(`API returned ${response.status}: ${await response.text()}`);
      return null;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content) as { packages: OpenAIResponseItem[] };
    const result = new Map<string, PackageSummary>();
    for (const item of parsed.packages ?? []) {
      // Filter out hallucinated CVEs — only keep IDs that exist in the original changelog
      const allowed = realCves.get(item.pkg);
      const cves = (item.cves ?? []).filter((c) => allowed?.has(c));
      result.set(item.pkg, { summary: item.summary, cves });
    }
    return result;
  } catch (err) {
    logger.warn("Summarization failed", err);
    return null;
  }
}
