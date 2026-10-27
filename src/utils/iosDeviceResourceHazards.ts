import type {
  ConfigurableDeviceResource,
  DeviceResourceConfiguration,
} from "../models/DeviceResourceConfiguration";
import { UnsafeDeviceResourceCombinationError } from "../models/UnsafeDeviceResourceCombinationError";
import type {
  IosDeviceResourceHazard,
  IosDeviceResourceHazardPhase,
} from "../models/IosDeviceResourceHazard";

export type { IosDeviceResourceHazard, IosDeviceResourceHazardPhase };

/** A hazard fires when all of its resources are requested disabled in the same call (live state of other resources is not consulted). */
export const iosDeviceResourceHazards: readonly IosDeviceResourceHazard[] = [
  {
    id: "calaccessd-bootout-spin",
    resources: ["calendarServices"],
    appliesTo: ["post_boot"],
    reason:
      "Booting out com.apple.calaccessd on a running simulator makes Calendar (MobileCal) retry its invalidated EventKit connection in a tight loop (100-130% of a core), with diagnosticd logging it (20-50%) for the rest of the boot. It is safe to disable only before the simulator's first boot (a newly created simulator via provisionDevice resources); otherwise leave it enabled.",
    evidence:
      "#15218: iOS 27.0 iPhone 18 Pro; disabling calaccessd 90 s after boot produced about 110 invalidation errors per 20 s; disabling at 1 s or before first boot did not, including a later Calendar launch.",
  },
];

export function findUnsafeResourceCombinations(
  disabled: Iterable<ConfigurableDeviceResource>,
  hazards: readonly IosDeviceResourceHazard[],
  phase: IosDeviceResourceHazardPhase,
): IosDeviceResourceHazard[] {
  const resources = new Set(disabled);
  return hazards.filter(
    (hazard) =>
      hazard.appliesTo.includes(phase) &&
      hazard.resources.every((resource) => resources.has(resource)),
  );
}

export function disabledResourcesOf(
  config: DeviceResourceConfiguration,
): ConfigurableDeviceResource[] {
  return (Object.keys(config) as ConfigurableDeviceResource[]).filter(
    (resource) => config[resource] === "disabled",
  );
}

/**
 * Checks the requested map for hazards in this phase; controller callers also check live state.
 */
export function assertSafeResourceCombination(
  config: DeviceResourceConfiguration,
  phase: IosDeviceResourceHazardPhase,
  hazards: readonly IosDeviceResourceHazard[] = iosDeviceResourceHazards,
): void {
  const unsafe = findUnsafeResourceCombinations(disabledResourcesOf(config), hazards, phase);
  if (unsafe.length) {
    throw new UnsafeDeviceResourceCombinationError(unsafe);
  }
}
