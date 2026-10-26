import type { DeviceProfileSelector } from "../../models/ManufacturerProfileIds";

export type IosArchetype = "phone" | "tablet" | "duo";
export type AndroidArchetype = "phone" | "tablet";

export type IosModelType =
  | {
      family: "iphone";
      variant: "standard" | "pro" | "pro-max" | "air";
    }
  | {
      family: "ipad";
      variant: "standard" | "mini" | "air" | "pro";
      sizeInches?: string;
    }
  | {
      family: "duo";
      variant: "duo";
    };

export type IosExactModelReference =
  | {
      namespace: "product-model";
      value: string;
    }
  | {
      namespace: "simulator-device-type";
      value: string;
    }
  | {
      namespace: "alias";
      value: string;
    };

export type IosHardwareSelector =
  | { kind: "omitted" }
  | { kind: "exact-model"; model: IosExactModelReference }
  | { kind: "model-type"; modelType: IosModelType }
  | { kind: "archetype"; archetype: IosArchetype };

export type AndroidHardwareSelector =
  | { kind: "omitted" }
  | { kind: "archetype"; archetype: AndroidArchetype };

export type OsSelector =
  | { kind: "omitted" }
  | { kind: "exact"; version: string }
  | { kind: "major"; major: number }
  | { kind: "minimum"; version: string };

export type EffectiveOsSelector = Exclude<OsSelector, { kind: "omitted" }>;
export type EffectiveIosHardwareSelector = Exclude<IosHardwareSelector, { kind: "omitted" }>;
export type EffectiveAndroidHardwareSelector = Exclude<
  AndroidHardwareSelector,
  { kind: "omitted" }
>;

export interface IosSessionDeviceRequirement {
  schemaVersion: 1;
  platform: "ios";
  hardware: IosHardwareSelector;
  os: OsSelector;
}

export interface AndroidSessionDeviceRequirement {
  schemaVersion: 1;
  platform: "android";
  hardware: AndroidHardwareSelector;
  os: OsSelector;
  /**
   * An OEM manufacturer profile applied to the session's device after readiness (#14058). A
   * simulated effect, not a firmware guarantee: it never selects or matches pool hardware.
   */
  deviceProfile?: DeviceProfileSelector;
}

/**
 * Consumer-owned device intent. Allocation controls such as slots, lanes, and
 * capacity are deliberately absent.
 */
export type SessionDeviceRequirement =
  | IosSessionDeviceRequirement
  | AndroidSessionDeviceRequirement;

export interface CatalogProvenance {
  source: string;
  revision: string;
  state: "ready" | "unavailable";
  message?: string;
}

export type CatalogMetadataState = "current" | "stale";

export interface IosCatalogModel {
  simulatorDeviceTypeIdentifier: string;
  modelIdentifier?: string;
  name: string;
  productFamily: string;
  aliases?: readonly string[];
  archetype?: IosArchetype;
  modelType?: IosModelType;
  metadataState: CatalogMetadataState;
  /** Inclusive catalog compatibility bound. Omission means unknown. */
  minOsVersion?: string;
  /** Inclusive catalog compatibility bound. null means unbounded. */
  maxOsVersion?: string | null;
}

export type AndroidVersionPrecision = "major" | "minor" | "patch";

export interface IosCatalogRelease {
  runtimeId: string;
  osVersion?: string;
  installed: boolean;
  metadataState: CatalogMetadataState;
}

export interface AndroidCatalogRelease {
  systemImagePackage: string;
  osVersion?: string;
  /**
   * Finest Android release component supported by source metadata. API level
   * and package revision are not release-version precision.
   */
  versionPrecision: AndroidVersionPrecision;
  apiLevel: number;
  abi: string;
  flavor: string;
  installed: boolean;
  metadataState: CatalogMetadataState;
}

export interface AndroidCatalogProfile {
  profileId: string;
  archetype?: AndroidArchetype;
  metadataState: CatalogMetadataState;
}

export interface IosSessionDeviceCatalog {
  platform: "ios";
  provenance: CatalogProvenance;
  models: readonly IosCatalogModel[];
  releases: readonly IosCatalogRelease[];
}

export interface AndroidSessionDeviceCatalog {
  platform: "android";
  provenance: CatalogProvenance;
  profiles: readonly AndroidCatalogProfile[];
  releases: readonly AndroidCatalogRelease[];
  /** ABIs the host can run, best first; same-version ties rank these ahead of flavor. */
  hostAbis?: readonly string[];
}

export type SessionDeviceCatalog = IosSessionDeviceCatalog | AndroidSessionDeviceCatalog;

export interface OsDefaultPolicy {
  /** Predicate applied when the request omits OS intent. */
  selector: EffectiveOsSelector;
  /** Preferred installed release for major/minimum creation resolution. */
  preferredVersion: string;
}

export interface IosArchetypeDefault {
  archetype: IosArchetype;
  modelType: IosModelType;
}

export interface IosModelTypeDefault {
  modelType: IosModelType;
  model: IosExactModelReference;
}

export interface IosHardwareDefaults {
  omitted: IosArchetype;
  archetypes: readonly IosArchetypeDefault[];
  modelTypes: readonly IosModelTypeDefault[];
}

export interface AndroidProfileDefault {
  archetype: AndroidArchetype;
  profileId: string;
}

