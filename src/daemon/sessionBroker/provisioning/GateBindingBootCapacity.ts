import type { BootSlotReservation } from "../../../devices/bootAdmission/BootSlotReservation";
import type { BindingBootReservation, BindingBootReservationOptions } from "./reconcilerContracts";
import {
  assertBootCapacityAvailable,
  reserveBootCapacity,
} from "../../../features/bootAdmission/sharedBootAdmissionGates";
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

const BOOT_CAPACITY_CHECK_TIMEOUT_MS = 5_000;

/**
 * The process-wide boot admission gates as the reconciler's capacity probe: a read-only
 * check for fresh creates and a held ledger admission before replacement deletes a device.
 * Bounded, because the simulator fleet sample has no deadline of its own.
 */
export class GateBindingBootCapacity implements BindingBootCapacity {
  constructor(
    private readonly timer: Timer,
    private readonly assertAvailable: BindingBootCapacityAssertion = (platform, signal) =>
      assertBootCapacityAvailable(platform, { signal }),
    private readonly reserveCapacity: typeof reserveBootCapacity = reserveBootCapacity,
  ) {}

  async reserve(
    platform: BindingPlatform,
    options: BindingBootReservationOptions,
  ): Promise<BindingBootReservation> {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    let acquired = false;
    let pending: BootSlotReservation | undefined;
    try {
      const reservation = await raceWithDeadline(
        async () => {
          const replacingDeviceId = options.resolveReplacingDeviceId
            ? await options.resolveReplacingDeviceId({ signal })
            : options.replacingDeviceId;
          signal.throwIfAborted();
          pending = await this.reserveCapacity(platform, { ...options, replacingDeviceId, signal });
          if (signal.aborted) {
            pending.release();
            signal.throwIfAborted();
          }
          return pending;
        },
        {
          timer: this.timer,
          timeoutMs: Math.min(options.timeoutMs, BOOT_CAPACITY_CHECK_TIMEOUT_MS),
          signal: options.signal,
          label: `Reserving ${platform} boot capacity`,
          onTimeout: () => controller.abort(),
          timeoutError: () =>
            new BootCapacityCheckTimeoutError(`Timed out reserving ${platform} boot capacity.`),
        },
      );
      acquired = true;
      return { kind: "available", reservation };
    } catch (error) {
      return this.refusal(platform, error);
    } finally {
      if (!acquired) {
        controller.abort();
        pending?.release();
      }
    }
  }

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
      return this.refusal(platform, error);
    }
  }

  private refusal(
    platform: BindingPlatform,
    error: unknown,
  ): Exclude<BindingCapacityCheck, { kind: "available" }> {
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
      logger.warn(`[Bindings] ${platform} boot capacity is unknown: ${errorMessage(error)}`, error);
      return { kind: "unknown", message: errorMessage(error) };
    }
    // Cancellation, or a defect: neither is a capacity answer, and a defect must not hide as a
    // retryable refusal.
    throw error;
  }
}
