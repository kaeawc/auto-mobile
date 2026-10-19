import type { ProvisionDeviceArgs } from "../features/deviceLifecycle/deviceLifecycleCore";

type ProvisionReadiness = ProvisionDeviceArgs["readiness"];

/** Service status reported for a device this request booted; none when nothing was booted. */
export function provisionedServiceStatus(
  booted: boolean,
  readiness: ProvisionReadiness,
): { installed: true; enabled: true; running: boolean; isCompatible: true } | undefined {
  if (!booted) {
    return undefined;
  }
  return {
    installed: true,
    enabled: true,
    running: readiness === "automation",
    isCompatible: true,
  };
}

export function provisionReadinessStatus(
  booted: boolean,
  readiness: ProvisionReadiness,
): "automation_ready" | "device_ready" | "not_requested" {
  if (!booted) {
    return "not_requested";
  }
  return readiness === "automation" ? "automation_ready" : "device_ready";
}

export function provisionLifecycleState(
  booted: boolean,
  createdByRequest: boolean,
): "ready" | "created" | "adopted" {
  if (booted) {
    return "ready";
  }
  return createdByRequest ? "created" : "adopted";
}
