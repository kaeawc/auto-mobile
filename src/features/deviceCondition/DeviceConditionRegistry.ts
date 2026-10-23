import type { BootedDevice } from "../../models";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import {
  DeviceConditionController,
  type DeviceConditionInjector,
} from "./DeviceConditionController";
import { resolvePowerFaultInjector } from "./powerFaultInjectors";
import { resolveStorageFaultInjector } from "./storageFaultInjectors";
import { resolveRootStateInjector } from "./rootStateInjector";
import {
  deviceConditionInputIsMeaningful,
  type DeviceConditionInput,
  type DeviceConditionKey,
  type DeviceConditionResult,
} from "./DeviceConditionTypes";

/**
 * Who owns a device-condition controller. A session binds the controller's
 * lifetime to its lease; a sessionless (direct-mode) caller owns conditions until
 * an explicit reset, exactly like the sessionless clock and network paths.
 */
export interface DeviceConditionOwner {
  deviceId: string;
  sessionUuid?: string;
  /**
   * The booted device, carried on an apply so the resolver can build device-scoped
   * injectors. Release/rebind restore calls key by `deviceId` and omit it — they
   * run already-registered resets and never re-resolve, so the apply-time device
   * captured in the controller's resolver closure is the one that matters.
   */
  device?: BootedDevice;
}

/** Resolves the injector for a condition key; children register real injectors here (#14060, …). */
export type DeviceConditionInjectorResolver = (
  owner: DeviceConditionOwner,
  key: DeviceConditionKey,
) => DeviceConditionInjector | undefined;

interface ControllerSlot {
  controller: DeviceConditionController;
  owner: DeviceConditionOwner;
  leaseHandle?: NodeJS.Timeout;
  leaseExpiresAt?: number;
}

/**
 * Session-scoped home for the `deviceCondition` surface (#14050). It owns one
 * controller per (owner, device), the lease timer that restores on expiry, and
 * the restore that release/rebind runs — the "always restore to a clean state"
 * invariant the whole epic depends on, mirroring `sessionNetworkCondition`.
 *
 * It deliberately lives outside `SessionManager`: a device-condition controller
 * carries no persisted state and nothing on the device until an injector lands,
 * so it hooks the existing `onSessionRelease`/`onSessionDeviceUnbound` callback
 * seams (as `registerNetworkStateSessionCleanup` does) rather than growing a new
 * generation-counter/TTL subsystem inside the session manager.
 */
export class DeviceConditionRegistry {
  private readonly slots = new Map<string, ControllerSlot>();

  constructor(
    private readonly resolveInjector: DeviceConditionInjectorResolver,
    private readonly timer: Timer = defaultTimer,
  ) {}

  private slotKey(owner: DeviceConditionOwner): string {
    return `${owner.sessionUuid ?? "sessionless"}\u0000${owner.deviceId}`;
  }

  private getOrCreateSlot(owner: DeviceConditionOwner): ControllerSlot {
    const key = this.slotKey(owner);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        controller: new DeviceConditionController((conditionKey) =>
          this.resolveInjector(owner, conditionKey),
        ),
        owner,
      };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** Drop a slot once it holds nothing and owes no lease. */
  private pruneSlot(owner: DeviceConditionOwner): void {
    const key = this.slotKey(owner);
    const slot = this.slots.get(key);
    if (slot && !slot.controller.hasActiveConditions() && slot.leaseHandle === undefined) {
      this.slots.delete(key);
    }
  }

  private clearLease(slot: ControllerSlot): void {
    if (slot.leaseHandle !== undefined) {
      this.timer.clearTimeout(slot.leaseHandle);
      slot.leaseHandle = undefined;
      slot.leaseExpiresAt = undefined;
    }
  }

