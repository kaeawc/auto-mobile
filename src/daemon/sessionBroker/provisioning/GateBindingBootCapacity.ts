import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../devices/bootAdmission/BootAdmissionGate";
import { assertBootCapacityAvailable } from "../../../features/bootAdmission/sharedBootAdmissionGates";
import { BootCapacityExhaustedError } from "../../../models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../../models/BootedDeviceDiscoveryIncompleteError";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { type BindingBootCapacity, type BindingCapacityCheck } from "./reconciler";
import type { BindingPlatform } from "../registry/bindingRegistry";
import { BootCapacityCheckTimeoutError } from "./BootCapacityCheckTimeoutError";

/** Read-only "would one more cold boot of `platform` be refused now"; throws when it would. */
export type BindingBootCapacityAssertion = (
  platform: BindingPlatform,
  signal: AbortSignal | undefined,
) => Promise<void>;

/** Slack so the gate's own sample deadline, not this wrapper, is what ends a slow sample. */
const BOOT_CAPACITY_CHECK_GRACE_MS = 2_000;

/**
 * The gate lets its fresh fleet sample (`simctl list`, `ps`, `sysctl`) take DEFAULT_SAMPLE_TIMEOUT_MS
 * on a loaded host. An outer deadline shorter than that reported a count the gate would have
 * answered as unknown (#13801). This deadline is a backstop behind each gate's own sample
 * deadline; the gate also bounds its sample's commands, so a run it abandons ends too.
 */
export const BOOT_CAPACITY_CHECK_TIMEOUT_MS =
  DEFAULT_SAMPLE_TIMEOUT_MS + BOOT_CAPACITY_CHECK_GRACE_MS;

/**
 * The process-wide boot admission gates as the reconciler's capacity probe: the same read-only
 * check the provision path runs before creating a device, asked before a replacement deletes one.
 * A backstop: each gate bounds its own sample at DEFAULT_SAMPLE_TIMEOUT_MS, and this deadline only
 * fires if the gate overruns that.
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
