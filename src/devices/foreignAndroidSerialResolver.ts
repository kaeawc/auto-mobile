import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer } from "../utils/SystemTimer";
import type { ForeignAndroidSerialSource } from "./deviceDiscoveryContracts";

/**
 * Bind a lazily-set ownership source into the resolver the Android scanner calls. A failed or
 * absent source means "nothing is foreign": ownership is positive evidence only, so enrichment
 * stays conservative. Cancellation propagates to the caller.
 */
export function createForeignAndroidSerialResolver(
  source: () => ForeignAndroidSerialSource | undefined,
): (serials: readonly string[], signal?: AbortSignal) => Promise<ReadonlySet<string>> {
  return async (serials, signal) => {
    try {
      return await raceWithDeadline(
        source()?.foreignSerials(serials, signal) ?? Promise.resolve(new Set<string>()),
        { timer: defaultTimer, signal, label: "Android inventory ownership refresh" },
      );
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DeviceManager] Android ownership refresh failed: ${errorMessage(error)}`,
        error,
      );
      return new Set<string>();
    }
  };
}
