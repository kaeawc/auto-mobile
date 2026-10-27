import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { defaultTimer } from "../utils/SystemTimer";
import type { ForeignAndroidSerialSource } from "./deviceDiscoveryContracts";

let defaultSource: ForeignAndroidSerialSource | null = null;

/** Publish the live daemon source without a devices-to-daemon dependency. */
export function registerDefaultForeignAndroidSerialSource(
  source: ForeignAndroidSerialSource | null,
): () => void {
  defaultSource = source;
  return () => {
    if (defaultSource === source) {
      defaultSource = null;
    }
  };
}

/**
 * Read the explicit source or current registration on every scan. Without positive ownership
 * evidence, enrich normally. Cancellation propagates to the caller.
 */
export function createForeignAndroidSerialResolver(
  source: () => ForeignAndroidSerialSource | undefined,
): (serials: readonly string[], signal?: AbortSignal) => Promise<ReadonlySet<string>> {
  return async (serials, signal) => {
    try {
      return await raceWithDeadline(
        (source() ?? defaultSource)?.foreignSerials(serials, signal) ??
          Promise.resolve(new Set<string>()),
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
