import type { ConfigurableDeviceResource } from "./deviceResourceDescriptions";

/** When a hazardous change is applied: to a running simulator, or before its first boot. */
export type IosDeviceResourceHazardPhase = "post_boot" | "preboot";

/** A resource combination that is measured to harm a simulator when changed in the listed phases. */
export interface IosDeviceResourceHazard {
  id: string;
  resources: readonly ConfigurableDeviceResource[];
  appliesTo: readonly IosDeviceResourceHazardPhase[];
  reason: string;
  evidence: string;
}
