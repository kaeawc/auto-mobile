import type { AppleDeviceResource } from "./AppleDeviceResource";
import type { DeviceResourceStatus } from "./DeviceResource";
import type {
  ConfigurableDeviceResource,
  DeviceResourceConfiguration,
  DeviceResourceConfigurationResult,
  RequestedDeviceResourceState,
} from "./DeviceResourceConfiguration";

/**
 * Identity of one iOS Simulator incarnation for resource metadata. A UDID alone is
 * never sufficient: a runtime replacement or device-type change on the same UDID is
 * a different incarnation, so its recorded overrides are not reused.
 */
export interface SimulatorResourceIdentity {
  platform: "ios";
  udid: string;
  runtimeId: string;
  deviceTypeId: string;
}

/**
 * A workload profile is only the requested resource map. It has no name or catalog
 * entry; its identity is the content fingerprint of the map.
 */
export interface SimulatorWorkloadProfile {
  resources: DeviceResourceConfiguration;
}

/**
 * Minimal AutoMobile-owned metadata: the service overrides AutoMobile applied to
 * this incarnation and last verified (or could not disprove). Never an ownership
 * claim over the simulator itself.
 */
export interface DeviceResourceApplicationRecord {
  identity: SimulatorResourceIdentity;
  /** Overrides AutoMobile applied; only `disabled` entries are retained. */
  resources: DeviceResourceConfiguration;
  /** Fingerprint of the most recently requested workload profile. */
  profileFingerprint: string;
  updatedAtMs: number;
}

/**
 * - missingRequested: a requested state is explicitly contradicted.
 * - ownedExtra: an override AutoMobile applied earlier, not in this profile, still in effect.
 * - unsupported: this runtime cannot provide or control the requested resource.
 * - commandFailure: native evidence could not be read or was mixed; never a guessed state.
 */
export type DeviceResourceDriftKind =
  | "missingRequested"
  | "ownedExtra"
  | "unsupported"
  | "commandFailure";

export interface DeviceResourceDrift {
  resource: ConfigurableDeviceResource;
  kind: DeviceResourceDriftKind;
  /** The profile's state, or the recorded owned override for `ownedExtra`. */
  expected: RequestedDeviceResourceState;
  observed: DeviceResourceStatus;
}

export interface DeviceResourceReconciliation {
  /** True only when every requested resource is observed in its requested state after the run. */
  success: boolean;
  identity: SimulatorResourceIdentity;
  requested: DeviceResourceConfiguration;
  profileFingerprint: string;
  /** Drift found before any repair. */
  drift: DeviceResourceDrift[];
  /** Drift still present after the run; equals `drift` for a report-only run. */
  remainingDrift: DeviceResourceDrift[];
  /** Delta passed to the service-transition client; absent when nothing was applied. */
  applied?: DeviceResourceConfigurationResult;
  /** Final independent observation. */
  observed: AppleDeviceResource;
  verification: "current_boot";
}
