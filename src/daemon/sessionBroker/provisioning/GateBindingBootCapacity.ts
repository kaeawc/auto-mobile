import { BootCapacityCheckTimeoutError } from "./BootCapacityCheckTimeoutError";
import { assertBootCapacityAvailable } from "../../../features/bootAdmission/sharedBootAdmissionGates";
import { BootCapacityExhaustedError } from "../../../models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../../models/BootedDeviceDiscoveryIncompleteError";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { type BindingBootCapacity, type BindingCapacityCheck } from "./reconciler";
import type { BindingPlatform } from "../registry/bindingRegistry";
import { type BindingBootCapacityAssertion } from "./reconcilerPorts";

const BOOT_CAPACITY_CHECK_TIMEOUT_MS = 5_000;

/**
 * The process-wide boot admission gates as the reconciler's capacity probe: the same read-only
 * check the provision path runs before creating a device, asked before a replacement deletes one.
 * Bounded, because the simulator fleet sample has no deadline of its own.
 */
export class GateBindingBootCapacity implements BindingBootCapacity {
  constructor(
    private readonly timer: Timer,
    private readonly assertAvailable: BindingBootCapacityAssertion = (platform, signal) =>
      assertBootCapacityAvailable(platform, { signal }),
  ) {}

  async check(
    platform: BindingPlatform,
    options: { signal?: AbortSignal },
  ): Promise<BindingCapacityCheck> {
    try {
      await raceWithDeadline(() => this.assertAvailable(platform, options.signal), {
        timer: this.timer,
        timeoutMs: BOOT_CAPACITY_CHECK_TIMEOUT_MS,
        signal: options.signal,
        label: `Checking ${platform} boot capacity`,
        timeoutError: () =>
          new BootCapacityCheckTimeoutError(
            `Timed out after ${BOOT_CAPACITY_CHECK_TIMEOUT_MS}ms checking ${platform} boot capacity.`,
          ),
      });
      return { kind: "available" };
    } catch (error) {
      if (error instanceof BootCapacityExhaustedError) {
        const { externalDevices } = error.details;
        return {
          kind: "exhausted",
          limit: error.limit,
          booted: error.booted,
          retryAfterMs: error.retryAfterMs,
          ...(externalDevices && externalDevices.length > 0 ? { externalDevices } : {}),
        };
      }
      if (
        error instanceof BootedDeviceDiscoveryIncompleteError ||
        error instanceof BootCapacityCheckTimeoutError
      ) {
        // A count that could not be read in time is unknown, never free capacity.
        logger.warn(
          `[Bindings] ${platform} boot capacity is unknown: ${errorMessage(error)}`,
          error,
        );
        return { kind: "unknown", message: errorMessage(error) };
      }
      // Cancellation, or a defect: neither is a capacity answer, and a defect must not hide as a
      // retryable refusal.
      throw error;
    }
  }
}
