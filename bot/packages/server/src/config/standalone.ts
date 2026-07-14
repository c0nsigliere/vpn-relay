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

import { env, isStandalone } from "./env";

export { isStandalone };

/**
 * Whether the WG cascade can route over Hysteria 2 (phase 3). True only in cascade
 * mode with a configured uplink password — which is exactly what brings up the
 * sing-box uplink on Server A and the static wg-clients@hy2 user on B. When false,
 * WG clients only have the XRay (VLESS) uplink and the Hy2 transport option is hidden.
 */
export const wgHy2Available = !isStandalone && env.HY2_UPLINK_PASSWORD.length > 0;

/** Throws if running in standalone mode. Use at the top of functions that require the entry node. */
export function requireCascade(feature = "This operation"): void {
  if (isStandalone) {
    throw new Error(`${feature} is not available in standalone mode (no entry node)`);
  }
}
