import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import { raceWithDeadline } from "./raceWithDeadline";
import type { Timer } from "./SystemTimer";

export interface BoundedAcquisitionCleanupOptions {
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  capMs: number;
  /** Names the work in the warning. */
  label: string;
}

class AcquisitionCleanupCapExceeded extends Error {}

/** Registers `cleanup` as acquisition cleanup that settles by `capMs` at the latest. */
export function registerBoundedAcquisitionCleanup(
  manager: {
    registerAcquisitionDeviceCleanup(
      deviceId: string,
      cleanup: Promise<unknown>,
      capMs?: number,
    ): void;
  },
  deviceId: string,
  cleanup: Promise<unknown>,
  options: BoundedAcquisitionCleanupOptions,
): void {
  const { timer, capMs, label } = options;
  const bounded = raceWithDeadline(cleanup, {
    timer,
    timeoutMs: capMs,
    unref: true,
    label,
    timeoutError: () => new AcquisitionCleanupCapExceeded(),
  }).then(
    () => undefined,
    (error: unknown) => {
      if (error instanceof AcquisitionCleanupCapExceeded) {
        logger.warn(
          `[acquisition cleanup] ${label} on ${deviceId} exceeded ${capMs}ms; the device is no longer held for it`,
        );
      } else {
        logger.warn(
          `[acquisition cleanup] Failed to ${label} on ${deviceId}: ${errorMessage(error)}`,
          error,
        );
      }
    },
  );
  manager.registerAcquisitionDeviceCleanup(deviceId, bounded, capMs);
}
