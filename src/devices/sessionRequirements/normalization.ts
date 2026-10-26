import {
  iosModelTypeArchetype,
  iosModelTypesEqual,
  resolveIosModelReference,
  validateContext,
} from "./catalog";
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
  SessionDeviceCatalog,
  SessionDeviceRequirement,
  SessionRequirementCapabilities,
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

function capabilityDisabled(subject: string): RequirementResult<never> {
  return failure(
    "capability_disabled",
    `${subject} is recognized, but Duo execution is disabled by the current provider policy.`,
    { field: "hardware" },
  );
}

function validateIosCapability(
  request: IosSessionDeviceRequirement,
  exactModel: IosCatalogModel | undefined,
): RequirementResult<true> {
  if (request.hardware.kind === "archetype" && request.hardware.archetype === "duo") {
    return capabilityDisabled("The Duo archetype");
  }
  if (
    request.hardware.kind === "model-type" &&
    iosModelTypeArchetype(request.hardware.modelType) === "duo"
  ) {
    return capabilityDisabled("The Duo model type");
  }
  if (exactModel?.archetype === "duo") {
    return capabilityDisabled(`Model '${exactModel.name}'`);
  }
  return success(true);
}

/**
 * A coarse pool predicate stays coarse, but a known Duo farther down its
 * configured creation path must still be refused before pool checkout.
 */
function validateIosDefaultCapability(
  request: IosSessionDeviceRequirement,
  defaults: Extract<SessionRequirementDefaults, { platform: "ios" }>,
  catalog: IosSessionDeviceCatalog,
): RequirementResult<true> {
  if (request.hardware.kind === "exact-model") {
    return success(true);
  }
  const hardware = request.hardware;
  const archetype = hardware.kind === "archetype" ? hardware.archetype : undefined;
  const modelType =
    hardware.kind === "model-type"
      ? hardware.modelType
      : defaults.hardware.archetypes.find((entry) => entry.archetype === archetype)?.modelType;
  if (!modelType) {
    return success(true);
  }
  if (iosModelTypeArchetype(modelType) === "duo") {
    return capabilityDisabled("The configured hardware default");
  }
  const modelDefaults = defaults.hardware.modelTypes.filter((entry) =>
    iosModelTypesEqual(entry.modelType, modelType),
  );
  if (modelDefaults.length !== 1) {
    return success(true);
  }
  const model = resolveIosModelReference(
    modelDefaults[0].model,
    catalog,
    "defaults.hardware.modelTypes.model",
  );
  return model.ok && model.value.archetype === "duo"
    ? capabilityDisabled(`Configured model '${model.value.name}'`)
    : success(true);
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
  request: SessionDeviceRequirement,
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
  capabilities: SessionRequirementCapabilities,
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
  const effectiveRequest: IosSessionDeviceRequirement = {
    ...original,
    hardware: hardware.value,
    os: normalizedOs.value,
  };
  const exactModel = optionalExactModel(hardware.value, catalog);
  if (!exactModel.ok) {
    return exactModel;
  }
  if (capabilities.iosDuo !== true) {
    const capability = validateIosCapability(effectiveRequest, exactModel.value);
    if (!capability.ok) {
      return capability;
    }
    const defaultCapability = validateIosDefaultCapability(effectiveRequest, defaults, catalog);
    if (!defaultCapability.ok) {
      return defaultCapability;
    }
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
  return success({
    platform: "android",
    original,
    effective: { hardware: effectiveHardware, os: normalizedOs.value },
    provenance: provenance(defaults, catalog, appliedDefaults(original)),
  });
}

/**
 * Duo selectors stay refused with `capability_disabled` unless `capabilities.iosDuo` is set.
 * Enabling it never widens other selectors: resolution still requires a configured default
 * to belong to the requested model type, so a phone or tablet request cannot reach a Duo.
 */
export function normalizeSessionDeviceRequirement(
  request: SessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
  catalog: SessionDeviceCatalog,
  capabilities: SessionRequirementCapabilities = {},
): RequirementResult<NormalizedSessionDeviceRequirement> {
  const parsed = parseSessionDeviceRequirement(request);
  if (!parsed.ok) {
    return parsed;
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
    return normalizeIos(parsed.value, defaults, catalog, capabilities);
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
