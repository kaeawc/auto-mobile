import type { ConfigurableDeviceResource } from "./deviceResourceDescriptions";

/** `verified` means exercised on a device; `inferred` is a dependency-based expectation. */
export type ImpactConfidence = "verified" | "inferred";

export interface ImpactItem {
  description: string;
  confidence: ImpactConfidence;
  evidence?: string;
}

/** What disabling one iOS Simulator service group costs AutoMobile and apps. */
export interface IosDeviceResourceImpact {
  unsafeWith?: readonly {
    hazardId: string;
    appliesTo: readonly ("post_boot" | "preboot")[];
    withResources: readonly ConfigurableDeviceResource[];
    reason: string;
    evidence: string;
  }[];
  automobileImpact: readonly ImpactItem[];
  appImpact: readonly ImpactItem[];
}

/** One proven-disabled catalog group with its launchd labels and both impact lists. */
export interface DisabledIosDeviceResource extends IosDeviceResourceImpact {
  resource: ConfigurableDeviceResource;
  labels: string[];
}
