import { resolveAndroidExactProfile, resolveIosModelReference, validateContext } from "./catalog";
import { parseSessionDeviceRequirement } from "./parsing";
import { failure, success } from "./result";
import type {
  EffectiveOsSelector,
  EffectiveIosHardwareSelector,
  IosCatalogModel,
  IosSessionDeviceCatalog,
  IosSessionDeviceRequirement,
  NormalizedAndroidSessionDeviceRequirement,
  NormalizedIosSessionDeviceRequirement,
  NormalizedSessionDeviceRequirement,
  OsDefaultPolicy,
  RequirementProvenance,
  RequirementResult,
  DefaultedSessionDeviceRequirement,
  SessionDeviceCatalog,
  SessionDeviceRequirement,
  SessionRequirementDefaults,
} from "./types";
import { normalizeOsSelector, osSelectorMatchesVersion, parseNumericVersion } from "./version";

function invalidConfig(message: string, field?: string): RequirementResult<never> {
  return failure("invalid_config", message, field === undefined ? {} : { field });
}

function normalizeDefaultOs(policy: OsDefaultPolicy): RequirementResult<EffectiveOsSelector> {
  const selector = normalizeOsSelector(policy.selector, "defaults.os.selector");
  if (!selector.ok) {
    return invalidConfig(selector.error.message, selector.error.field);
  }
  const preferred = parseNumericVersion(policy.preferredVersion, "defaults.os.preferredVersion");
  if (!preferred.ok) {
    return invalidConfig(preferred.error.message, preferred.error.field);
  }
  if (!osSelectorMatchesVersion(selector.value, preferred.value.value)) {
    return invalidConfig(
      `Preferred OS release '${policy.preferredVersion}' does not satisfy the configured default predicate.`,
      "defaults.os.preferredVersion",
    );
  }
  return success(selector.value);
}

function effectiveOs(
  requested: IosSessionDeviceRequirement["os"],
  configured: EffectiveOsSelector,
): RequirementResult<EffectiveOsSelector> {
  return requested.kind === "omitted" ? success(configured) : normalizeOsSelector(requested);
}

function provenance(
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
  defaultsApplied: RequirementProvenance["defaultsApplied"],
): RequirementProvenance {
  return {
    policyVersion: defaults.policyVersion,
    catalogSource: catalog.provenance.source,
    catalogRevision: catalog.provenance.revision,
    defaultsApplied,
  };
}

function effectiveIosHardware(
  request: IosSessionDeviceRequirement,
  defaults: Extract<SessionRequirementDefaults, { platform: "ios" }>,
): RequirementResult<EffectiveIosHardwareSelector> {
  if (
    defaults.hardware.omitted !== "phone" &&
    defaults.hardware.omitted !== "tablet" &&
    defaults.hardware.omitted !== "duo"
  ) {
    return invalidConfig(
      "The omitted iOS hardware default is invalid.",
      "defaults.hardware.omitted",
    );
  }
  return success(
    request.hardware.kind === "omitted"
      ? { kind: "archetype", archetype: defaults.hardware.omitted }
      : request.hardware,
  );
}

function optionalExactModel(
  hardware: EffectiveIosHardwareSelector,
  catalog: IosSessionDeviceCatalog,
): RequirementResult<IosCatalogModel | undefined> {
  return hardware.kind === "exact-model"
    ? resolveIosModelReference(hardware.model, catalog)
    : success(undefined);
}

function appliedDefaults(
  request: DefaultedSessionDeviceRequirement,
): RequirementProvenance["defaultsApplied"] {
  const applied: Array<"hardware-archetype" | "os-predicate"> = [];
  if (request.hardware.kind === "omitted") {
    applied.push("hardware-archetype");
  }
  if (request.os.kind === "omitted") {
    applied.push("os-predicate");
  }
  return applied;
}

function normalizeIos(
  original: IosSessionDeviceRequirement,
  defaults: Extract<SessionRequirementDefaults, { platform: "ios" }>,
  catalog: IosSessionDeviceCatalog,
): RequirementResult<NormalizedIosSessionDeviceRequirement> {
  const hardware = effectiveIosHardware(original, defaults);
  if (!hardware.ok) {
    return hardware;
  }
  const defaultOs = normalizeDefaultOs(defaults.os);
  if (!defaultOs.ok) {
    return defaultOs;
  }
  const normalizedOs = effectiveOs(original.os, defaultOs.value);
  if (!normalizedOs.ok) {
    return normalizedOs;
  }
  const exactModel = optionalExactModel(hardware.value, catalog);
  if (!exactModel.ok) {
    return exactModel;
  }
  return success({
    platform: "ios",
    original,
    effective: { hardware: hardware.value, os: normalizedOs.value },
    ...(exactModel.value === undefined ? {} : { exactModel: exactModel.value }),
    provenance: provenance(defaults, catalog, appliedDefaults(original)),
  });
}

function normalizeAndroid(
  original: Extract<SessionDeviceRequirement, { platform: "android" }>,
  defaults: Extract<SessionRequirementDefaults, { platform: "android" }>,
  catalog: Extract<SessionDeviceCatalog, { platform: "android" }>,
): RequirementResult<NormalizedAndroidSessionDeviceRequirement> {
  if (
    defaults.hardware.omitted !== "phone" &&
    defaults.hardware.omitted !== "tablet" &&
    defaults.hardware.omitted !== "foldable"
  ) {
    return invalidConfig(
      "The omitted Android hardware default must be phone, tablet or foldable.",
      "defaults.hardware.omitted",
    );
  }
  const defaultOs = normalizeDefaultOs(defaults.os);
  if (!defaultOs.ok) {
    return defaultOs;
  }
  const effectiveHardware =
    original.hardware.kind === "omitted"
      ? { kind: "archetype" as const, archetype: defaults.hardware.omitted }
      : original.hardware;
  const normalizedOs = effectiveOs(original.os, defaultOs.value);
  if (!normalizedOs.ok) {
    return normalizedOs;
  }
  const exactProfile =
    effectiveHardware.kind === "exact-profile"
      ? resolveAndroidExactProfile(effectiveHardware.profileId, catalog)
      : success(undefined);
  if (!exactProfile.ok) {
    return exactProfile;
  }
  return success({
    platform: "android",
    original,
    effective: { hardware: effectiveHardware, os: normalizedOs.value },
    ...(exactProfile.value === undefined ? {} : { exactProfile: exactProfile.value }),
    provenance: provenance(defaults, catalog, appliedDefaults(original)),
  });
}

export function normalizeSessionDeviceRequirement(
  request: SessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
): RequirementResult<NormalizedSessionDeviceRequirement> {
  const parsed = parseSessionDeviceRequirement(request);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.platform === "watchos") {
    // A watch request has no defaults to apply; it is validated by
    // normalizeWatchSessionDeviceRequirement against the watch catalog instead.
    return invalidConfig("A watchOS requirement is not resolved through host defaults.");
  }
  const context = validateContext(parsed.value.platform, defaults, catalog);
  if (!context.ok) {
    return context;
  }
  if (
    parsed.value.platform === "ios" &&
    defaults.platform === "ios" &&
    catalog.platform === "ios"
  ) {
    return normalizeIos(parsed.value, defaults, catalog);
  }
  if (
    parsed.value.platform === "android" &&
    defaults.platform === "android" &&
    catalog.platform === "android"
  ) {
    return normalizeAndroid(parsed.value, defaults, catalog);
  }
  return invalidConfig("Requirement context could not be narrowed to one platform.");
}
