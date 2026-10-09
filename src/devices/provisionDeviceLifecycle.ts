import type { IosRuntimeIncompatibility } from "./exactDeviceProvisioning";
import type { DeviceResourceDrift } from "../models/DeviceResourceReconciliation";

export type ProvisionDeviceLifecycleState =
  | "provisioning"
  | "created_not_ready"
  | "cleanup_in_progress"
  | "removed"
  | "retained"
  | "no_device_created";

/**
 * The last lifecycle a running provisionDevice request observed. Held in memory
 * for the request only; it feeds the recovery evidence of its error response.
 */
export interface ProvisionDeviceLifecycleOutcome {
  state: ProvisionDeviceLifecycleState;
  phase: string;
  device?: {
    platform: "android" | "ios";
    stableId: string;
    name: string;
    runtimeDeviceId?: string;
  };
  reason?: {
    code: string;
    message: string;
    retryable?: boolean;
    providerCode?: string;
    readinessPhase?: string;
    attempt?: number;
    incidentId?: string;
    deviceId?: string;
    resourceDrift?: DeviceResourceDrift[];
    runtimeCompatibility?: IosRuntimeIncompatibility;
    daemonBuild?: string;
  };
  cleanup?: {
    status: "in_progress" | "succeeded" | "failed";
    reason?: string;
  };
}
