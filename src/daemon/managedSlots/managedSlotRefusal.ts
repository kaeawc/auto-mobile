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

/** The same bounded retry hint while a live session's slot ownership is unconfirmed. */
export const MANAGED_SLOT_OWNERSHIP_RETRY_AFTER_MS = MANAGED_SLOT_DISCOVERY_RETRY_AFTER_MS;

export class ManagedSlotOwnershipUnconfirmedError extends ActionableError {
  readonly code = "managed_slot_ownership_unconfirmed";
  readonly retryable = true;
  readonly retryAfterMs = MANAGED_SLOT_OWNERSHIP_RETRY_AFTER_MS;

  constructor(readonly sessionUuid: string) {
    super(
      `Session '${sessionUuid}' slot ownership is not recorded for this daemon yet ` +
        "(the managed slot registry is busy or the slot is not ready); retry shortly.",
    );
    this.name = "ManagedSlotOwnershipUnconfirmedError";
  }

  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      sessionUuid: this.sessionUuid,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export class ManagedSlotOwnershipLostError extends ActionableError {
  readonly code = "managed_slot_ownership_lost";
  readonly retryable = false;

  constructor(readonly sessionUuid: string) {
    super(`Session '${sessionUuid}' no longer owns its managed slot; acquire a new session.`);
    this.name = "ManagedSlotOwnershipLostError";
  }

  toPayload(): Record<string, unknown> {
    return { code: this.code, sessionUuid: this.sessionUuid, retryable: this.retryable };
  }
}

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

/**
 * Typed refusal for a managed connection (a proxy launched with `--managed-slot-config`) that tried
 * to control, start, provision or delete anything outside its own initialized slots (#11178). Reads
 * stay open everywhere (owner decision Q6); only control and lifecycle are refused. Not retryable:
 * the connection's slot set is fixed for its lifetime.
 */
export const DEVICE_OUTSIDE_MANAGED_SLOTS_CODE = "device_outside_managed_slots";

/**
 * `device`: the target device is not one of the connection's slot devices. `session`: the call
 * named a session that is not one of the connection's slot sessions. `tool`: the tool acquires,
 * starts, stops, provisions or deletes devices, which a managed connection leaves to slot
 * acquisition and release; with a `deviceLabel`, a plan device label that would need a device from
 * outside the connection's slots (#11397). `scope`: a reset does not name exactly its own scope.
 * `host`: the action changes state shared by every connection of the daemon.
 */
export type ManagedConnectionRefusalReason = "device" | "session" | "tool" | "scope" | "host";

export class DeviceOutsideManagedSlotsError extends ActionableError {
  readonly code = DEVICE_OUTSIDE_MANAGED_SLOTS_CODE;
  readonly retryable = false;

  constructor(
    readonly action: string,
    readonly reason: ManagedConnectionRefusalReason,
    readonly scopeKey: string,
    readonly target: {
      deviceId?: string;
      sessionUuid?: string;
      deviceLabel?: string;
      platform?: string;
    } = {},
  ) {
    super(
      `${action} refused: this managed connection controls only its own slot devices ` +
        `(code ${DEVICE_OUTSIDE_MANAGED_SLOTS_CODE}). ` +
        managedConnectionRefusalDetail(reason, target) +
        " Reads stay open; use a separate MCP connection for anything else.",
    );
    this.name = "DeviceOutsideManagedSlotsError";
  }

  /** The wire evidence: the refused target and scope, never another slot's session. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      action: this.action,
      reason: this.reason,
      scopeKey: this.scopeKey,
      ...(this.target.deviceId === undefined ? {} : { deviceId: this.target.deviceId }),
      ...(this.target.sessionUuid === undefined ? {} : { sessionUuid: this.target.sessionUuid }),
      ...(this.target.deviceLabel === undefined ? {} : { deviceLabel: this.target.deviceLabel }),
      ...(this.target.platform === undefined ? {} : { platform: this.target.platform }),
      retryable: false,
    };
  }
}

function managedConnectionRefusalDetail(
  reason: ManagedConnectionRefusalReason,
  target: { deviceId?: string; sessionUuid?: string; deviceLabel?: string; platform?: string },
): string {
  switch (reason) {
    case "scope":
      return "A managed connection resets only its own slot scope, named by all three identity parts.";
    case "host":
      return "It changes state shared by every connection of this daemon.";
    case "device":
      return target.deviceId === undefined && target.platform !== undefined
        ? `None of its slot devices is an ${target.platform} device; name a device by deviceId to read one outside its slots.`
        : `Device '${target.deviceId}' is not one of its slot devices.`;
    case "session":
      return `Session ${target.sessionUuid} is not one of its slot sessions.`;
    case "tool":
      return (
        (target.deviceLabel === undefined
          ? ""
          : `Device label '${target.deviceLabel}' needs a device its slots do not provide. `) +
        "Slot devices are acquired, started, stopped and deleted only by managed slot " +
        "acquisition and release."
      );
  }
}
