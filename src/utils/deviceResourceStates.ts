import type { DeviceResourceConfigurationResult } from "../models/DeviceResourceConfiguration";

/** Direct observations win; unreadable observations retain controller-proven states. */
export function mergeProvenResourceStates(
  controller: DeviceResourceConfigurationResult["resources"],
  observed: DeviceResourceConfigurationResult["resources"] | undefined,
): DeviceResourceConfigurationResult["resources"] {
  const merged = { ...controller };
  for (const [resource, status] of Object.entries(observed ?? {}) as [
    keyof typeof merged,
    NonNullable<(typeof merged)[keyof typeof merged]>,
  ][]) {
    const proven = merged[resource];
    const unreadable = status.state === "unknown" || status.state === "unsupported";
    if (!(unreadable && proven && proven.state !== "unknown" && proven.state !== "unsupported")) {
      merged[resource] = status;
    }
  }
  return merged;
}
