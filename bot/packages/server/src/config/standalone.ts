/**
 * Standalone mode utilities.
 *
 * Standalone = single-server deployment (no entry node / Server A).
 * Detected at startup by empty SERVER_A_HOST env var.
 *
 * Two primitives:
 *   isStandalone  — boolean flag for conditional logic (ternaries, early returns)
 *   requireCascade() — hard guard that throws for operations requiring the entry node
 */

import { isStandalone } from "./env";

export { isStandalone };

/** Throws if running in standalone mode. Use at the top of functions that require the entry node. */
export function requireCascade(feature = "This operation"): void {
  if (isStandalone) {
    throw new Error(`${feature} is not available in standalone mode (no entry node)`);
  }
}
