import { ActionableError } from "../../models/ActionableError";
import type { ManagedDeviceEntry, SlotPlatform } from "./slotRegistry";

/**
 * Typed refusal for a generic caller (no managed slot of its own) that tried to lend, adopt, start,
 * stop, delete or drive a device a managed slot holds (#11174, #11178). An idle assigned device is
 * not a free device, so this is not retryable: the device frees only when its scope is reset.
 */
export const DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE = "device_assigned_to_managed_slot";

/**
 * The managed-slot registry has never been readable in this daemon, so it cannot tell which
 * devices are assigned. Unknown is never "free" (#11174): allocation refuses, retryably.
 */
export const MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE = "discovery_incomplete";

/** Retry hint while the registry is unreadable. */
export const MANAGED_SLOT_DISCOVERY_RETRY_AFTER_MS = 2_000;

export class DeviceAssignedToManagedSlotError extends ActionableError {
  readonly code = DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE;
  readonly retryable = false;
  readonly platform: SlotPlatform;
  readonly stableId: string;
  readonly scopeKey: string;
  /** The slot index holding the device, or null when it sits in the managed free pool. */
  readonly declaredSlot: number | null;

  constructor(
    action: string,
    readonly deviceId: string,
    entry: ManagedDeviceEntry,
  ) {
    super(
      `${action} refused: device '${deviceId}' (${entry.platform} ${entry.stableDeviceId}) is ` +
        (entry.holder === "slot"
          ? `assigned to managed slot ${entry.slotIndex}`
          : "reserved for managed slots") +
        ` (code ${DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE}). It stays reserved while idle; ` +
        "use another device, or reset the slot's scope to release it.",
    );
    this.name = "DeviceAssignedToManagedSlotError";
    this.platform = entry.platform;
    this.stableId = entry.stableDeviceId;
    this.scopeKey = entry.scopeKey;
    this.declaredSlot = entry.slotIndex;
  }

  /** The wire evidence: who holds the device, never a control credential. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      deviceId: this.deviceId,
      platform: this.platform,
      stableId: this.stableId,
      scopeKey: this.scopeKey,
      declaredSlot: this.declaredSlot,
      retryable: false,
    };
  }
}

export class ManagedSlotDiscoveryIncompleteError extends ActionableError {
  readonly code = MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE;
  readonly retryable = true;
  readonly retryAfterMs = MANAGED_SLOT_DISCOVERY_RETRY_AFTER_MS;

  constructor(cause: string) {
    super(
      `The managed-slot registry is unreadable (${cause}), so assigned devices cannot be told ` +
        `apart from free ones (code ${MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE}); retry shortly.`,
    );
    this.name = "ManagedSlotDiscoveryIncompleteError";
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, retryable: true, retryAfterMs: this.retryAfterMs };
  }
}
