import { createHash } from "node:crypto";
import { stableStringify } from "../../utils/stableStringify";

/** Version of the pure profile-resolution contract. */
export const IOS_SIMULATOR_WORKLOAD_PROFILE_SCHEMA_VERSION = 1 as const;

/** A named AutoMobile policy for background iOS Simulator work. */
export type IosSimulatorWorkloadProfileId = "automation";

/** A caller-visible capability that a workload can require from the simulator. */
export type IosSimulatorWorkloadCapabilityId =
  | "push-notifications"
  | "storekit"
  | "universal-links"
  | "photos-library"
  | "contacts"
  | "calendar"
  | "share-sheet";

/**
 * An AutoMobile-owned service-control identifier. These are intentionally
 * logical identifiers: platform command labels remain in the platform adapter.
 */
export type IosSimulatorManagedServiceId =
  | "background-analytics"
  | "background-search"
  | "cloud-sync"
  | "device-connectivity"
  | "intelligence-services"
  | "personal-information-sync"
  | "photo-analysis"
  | "store-services"
  | "web-association"
  | "widget-updates";

export interface IosSimulatorWorkloadProfileRequest {
  profileId: IosSimulatorWorkloadProfileId;
  requiredCapabilities?: readonly IosSimulatorWorkloadCapabilityId[];
  retainedServices?: readonly IosSimulatorManagedServiceId[];
}

export interface ResolvedIosSimulatorWorkloadProfile {
  schemaVersion: typeof IOS_SIMULATOR_WORKLOAD_PROFILE_SCHEMA_VERSION;
  profileId: IosSimulatorWorkloadProfileId;
  requiredCapabilities: IosSimulatorWorkloadCapabilityId[];
  retainedServices: IosSimulatorManagedServiceId[];
  suspendedServices: IosSimulatorManagedServiceId[];
  /** Stable identity for persistence and comparison; never an ownership key. */
  identity: string;
}

interface IosSimulatorWorkloadProfileDefinition {
  suspendedServices: readonly IosSimulatorManagedServiceId[];
}

const WORKLOAD_PROFILES: Readonly<
  Record<IosSimulatorWorkloadProfileId, IosSimulatorWorkloadProfileDefinition>
> = {
  automation: {
    suspendedServices: [
      "background-analytics",
      "background-search",
      "cloud-sync",
      "device-connectivity",
      "intelligence-services",
      "personal-information-sync",
      "photo-analysis",
      "store-services",
      "web-association",
      "widget-updates",
    ],
  },
};

const CAPABILITY_SERVICES: Readonly<
  Record<IosSimulatorWorkloadCapabilityId, readonly IosSimulatorManagedServiceId[]>
> = {
  "push-notifications": ["store-services"],
  storekit: ["store-services"],
  "universal-links": ["web-association"],
  "photos-library": ["photo-analysis"],
  contacts: ["personal-information-sync"],
  calendar: ["personal-information-sync"],
  "share-sheet": ["device-connectivity"],
};

const KNOWN_SERVICES = new Set<IosSimulatorManagedServiceId>(
  WORKLOAD_PROFILES.automation.suspendedServices,
);

function sortedUnique<T extends string>(values: readonly T[] | undefined): T[] {
  return [...new Set(values ?? [])].sort();
}

function assertKnownProfile(profileId: string): asserts profileId is IosSimulatorWorkloadProfileId {
  if (!(profileId in WORKLOAD_PROFILES)) {
    throw new Error(`Unknown iOS Simulator workload profile ${JSON.stringify(profileId)}.`);
  }
}

function assertKnownCapabilities(
  capabilities: readonly string[],
): asserts capabilities is readonly IosSimulatorWorkloadCapabilityId[] {
  for (const capability of capabilities) {
    if (!(capability in CAPABILITY_SERVICES)) {
      throw new Error(`Unknown iOS Simulator workload capability ${JSON.stringify(capability)}.`);
    }
  }
}

function assertKnownServices(
  services: readonly string[],
): asserts services is readonly IosSimulatorManagedServiceId[] {
  for (const service of services) {
    if (!KNOWN_SERVICES.has(service as IosSimulatorManagedServiceId)) {
      throw new Error(`Unknown iOS Simulator managed service ${JSON.stringify(service)}.`);
    }
  }
}

function profileIdentity(value: Omit<ResolvedIosSimulatorWorkloadProfile, "identity">): string {
  const digest = createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
  return `ios-simulator-workload-v${IOS_SIMULATOR_WORKLOAD_PROFILE_SCHEMA_VERSION}-${digest}`;
}

/**
 * Resolves a workload request to the exact logical services that can be
 * suspended. This function is pure and intentionally performs no device I/O.
 */
export function resolveIosSimulatorWorkloadProfile(
  request: IosSimulatorWorkloadProfileRequest,
): ResolvedIosSimulatorWorkloadProfile {
  assertKnownProfile(request.profileId);
  const requiredCapabilities = sortedUnique(request.requiredCapabilities);
  const explicitRetainedServices = sortedUnique(request.retainedServices);
  assertKnownCapabilities(requiredCapabilities);
  assertKnownServices(explicitRetainedServices);

  const retained = new Set<IosSimulatorManagedServiceId>(explicitRetainedServices);
  for (const capability of requiredCapabilities) {
    for (const service of CAPABILITY_SERVICES[capability]) {
      retained.add(service);
    }
  }
  const retainedServices = [...retained].sort();
  const suspendedServices = WORKLOAD_PROFILES[request.profileId].suspendedServices.filter(
    (service) => !retained.has(service),
  );
  const resolved = {
    schemaVersion: IOS_SIMULATOR_WORKLOAD_PROFILE_SCHEMA_VERSION,
    profileId: request.profileId,
    requiredCapabilities,
    retainedServices,
    suspendedServices,
  };
  return { ...resolved, identity: profileIdentity(resolved) };
}
