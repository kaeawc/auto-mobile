import {
  describeIosModelType,
  iosModelTypeArchetype,
  iosModelTypesEqual,
  resolveIosModelReference,
} from "./catalog";
import { failure, success } from "./result";
import type {
  AndroidCatalogProfile,
  AndroidCatalogRelease,
  AndroidSessionRequirementDefaults,
  EffectiveOsSelector,
  IosCatalogModel,
  IosCatalogRelease,
  IosModelType,
  IosSessionRequirementDefaults,
  NormalizedAndroidSessionDeviceRequirement,
  NormalizedIosSessionDeviceRequirement,
  NormalizedSessionDeviceRequirement,
  RequirementResult,
  ResolvedAndroidSessionDeviceProfile,
  ResolvedIosSessionDeviceProfile,
  ResolvedSessionDeviceProfile,
  ResolutionProvenance,
  SessionDeviceCatalog,
  SessionRequirementDefaults,
} from "./types";
import {
  androidOsEvidenceMatches,
  androidPrecisionRank,
  compareNumericVersions,
  osSelectorMatchesVersion,
  parseNumericVersion,
} from "./version";

interface ResolvedIosHardware {
  model: IosCatalogModel;
  by: ResolutionProvenance["resolvedHardwareBy"];
  path: readonly string[];
}

interface ResolvedAndroidHardware {
  profile: AndroidCatalogProfile;
  path: readonly string[];
}

interface ResolvedIosOs {
  release: IosCatalogRelease & { osVersion: string };
  by: ResolutionProvenance["resolvedOsBy"];
}

interface ResolvedAndroidOs {
  release: AndroidCatalogRelease & { osVersion: string };
  by: ResolutionProvenance["resolvedOsBy"];
}

function invalidConfig(message: string, field?: string): RequirementResult<never> {
  return failure("invalid_config", message, field === undefined ? {} : { field });
}

function findUnique<T>(
  values: readonly T[],
  matches: (value: T) => boolean,
  description: string,
): RequirementResult<T> {
  const found = values.filter(matches);
  if (found.length === 0) {
    return invalidConfig(`Missing ${description}.`);
  }
  if (found.length > 1) {
    return invalidConfig(`Conflicting ${description} entries.`);
  }
  return success(found[0]);
}

function modelFromDefault(
  modelType: IosModelType,
  defaults: IosSessionRequirementDefaults,
  catalog: Extract<SessionDeviceCatalog, { platform: "ios" }>,
): RequirementResult<IosCatalogModel> {
  const configured = findUnique(
    defaults.hardware.modelTypes,
    (entry) => iosModelTypesEqual(entry.modelType, modelType),
    `exact-model default for ${describeIosModelType(modelType)}`,
  );
  if (!configured.ok) {
    return configured;
  }
  const resolved = resolveIosModelReference(
    configured.value.model,
    catalog,
    "defaults.hardware.modelTypes.model",
  );
  if (!resolved.ok) {
    return invalidConfig(resolved.error.message, resolved.error.field);
  }
  if (!resolved.value.modelType || !iosModelTypesEqual(resolved.value.modelType, modelType)) {
    return invalidConfig(
      `Configured model '${resolved.value.name}' does not belong to ${describeIosModelType(modelType)}.`,
      "defaults.hardware.modelTypes",
    );
  }
  return success(resolved.value);
}

function resolveIosHardware(
  requirement: NormalizedIosSessionDeviceRequirement,
  defaults: IosSessionRequirementDefaults,
  catalog: Extract<SessionDeviceCatalog, { platform: "ios" }>,
): RequirementResult<ResolvedIosHardware> {
  const selector = requirement.effective.hardware;
  if (selector.kind === "exact-model") {
    return requirement.exactModel
      ? success({ model: requirement.exactModel, by: "explicit-model", path: [] })
      : failure("catalog_metadata_invalid", "Normalized exact iOS model is missing.");
  }
  if (selector.kind === "model-type") {
    const model = modelFromDefault(selector.modelType, defaults, catalog);
    return model.ok
      ? success({
          model: model.value,
          by: "model-type-default",
          path: [
            describeIosModelType(selector.modelType),
            model.value.simulatorDeviceTypeIdentifier,
          ],
        })
      : model;
  }
  const typeDefault = findUnique(
    defaults.hardware.archetypes,
    (entry) => entry.archetype === selector.archetype,
    `model-type default for iOS ${selector.archetype}`,
  );
  if (!typeDefault.ok) {
    return typeDefault;
  }
  if (iosModelTypeArchetype(typeDefault.value.modelType) !== selector.archetype) {
    return invalidConfig(
      `The ${selector.archetype} default points to ${describeIosModelType(typeDefault.value.modelType)}.`,
      "defaults.hardware.archetypes",
    );
  }
  const model = modelFromDefault(typeDefault.value.modelType, defaults, catalog);
  return model.ok
    ? success({
        model: model.value,
        by: "archetype-default",
        path: [
          selector.archetype,
          describeIosModelType(typeDefault.value.modelType),
          model.value.simulatorDeviceTypeIdentifier,
        ],
      })
    : model;
}

