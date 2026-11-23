import type { IosSimulatorNetworkShaper } from "../features/utility/ios/IosSimulatorNetworkShaper";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/**
 * Unshape every iOS Simulator a crashed or stopped daemon left shaped (#19045). The
 * device-wide restore slot lives in session memory, so after a restart nothing else would
 * undo it. A profile whose writing process is still running (a peer daemon on the same data
 * dir) is kept.
 */
export async function sweepStaleNetworkShaperProfiles(
  shaper: Pick<IosSimulatorNetworkShaper, "clearOrphaned">,
): Promise<string[]> {
  try {
    const cleared = await shaper.clearOrphaned();
    if (cleared.length > 0) {
      logger.info(
        `[NetworkShaper] Unshaped ${cleared.length} simulator(s) left shaped: ${cleared.join(", ")}`,
      );
    }
    return cleared;
  } catch (error) {
    logger.warn(
      `[NetworkShaper] Startup shaper-profile sweep failed: ${errorMessage(error)}`,
      error,
    );
    return [];
  }
}
