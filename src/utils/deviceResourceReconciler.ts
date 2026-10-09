import type { BootedDevice } from "../models/DeviceInfo";
import type {
  DeviceResourceReconciliation,
  SimulatorResourceIdentity,
  SimulatorWorkloadProfile,
} from "../models/DeviceResourceReconciliation";

export interface DeviceResourceReconcileRequest {
  device: BootedDevice;
  profile: SimulatorWorkloadProfile;
  /** Apply the requested delta through the service-transition client. Default: report only. */
  repair?: boolean;
  /** With `repair`, also re-enable owned extra overrides not in this profile. */
  releaseOwnedExtras?: boolean;
  deadlineMs: number;
  signal?: AbortSignal;
}

/** Compares a requested workload profile with observed simulator state; repairs only on request. */
export interface DeviceResourceReconciler {
  reconcile(request: DeviceResourceReconcileRequest): Promise<DeviceResourceReconciliation>;
}

/** Resolves the booted simulator incarnation; null when the target is not a booted iOS Simulator. */
export interface SimulatorResourceIdentityReader {
  readIdentity(request: {
    device: BootedDevice;
    deadlineMs: number;
    signal?: AbortSignal;
  }): Promise<SimulatorResourceIdentity | null>;
}