export interface AndroidHardwareDefaults {
  omitted: AndroidArchetype;
  profiles: readonly AndroidProfileDefault[];
}

export interface IosSessionRequirementDefaults {
  platform: "ios";
  policyVersion: string;
  hardware: IosHardwareDefaults;
  os: OsDefaultPolicy;
}

export interface AndroidSessionRequirementDefaults {
  platform: "android";
  policyVersion: string;
  hardware: AndroidHardwareDefaults;
  os: OsDefaultPolicy;
}

export type SessionRequirementDefaults =
  | IosSessionRequirementDefaults
  | AndroidSessionRequirementDefaults;

/**
 * Operator-enabled host capabilities for hardware that is recognized but not executable
 * everywhere. Every capability is off when omitted, so a recognized request is refused with
 * a non-retryable `capability_disabled` failure.
 */
export interface SessionRequirementCapabilities {
  /** iPhone Duo simulators (iOS 27.1+ runtimes). */
  iosDuo?: boolean;
}

export interface RequirementProvenance {
  policyVersion: string;
  catalogSource: string;
  catalogRevision: string;
  defaultsApplied: readonly ("hardware-archetype" | "os-predicate")[];
}

export interface NormalizedIosSessionDeviceRequirement {
  platform: "ios";
  original: IosSessionDeviceRequirement;
  effective: {
    hardware: EffectiveIosHardwareSelector;
    os: EffectiveOsSelector;
  };
  /** Canonical catalog identity for an explicit exact-model selector. */
  exactModel?: IosCatalogModel;
  provenance: RequirementProvenance;
}

export interface NormalizedAndroidSessionDeviceRequirement {
  platform: "android";
  original: AndroidSessionDeviceRequirement;
  effective: {
    hardware: EffectiveAndroidHardwareSelector;
    os: EffectiveOsSelector;
  };
  provenance: RequirementProvenance;
}

export type NormalizedSessionDeviceRequirement =
  | NormalizedIosSessionDeviceRequirement
  | NormalizedAndroidSessionDeviceRequirement;

export interface IosSessionDeviceProfile {
  platform: "ios";
  metadataState: CatalogMetadataState;
  simulatorDeviceTypeIdentifier?: string;
  modelIdentifier?: string;
  archetype?: IosArchetype;
  modelType?: IosModelType;
  runtimeId?: string;
  osVersion?: string;
}

export interface AndroidSessionDeviceProfile {
  platform: "android";
  metadataState: CatalogMetadataState;
  profileId?: string;
  archetype?: AndroidArchetype;
  systemImagePackage?: string;
  osVersion?: string;
  versionPrecision?: AndroidVersionPrecision;
  apiLevel?: number;
  abi?: string;
  flavor?: string;
}

export type SessionDeviceProfile = IosSessionDeviceProfile | AndroidSessionDeviceProfile;

export type DevicePredicateMismatchReason =
  | "platform"
  | "stale-metadata"
  | "unknown-hardware-metadata"
  | "unknown-os-metadata"
  | "hardware"
  | "os";

export type DevicePredicateMatch =
  | { kind: "match" }
  | { kind: "mismatch"; reason: DevicePredicateMismatchReason };

export interface ResolutionProvenance {
  original: SessionDeviceRequirement;
  effective: NormalizedSessionDeviceRequirement["effective"];
  resolvedHardwareBy: "explicit-model" | "model-type-default" | "archetype-default";
  resolvedOsBy: "exact" | "preferred-default" | "highest-satisfying";
  hardwareDefaultPath: readonly string[];
  policyVersion: string;
  catalogSource: string;
  catalogRevision: string;
}

export interface ResolvedIosSessionDeviceProfile {
  platform: "ios";
  metadataState: "current";
  simulatorDeviceTypeIdentifier: string;
  modelIdentifier?: string;
  archetype: IosArchetype;
  modelType: IosModelType;
  runtimeId: string;
  osVersion: string;
  compatibility: "supported" | "unknown";
}

export interface ResolvedAndroidSessionDeviceProfile {
  platform: "android";
  metadataState: "current";
  profileId: string;
  archetype: AndroidArchetype;
  systemImagePackage: string;
  osVersion: string;
  versionPrecision: AndroidVersionPrecision;
  apiLevel: number;
  abi: string;
  flavor: string;
}

export type ResolvedSessionDeviceProfile =
  | {
      platform: "ios";
      requirement: NormalizedIosSessionDeviceRequirement;
      profile: ResolvedIosSessionDeviceProfile;
      provenance: ResolutionProvenance;
    }
  | {
      platform: "android";
      requirement: NormalizedAndroidSessionDeviceRequirement;
      profile: ResolvedAndroidSessionDeviceProfile;
      provenance: ResolutionProvenance;
    };

export type SessionRequirementErrorCode =
  | "invalid_request"
  | "invalid_config"
  | "capability_disabled"
  | "unsupported_hardware"
  | "unsupported_version_precision"
  | "missing_installed_runtime"
  | "runtime_incompatible"
  | "catalog_unavailable"
  | "catalog_metadata_invalid"
  | "ambiguous_model_alias";

export interface SessionRequirementError {
  code: SessionRequirementErrorCode;
  message: string;
  transient: boolean;
  field?: string;
}

export type RequirementResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionRequirementError };
