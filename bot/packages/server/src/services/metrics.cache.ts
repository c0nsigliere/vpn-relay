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
import { requireCascade } from "../config/standalone";

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
    requireCascade("Server A metrics");
    if (this.cacheA && Date.now() - this.cacheA.fetchedAt < CACHE_TTL_MS) {
      return this.cacheA.value;
    }
    if (!this.fetchingA) {
      const p: Promise<ServerStatus> = systemService.getStatusA()
        .then((v) => {
          // Promise-identity guard: only the fetch we are still tracking may write the
          // cache. Without it, a fetch already in flight when invalidate() ran would
          // resolve afterwards and re-pin the pre-update reading for another TTL.
          if (this.fetchingA === p) {
            this.cacheA = { value: v, fetchedAt: Date.now() };
            this.fetchingA = null;
          }
          return v;
        })
        .catch((err) => {
          if (this.fetchingA === p) this.fetchingA = null;
          throw err;
        });
      this.fetchingA = p;
    }
    return this.fetchingA;
  }

  async getStatusB(): Promise<ServerStatus> {
    if (this.cacheB && Date.now() - this.cacheB.fetchedAt < CACHE_TTL_MS) {
      return this.cacheB.value;
    }
    if (!this.fetchingB) {
      const p: Promise<ServerStatus> = systemService.getStatusB()
        .then((v) => {
          if (this.fetchingB === p) {
            this.cacheB = { value: v, fetchedAt: Date.now() };
            this.fetchingB = null;
          }
          return v;
        })
        .catch((err) => {
          if (this.fetchingB === p) this.fetchingB = null;
          throw err;
        });
      this.fetchingB = p;
    }
    return this.fetchingB;
  }

  /**
   * Drop the cached reading for a server so the next caller re-measures.
   *
   * Called when a maintenance job finishes: apt has just changed the very numbers this
   * cache holds (updatesAvailable, rebootRequired), and a 20s-stale badge showing "12
   * updates" straight after a successful update reads as a bug.
   *
   * Detaching the in-flight promise is the important half — see the guard above.
   */
  invalidate(server: "a" | "b"): void {
    if (server === "a") {
      this.cacheA = null;
      this.fetchingA = null;
    } else {
      this.cacheB = null;
      this.fetchingB = null;
    }
  }
}

export const metricsCache = new MetricsCache();
