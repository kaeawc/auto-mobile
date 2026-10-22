import type { ProvisionDeviceLifecycleOutcome } from "./provisionDeviceLifecycle";
import type { DeviceResourceDrift } from "../models/DeviceResourceReconciliation";
import { ActionableError } from "../models";
import type { ProvisionDeviceRecoveryEvidence } from "./provisionDeviceRecoveryEvidenceTypes";
import type { DeviceTypeRuntimeBounds } from "../utils/ios-cmdline-tools/runtimeCompatibility";

export type ProvisionDeviceFailureCode =
  | "cleanup_failed"
  | "creation_not_allowed"
  | "device_lost"
  | "device_owned_by_other_session"
  | "device_owned_by_other_daemon"
  | "device_cleanup_in_progress"
  | "session_creation_timeout"
  | "device_shutting_down"
  | "device_assigned_to_binding"
  | "device_offline"
  | "discovery_incomplete"
  | "capacity_exhausted"
  | "identity_conflict"
  | "timeout"
  | "unsupported"
  | "platform_command_failed"
  | "resource_profile_unproven"
  | "runtime_incompatible"
  | "requires_real_device";

export const DEFAULT_PROVISION_DEVICE_RETRYABILITY: Readonly<
  Record<ProvisionDeviceFailureCode, boolean>
> = {
  cleanup_failed: false,
  creation_not_allowed: false,
  device_lost: true,
  // Transient: the holder can release the device, after which the same operation can succeed.
  device_owned_by_other_session: true,
  // Transient: the other daemon's claim lapses once its session ends.
  device_owned_by_other_daemon: true,
  // Transient: the previous session's release cleanup finishes by itself.
  device_cleanup_in_progress: true,
  // The bind was rolled back; retrying is safe.
  session_creation_timeout: true,
  // Transient: the kill reservation clears once the shutdown finishes.
  device_shutting_down: true,
  // An idle assigned device stays assigned; only a scope reset frees it (#11174).
  device_assigned_to_binding: false,
  device_offline: true,
  discovery_incomplete: true,
  // Transient: capacity frees when another device shuts down (#11236).
  capacity_exhausted: true,
  identity_conflict: false,
  timeout: true,
  unsupported: false,
  platform_command_failed: false,
  resource_profile_unproven: false,
  // A proven model/runtime mismatch is a property of the request; only a different pair can succeed.
  runtime_incompatible: false,
  // The request needs an OEM capability no emulator provides; only real hardware can serve it.
  requires_real_device: false,
};

export interface ProvisionDeviceErrorDiagnostics {
  /** Internal bridge of provisionDevice lifecycle evidence to the binding creation journal. */
  retainedDevice?: NonNullable<ProvisionDeviceLifecycleOutcome["device"]>;
  providerCode?: string;
  readinessPhase?: string;
  attempt?: number;
  incidentId?: string;
  deviceId?: string;
  /** PID of the other daemon holding the device (`device_owned_by_other_daemon`). */
  ownerPid?: number;
  /** Wait hint carried by a typed retryable acquisition refusal. */
  retryAfterMs?: number;
  /** Requested resources that could not be proven applied (iOS Simulator profiles). */
  resourceDrift?: DeviceResourceDrift[];
  /** Proven iOS model/runtime mismatch: requested pair, known bounds, installed alternatives. */
  runtimeCompatibility?: IosRuntimeIncompatibility;
  /** Structured recovery evidence delivered with the error (a snapshot, not live state). */
  recovery?: ProvisionDeviceRecoveryEvidence;
  /** The broker binding holding the device (`device_assigned_to_binding`); no credentials. */
  binding?: { scopeKey: string; declaredBinding: number | null; stableId: string };
  /** OEM capabilities a manufacturer profile cannot emulate (`requires_real_device`, #14058). */
  capabilities?: Array<{ id: string; note: string }>;
  /** Boot-capacity refusal details (`capacity_exhausted`, #11236). */
  capacity?: ProvisionDeviceCapacityDetails;
}

/** The booted-device limit a `capacity_exhausted` refusal hit (#11236). */
export interface ProvisionDeviceCapacityDetails {
  limit: number;
  booted: number;
  /** Counted devices AutoMobile did not start; present only when there are any. */
  externalDevices?: string[];
  heldDevices?: string[];
}

export interface IosRuntimeIncompatibility {
  requestedRuntime: string;
  requestedDeviceType: string;
  /** Normalized inclusive bounds of the model; `maxVersion: null` is unbounded. */
  bounds?: DeviceTypeRuntimeBounds;
  /** Installed, available runtimes that do support the requested model. */
  compatibleRuntimes: Array<{ id: string; version: string }>;
}

export class ProvisionDeviceError extends ActionableError {
  constructor(
    public readonly code: ProvisionDeviceFailureCode,
    message: string,
    public readonly retryable = DEFAULT_PROVISION_DEVICE_RETRYABILITY[code],
    public readonly diagnostics: ProvisionDeviceErrorDiagnostics = {},
  ) {
    super(message);
    this.name = "ProvisionDeviceError";
  }
}