function resolveAndroidHardware(
  requirement: NormalizedAndroidSessionDeviceRequirement,
  defaults: AndroidSessionRequirementDefaults,
  catalog: Extract<SessionDeviceCatalog, { platform: "android" }>,
): RequirementResult<ResolvedAndroidHardware> {
  const archetype = requirement.effective.hardware.archetype;
  const configured = findUnique(
    defaults.hardware.profiles,
    (entry) => entry.archetype === archetype,
    `Android ${archetype} profile default`,
  );
  if (!configured.ok) {
    return configured;
  }
  const profiles = catalog.profiles.filter(
    (profile) => profile.profileId === configured.value.profileId,
  );
  if (profiles.length === 0) {
    return failure(
      "unsupported_hardware",
      `Configured Android profile '${configured.value.profileId}' is not installed.`,
      { field: "defaults.hardware.profiles" },
    );
  }
  if (profiles.length > 1) {
    return failure(
      "catalog_metadata_invalid",
      `Android profile '${configured.value.profileId}' is duplicated in the catalog.`,
    );
  }
  const profile = profiles[0];
  if (profile.metadataState !== "current" || !profile.archetype) {
    return failure(
      "catalog_metadata_invalid",
      `Android profile '${profile.profileId}' lacks current archetype metadata.`,
    );
  }
  if (profile.archetype !== archetype) {
    return invalidConfig(
      `Configured Android profile '${profile.profileId}' is ${profile.archetype}, not ${archetype}.`,
      "defaults.hardware.profiles",
    );
  }
  return success({ profile, path: [archetype, profile.profileId] });
}

function validIosReleases(
  releases: readonly IosCatalogRelease[],
): Array<IosCatalogRelease & { osVersion: string }> {
  return releases.filter(
    (release): release is IosCatalogRelease & { osVersion: string } =>
      release.installed &&
      release.metadataState === "current" &&
      release.osVersion !== undefined &&
      parseNumericVersion(release.osVersion).ok,
  );
}

function validAndroidReleases(
  releases: readonly AndroidCatalogRelease[],
): Array<AndroidCatalogRelease & { osVersion: string }> {
  return releases.filter(
    (release): release is AndroidCatalogRelease & { osVersion: string } =>
      release.installed &&
      release.metadataState === "current" &&
      release.osVersion !== undefined &&
      release.apiLevel > 0 &&
      release.abi.length > 0 &&
      release.flavor.length > 0 &&
      parseNumericVersion(release.osVersion).ok,
  );
}

function stableReleaseSort<T>(
  releases: T[],
  version: (release: T) => string,
  identity: (release: T) => string,
): T[] {
  return releases.sort(
    (a, b) =>
      compareNumericVersions(version(b), version(a)) || identity(a).localeCompare(identity(b)),
  );
}

function chooseIosRelease(
  selector: EffectiveOsSelector,
  preferredVersion: string,
  releases: readonly IosCatalogRelease[],
): RequirementResult<ResolvedIosOs> {
  const valid = validIosReleases(releases);
  const satisfying = valid.filter((release) =>
    osSelectorMatchesVersion(selector, release.osVersion),
  );
  if (satisfying.length === 0) {
    return noRuntimeResult(selector, releases);
  }
  const ordered = stableReleaseSort(
    satisfying,
    (release) => release.osVersion,
    (release) => release.runtimeId,
  );
  if (selector.kind === "exact") {
    return success({ release: ordered[0], by: "exact" });
  }
  const preferred = ordered.find(
    (release) => compareNumericVersions(release.osVersion, preferredVersion) === 0,
  );
  return success(
    preferred
      ? { release: preferred, by: "preferred-default" }
      : { release: ordered[0], by: "highest-satisfying" },
  );
}

