import { ActionableError } from "./ActionableError";
import type { Platform } from "./Platform";

/** The slice of a managed-device registry entry the refusal reports. */
export interface DeviceAssignedToBindingEntry {
  platform: Platform;
  stableDeviceId: string;
  holder: "session_broker";
  scopeKey: string;
  bindingIndex: number | null;
}

/**
 * Typed refusal for a generic caller (no binding of its own) that tried to lend, adopt, start,
 * stop, delete or drive a device a binding holds (#11174, #11178). An idle assigned device is
 * not a free device, so this is not retryable: the device frees only when its scope is reset.
 */
export const DEVICE_ASSIGNED_TO_BINDING_CODE = "device_assigned_to_binding";

export class DeviceAssignedToBindingError extends ActionableError {
  readonly code = DEVICE_ASSIGNED_TO_BINDING_CODE;
  readonly retryable = false;
  readonly platform: Platform;
  readonly stableId: string;
  readonly scopeKey: string;
  /** The binding index holding the device, or null when it sits in the managed free pool. */
  readonly declaredBinding: number | null;

  constructor(
    action: string,
    readonly deviceId: string,
    entry: DeviceAssignedToBindingEntry,
  ) {
    super(
      `${action} refused: device '${deviceId}' (${entry.platform} ${entry.stableDeviceId}) is ` +
        (entry.holder === "session_broker"
          ? `assigned to binding ${entry.bindingIndex}`
          : "reserved for bindings") +
        ` (code ${DEVICE_ASSIGNED_TO_BINDING_CODE}). It stays reserved while idle; ` +
        "use another device, or reset the binding's scope to release it.",
    );
    this.name = "DeviceAssignedToBindingError";
    this.platform = entry.platform;
    this.stableId = entry.stableDeviceId;
    this.scopeKey = entry.scopeKey;
    this.declaredBinding = entry.bindingIndex;
  }

  /** The wire evidence: who holds the device, never a control credential. */
  toPayload(): Record<string, unknown> {
    return {
      code: this.code,
      deviceId: this.deviceId,
      platform: this.platform,
      stableId: this.stableId,
      scopeKey: this.scopeKey,
      declaredBinding: this.declaredBinding,
      retryable: false,
    };
  }
}
