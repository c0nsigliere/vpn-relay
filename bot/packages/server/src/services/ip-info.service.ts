/**
 * ISP lookup via ip-api.com (free tier: 45 req/min for single, 15 req/min for batch).
 * In-memory cache keyed by IP — only re-lookup when a client's IP changes.
 */

import { createLogger } from "../utils/logger";

const logger = createLogger("ip-info");

interface IpApiResponse {
  status: "success" | "fail";
  isp?: string;
  query?: string;
}

class IpInfoService {
  private cache = new Map<string, string>(); // ip → isp

  /** Get cached ISP for an IP, or null if not cached */
  getCached(ip: string): string | null {
    return this.cache.get(ip) ?? null;
  }

  /**
   * Batch lookup ISP for up to 100 IPs.
   * Uses POST http://ip-api.com/batch (free, no key needed).
   * Returns Map<ip, isp>. Skips failures silently.
   */
  async lookupBatch(ips: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (ips.length === 0) return result;

    // Deduplicate and filter already-cached
    const uncached = [...new Set(ips)].filter((ip) => !this.cache.has(ip));
    if (uncached.length === 0) {
      for (const ip of ips) {
        const cached = this.cache.get(ip);
        if (cached) result.set(ip, cached);
      }
      return result;
    }

    // Batch API supports up to 100 IPs per request
    const batch = uncached.slice(0, 100);
    try {
      const res = await fetch("http://ip-api.com/batch?fields=status,isp,query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch.map((ip) => ({ query: ip }))),
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 429) {
        logger.warn("Rate limited, skipping batch lookup");
        return result;
      }

      if (!res.ok) return result;

      const data = (await res.json()) as IpApiResponse[];
      for (const item of data) {
        if (item.status === "success" && item.query && item.isp) {
          this.cache.set(item.query, item.isp);
          result.set(item.query, item.isp);
        }
      }
    } catch (err) {
      logger.warn(`Batch lookup failed: ${(err as Error).message}`);
    }

    // Also include previously-cached entries for requested IPs
    for (const ip of ips) {
      if (!result.has(ip)) {
        const cached = this.cache.get(ip);
        if (cached) result.set(ip, cached);
      }
    }

    return result;
  }
}

export const ipInfoService = new IpInfoService();
