import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../devices/bootAdmission/BootAdmissionGate";
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
import { BindingDiscoveryIncompleteError } from "./refusal";

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
 * The process-wide boot admission gates as the reconciler's capacity probe: a read-only
 * check for fresh creates and a held ledger admission before replacement deletes a device.
 * A backstop: each gate bounds its own sample at DEFAULT_SAMPLE_TIMEOUT_MS, and this deadline only
 * fires if the gate overruns that.
 */
export class GateBindingBootCapacity implements BindingBootCapacity {
  constructor(
    private readonly timer: Timer,
    private readonly assertAvailable: BindingBootCapacityAssertion = (platform, signal) =>
      assertBootCapacityAvailable(platform, { signal }),
    private readonly reserveCapacity: typeof reserveBootCapacity = reserveBootCapacity,
  ) {}

  /**
   * The replacement lookup and the gate's sample each get the BOOT_CAPACITY_CHECK_TIMEOUT_MS
   * backstop, the sample's starting after the lookup (#14495): a slow lookup must not eat into the
   * sample budget. `options.timeoutMs` still bounds the whole reservation.
   */
  async reserve(
    platform: BindingPlatform,
    options: BindingBootReservationOptions,
  ): Promise<BindingBootReservation> {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const deadlineMs = this.timer.now() + options.timeoutMs;
    const remainingMs = () => Math.max(0, deadlineMs - this.timer.now());
    const bounded = <T>(operation: () => Promise<T>) =>
      raceWithDeadline(operation, {
        timer: this.timer,
        timeoutMs: Math.min(remainingMs(), BOOT_CAPACITY_CHECK_TIMEOUT_MS),
        signal: options.signal,
        label: `Reserving ${platform} boot capacity`,
        onTimeout: () => controller.abort(),
        timeoutError: () =>
          new BootCapacityCheckTimeoutError(`Timed out reserving ${platform} boot capacity.`),
      });
    let acquired = false;
    let pending: BootSlotReservation | undefined;
    try {
      const resolveReplacingDeviceId = options.resolveReplacingDeviceId;
      const replacingDeviceId = resolveReplacingDeviceId
        ? await bounded(() => resolveReplacingDeviceId({ signal }))
        : options.replacingDeviceId;
      signal.throwIfAborted();
      const reservation = await bounded(async () => {
        pending = await this.reserveCapacity(platform, {
          ...options,
          replacingDeviceId,
          timeoutMs: Math.max(1, remainingMs()),
          signal,
        });
        if (signal.aborted) {
          pending.release();
          signal.throwIfAborted();
        }
        return pending;
      });
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
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<BindingCapacityCheck> {
    const timeoutMs = Math.min(
      options.timeoutMs ?? BOOT_CAPACITY_CHECK_TIMEOUT_MS,
      BOOT_CAPACITY_CHECK_TIMEOUT_MS,
    );
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      await raceWithDeadline(() => this.assertAvailable(platform, signal), {
        timer: this.timer,
        timeoutMs,
        signal: options.signal,
        label: `Checking ${platform} boot capacity`,
        onTimeout: () => controller.abort(),
        timeoutError: () =>
          new BootCapacityCheckTimeoutError(
            `Timed out after ${timeoutMs}ms checking ${platform} boot capacity.`,
          ),
      });
      return { kind: "available" };
    } catch (error) {
      return this.refusal(platform, error);
    } finally {
      controller.abort();
    }
  }

  private refusal(
    platform: BindingPlatform,
    error: unknown,
  ): Exclude<BindingCapacityCheck, { kind: "available" }> {
    if (error instanceof BootCapacityExhaustedError) {
      const { externalDevices, heldDevices } = error.details;
      return {
        kind: "exhausted",
        limit: error.limit,
        booted: error.booted,
        retryAfterMs: error.retryAfterMs,
        ...(externalDevices && externalDevices.length > 0 ? { externalDevices } : {}),
        ...(heldDevices && heldDevices.length > 0 ? { heldDevices } : {}),
      };
    }
    if (
      error instanceof BootedDeviceDiscoveryIncompleteError ||
      error instanceof BindingDiscoveryIncompleteError ||
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