function insufficientAndroidExactPrecision(
  requestedVersion: string,
  releases: Array<AndroidCatalogRelease & { osVersion: string }>,
): boolean {
  const requested = parseNumericVersion(requestedVersion);
  if (!requested.ok) {
    return false;
  }
  return releases.some((release) => {
    const available = parseNumericVersion(release.osVersion);
    if (
      !available.ok ||
      androidPrecisionRank(release.versionPrecision) >= requested.value.precision
    ) {
      return false;
    }
    const known = androidPrecisionRank(release.versionPrecision);
    return requested.value.components
      .slice(0, known)
      .every((component, index) => component === (available.value.components[index] ?? "0"));
  });
}

function chooseAndroidRelease(
  selector: EffectiveOsSelector,
  preferredVersion: string,
  releases: readonly AndroidCatalogRelease[],
): RequirementResult<ResolvedAndroidOs> {
  const valid = validAndroidReleases(releases);
  const satisfying = valid.filter((release) =>
    androidOsEvidenceMatches(selector, release.osVersion, release.versionPrecision),
  );
  if (satisfying.length === 0) {
    if (selector.kind === "exact" && insufficientAndroidExactPrecision(selector.version, valid)) {
      return failure(
        "unsupported_version_precision",
        `Installed Android metadata cannot prove exact release '${selector.version}'.`,
        { field: "os.version" },
      );
    }
    return noRuntimeResult(selector, releases);
  }
  const ordered = stableReleaseSort(
    satisfying,
    (release) => release.osVersion,
    (release) => release.systemImagePackage,
  );
  if (selector.kind === "exact") {
    return success({ release: ordered[0], by: "exact" });
  }
  const preferred = ordered.find(
    (release) => compareNumericVersions(release.osVersion, preferredVersion) === 0,
  );
  return success(
    preferred
      ? { release: preferred, by: "preferred-default" }
      : { release: ordered[0], by: "highest-satisfying" },
  );
}

function describeOsSelector(selector: EffectiveOsSelector): string {
  return selector.kind === "major"
    ? `major ${selector.major}`
    : `${selector.kind} ${selector.version}`;
}

function noRuntimeResult(
  selector: EffectiveOsSelector,
  releases: readonly {
    installed: boolean;
    metadataState: "current" | "stale";
    osVersion?: string;
  }[],
): RequirementResult<never> {
  const unusable = releases.some(
    (release) =>
      release.installed &&
      (release.osVersion === undefined ||
        !parseNumericVersion(release.osVersion).ok ||
        (release.metadataState !== "current" &&
          osSelectorMatchesVersion(selector, release.osVersion))),
  );
  return unusable
    ? failure(
        "catalog_metadata_invalid",
        `Installed release metadata is stale or incomplete for ${describeOsSelector(selector)}.`,
      )
    : failure(
        "missing_installed_runtime",
        `No installed runtime satisfies ${describeOsSelector(selector)}.`,
      );
}

function compatibilityBound(
  value: string | null | undefined,
  model: IosCatalogModel,
  label: "minimum" | "maximum",
): RequirementResult<string | undefined> {
  if (value === undefined || value === null) {
    return success(undefined);
  }
  const parsed = parseNumericVersion(value);
  if (!parsed.ok) {
    return failure(
      "catalog_metadata_invalid",
      `Model '${model.name}' has a malformed ${label} runtime version.`,
    );
  }
  return success(parsed.value.value);
}

function outsideIosCompatibilityBounds(
  osVersion: string,
  minimum: string | undefined,
  maximum: string | undefined,
): boolean {
  if (minimum !== undefined && compareNumericVersions(osVersion, minimum) < 0) {
    return true;
  }
  return maximum !== undefined && compareNumericVersions(osVersion, maximum) > 0;
}

function evaluateIosCompatibility(
  model: IosCatalogModel,
  osVersion: string,
): RequirementResult<"supported" | "unknown"> {
  const minimum = compatibilityBound(model.minOsVersion, model, "minimum");
  if (!minimum.ok) {
    return minimum;
  }
  const maximum = compatibilityBound(model.maxOsVersion, model, "maximum");
  if (!maximum.ok) {
    return maximum;
  }
  if (outsideIosCompatibilityBounds(osVersion, minimum.value, maximum.value)) {
    return failure(
      "runtime_incompatible",
      `Model '${model.name}' is incompatible with iOS ${osVersion}; the exact pair was preserved.`,
    );
  }
  return success(
    minimum.value !== undefined || maximum.value !== undefined ? "supported" : "unknown",
  );
}

