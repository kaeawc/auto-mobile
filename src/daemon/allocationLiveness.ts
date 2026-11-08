import { PLATFORM_LABELS, type Platform } from "../models";
import { logger } from "../utils/logger";

/**
 * Why no idle device could be judged live: `false`, or the platform whose liveness discovery
 * source failed, so the refusal names that platform's inventory.
 */
export type LivenessUnknown = false | Platform;

/** The refusal for an allocation whose idle candidate's liveness source failed. */
export function livenessUnknownMessage(sessionId: string, platform: Platform): string {
  const label = PLATFORM_LABELS[platform];
  const noun = platform === "android" ? "device" : "simulator";
  return `Unable to verify ${label} ${noun} liveness for session ${sessionId}; ${label} discovery failed.`;
}

/** The warning for an idle candidate skipped because its liveness source failed. */
export function logLivenessUnknown(device: { id: string; platform: Platform }, noun: string): void {
  const label = PLATFORM_LABELS[device.platform];
  logger.warn(
    `[DevicePool] Cannot assign idle ${label} ${noun} ${device.id}: ` +
      `its ${label} liveness discovery source failed`,
  );
}
