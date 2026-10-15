import { ActionableError } from "../../models/ActionableError";

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