function resolutionProvenance(
  requirement: NormalizedSessionDeviceRequirement,
  hardwareBy: ResolutionProvenance["resolvedHardwareBy"],
  hardwarePath: readonly string[],
  osBy: ResolutionProvenance["resolvedOsBy"],
): ResolutionProvenance {
  return {
    original: requirement.original,
    effective: requirement.effective,
    resolvedHardwareBy: hardwareBy,
    resolvedOsBy: osBy,
    hardwareDefaultPath: hardwarePath,
    policyVersion: requirement.provenance.policyVersion,
    catalogSource: requirement.provenance.catalogSource,
    catalogRevision: requirement.provenance.catalogRevision,
  };
}

function resolveIos(
  requirement: NormalizedIosSessionDeviceRequirement,
  defaults: IosSessionRequirementDefaults,
  catalog: Extract<SessionDeviceCatalog, { platform: "ios" }>,
): RequirementResult<ResolvedSessionDeviceProfile> {
  const hardware = resolveIosHardware(requirement, defaults, catalog);
  if (!hardware.ok) {
    return hardware;
  }
  if (hardware.value.model.archetype === "duo") {
    return failure(
      "capability_disabled",
      `Model '${hardware.value.model.name}' resolves to Duo, which is disabled by provider policy.`,
    );
  }
  const os = chooseIosRelease(
    requirement.effective.os,
    defaults.os.preferredVersion,
    catalog.releases,
  );
  if (!os.ok) {
    return os;
  }
  const compatibility = evaluateIosCompatibility(hardware.value.model, os.value.release.osVersion);
  if (!compatibility.ok) {
    return compatibility;
  }
  const model = hardware.value.model;
  if (!model.archetype || !model.modelType) {
    return failure("catalog_metadata_invalid", `Model '${model.name}' lost classification.`);
  }
  const profile: ResolvedIosSessionDeviceProfile = {
    platform: "ios",
    metadataState: "current",
    simulatorDeviceTypeIdentifier: model.simulatorDeviceTypeIdentifier,
    ...(model.modelIdentifier === undefined ? {} : { modelIdentifier: model.modelIdentifier }),
    archetype: model.archetype,
    modelType: model.modelType,
    runtimeId: os.value.release.runtimeId,
    osVersion: os.value.release.osVersion,
    compatibility: compatibility.value,
  };
  return success({
    platform: "ios",
    requirement,
    profile,
    provenance: resolutionProvenance(
      requirement,
      hardware.value.by,
      hardware.value.path,
      os.value.by,
    ),
  });
}

function resolveAndroid(
  requirement: NormalizedAndroidSessionDeviceRequirement,
  defaults: AndroidSessionRequirementDefaults,
  catalog: Extract<SessionDeviceCatalog, { platform: "android" }>,
): RequirementResult<ResolvedSessionDeviceProfile> {
  const hardware = resolveAndroidHardware(requirement, defaults, catalog);
  if (!hardware.ok) {
    return hardware;
  }
  const os = chooseAndroidRelease(
    requirement.effective.os,
    defaults.os.preferredVersion,
    catalog.releases,
  );
  if (!os.ok) {
    return os;
  }
  const release = os.value.release;
  const profile: ResolvedAndroidSessionDeviceProfile = {
    platform: "android",
    metadataState: "current",
    profileId: hardware.value.profile.profileId,
    archetype: hardware.value.profile.archetype ?? requirement.effective.hardware.archetype,
    systemImagePackage: release.systemImagePackage,
    osVersion: release.osVersion,
    versionPrecision: release.versionPrecision,
    apiLevel: release.apiLevel,
    abi: release.abi,
    flavor: release.flavor,
  };
  return success({
    platform: "android",
    requirement,
    profile,
    provenance: resolutionProvenance(
      requirement,
      "archetype-default",
      hardware.value.path,
      os.value.by,
    ),
  });
}

export function resolveSessionDeviceProfile(
  requirement: NormalizedSessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
): RequirementResult<ResolvedSessionDeviceProfile> {
  if (requirement.platform === "ios" && defaults.platform === "ios" && catalog.platform === "ios") {
    return resolveIos(requirement, defaults, catalog);
  }
  if (
    requirement.platform === "android" &&
    defaults.platform === "android" &&
    catalog.platform === "android"
  ) {
    return resolveAndroid(requirement, defaults, catalog);
  }
  return invalidConfig("Normalized requirement, defaults, and catalog platforms differ.");
}
