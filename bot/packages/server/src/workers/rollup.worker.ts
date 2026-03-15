import { queries } from "../db/queries";
import { createLogger } from "../utils/logger";

const logger = createLogger("rollup");

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function rollupWorker(): { stop: () => void } {
  const run = () => {
    try {
      const clientCount = queries.rollupClientTraffic();
      const serverCount = queries.rollupServerTraffic();
      if (clientCount > 0 || serverCount > 0) {
        logger.info(`Rolled up ${clientCount} client snapshots, ${serverCount} server snapshots`);
      }
    } catch (err) {
      logger.error("Worker error", err);
    }
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Run once shortly after startup (avoid blocking startup path)
  setTimeout(run, 60_000);

  return { stop: () => clearInterval(timer) };
}