  /**
   * Apply one request. A fresh lease cancels and replaces any prior one; a
   * request with no lease and nothing left active drops the slot. Lease expiry
   * restores the device just like release.
   */
  async apply(
    owner: DeviceConditionOwner,
    input: DeviceConditionInput,
  ): Promise<DeviceConditionResult> {
    const slot = this.getOrCreateSlot(owner);
    // A new request always cancels the prior lease first; it is re-armed below only
    // if this request both leaves conditions active AND carries a TTL.
    this.clearLease(slot);
    const result = await slot.controller.apply(input);
    if (
      owner.sessionUuid &&
      input.expiresInSeconds !== undefined &&
      input.expiresInSeconds > 0 &&
      slot.controller.hasActiveConditions()
    ) {
      this.armLease(owner, slot, input.expiresInSeconds);
      result.leaseExpiresAt = slot.leaseExpiresAt;
    }
    this.pruneSlot(owner);
    return result;
  }

  private armLease(owner: DeviceConditionOwner, slot: ControllerSlot, seconds: number): void {
    slot.leaseExpiresAt = this.timer.now() + seconds * 1000;
    const handle = this.timer.setTimeout(() => {
      slot.leaseHandle = undefined;
      slot.leaseExpiresAt = undefined;
      void this.restoreSlot(owner, slot, "lease expiry");
    }, seconds * 1000);
    handle.unref?.();
    slot.leaseHandle = handle;
  }

  /** True while `owner` holds any applied condition on its device. */
  hasActiveConditions(owner: DeviceConditionOwner): boolean {
    return this.slots.get(this.slotKey(owner))?.controller.hasActiveConditions() ?? false;
  }

  /** The wall-clock ms an owner's lease fires, if one is armed. */
  leaseExpiresAt(owner: DeviceConditionOwner): number | undefined {
    return this.slots.get(this.slotKey(owner))?.leaseExpiresAt;
  }

  /**
   * Restore every condition `owner` applied on its device and drop the slot. Safe
   * to call when nothing is active (no-op). Returns whether the device read clean.
   */
  async restore(owner: DeviceConditionOwner): Promise<boolean> {
    const slot = this.slots.get(this.slotKey(owner));
    if (!slot) {
      return true;
    }
    return this.restoreSlot(owner, slot, "explicit restore");
  }

  private async restoreSlot(
    owner: DeviceConditionOwner,
    slot: ControllerSlot,
    reason: string,
  ): Promise<boolean> {
    this.clearLease(slot);
    try {
      const report = await slot.controller.restore();
      if (!report.verifiedClean) {
        logger.warn(
          `[deviceCondition] ${reason} for ${owner.deviceId} left ${report.failures.length} condition(s) unrestored`,
        );
      }
      return report.verifiedClean;
    } catch (error) {
      logger.warn(
        `[deviceCondition] ${reason} for ${owner.deviceId} threw: ${errorMessage(error)}`,
        error,
      );
      return false;
    } finally {
      this.pruneSlot(owner);
    }
  }

  /** Drop everything a session owned across all its devices (release of the whole session). */
  restoreSession(sessionUuid: string): Promise<boolean[]> {
    const pending: Promise<boolean>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.owner.sessionUuid === sessionUuid) {
        pending.push(this.restoreSlot(slot.owner, slot, "session release"));
      }
    }
    return Promise.all(pending);
  }

  /** Validate a request has something to do, matching the surface's refinement. */
  static isMeaningful(input: DeviceConditionInput): boolean {
    return deviceConditionInputIsMeaningful(input);
  }
}

/**
 * Default resolver: the root fixture (#14060), power-domain fault injectors
 * (#14063) and storage fault injectors (#14066) on an Android device. The integrity
 * injector (#14062) adds its key here as it lands.
 * Returns undefined for a key with no injector, which the controller reports as
 * `unsupported` rather than silently dropping.
 */
const defaultInjectorResolver: DeviceConditionInjectorResolver = (owner, key) =>
  owner.device
    ? (resolveRootStateInjector(owner.device, key) ??
      resolvePowerFaultInjector(owner.device, key) ??
      resolveStorageFaultInjector(owner.device, key))
    : undefined;

/**
 * Process-wide registry for the `deviceCondition` surface. It lives in the feature
 * layer (not `src/server`) so both the tool handler and the daemon's release
 * cleanup can import it without crossing the import-direction tiers.
 */
export const defaultDeviceConditionRegistry = new DeviceConditionRegistry(defaultInjectorResolver);
