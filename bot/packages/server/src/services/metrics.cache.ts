/**
 * MetricsCache — wraps systemService.getStatusA/B() with a 20s TTL.
 *
 * Two problems it solves:
 * 1. Throughput delta is calculated from previous readings; calling the service
 *    twice in a short window would produce wrong values on the second call.
 * 2. Each CPU measurement takes 500ms (two /proc/stat reads with a gap).
 *    Caching avoids this overhead on every alert tick and every API request.
 *
 * In-flight deduplication: if two callers request while the cache is stale,
 * only one underlying fetch is initiated; both callers receive the same result.
 */

import { systemService, ServerStatus } from "./system.service";

const CACHE_TTL_MS = 20_000;

interface CacheEntry {
  value: ServerStatus;
  fetchedAt: number;
}

class MetricsCache {
  private cacheA: CacheEntry | null = null;
  private cacheB: CacheEntry | null = null;
  private fetchingA: Promise<ServerStatus> | null = null;
  private fetchingB: Promise<ServerStatus> | null = null;

  async getStatusA(): Promise<ServerStatus> {
    if (this.cacheA && Date.now() - this.cacheA.fetchedAt < CACHE_TTL_MS) {
      return this.cacheA.value;
    }
    if (!this.fetchingA) {
      this.fetchingA = systemService.getStatusA()
        .then((v) => {
          this.cacheA = { value: v, fetchedAt: Date.now() };
          this.fetchingA = null;
          return v;
        })
        .catch((err) => {
          this.fetchingA = null;
          throw err;
        });
    }
    return this.fetchingA;
  }

  async getStatusB(): Promise<ServerStatus> {
    if (this.cacheB && Date.now() - this.cacheB.fetchedAt < CACHE_TTL_MS) {
      return this.cacheB.value;
    }
    if (!this.fetchingB) {
      this.fetchingB = systemService.getStatusB()
        .then((v) => {
          this.cacheB = { value: v, fetchedAt: Date.now() };
          this.fetchingB = null;
          return v;
        })
        .catch((err) => {
          this.fetchingB = null;
          throw err;
        });
    }
    return this.fetchingB;
  }
}

export const metricsCache = new MetricsCache();
