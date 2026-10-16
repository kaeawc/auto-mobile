import { failure, success } from "./result";
import type {
  AndroidHardwareSelector,
  AndroidSessionDeviceRequirement,
  IosExactModelReference,
  IosHardwareSelector,
  IosModelType,
  IosSessionDeviceRequirement,
  OsSelector,
  RequirementResult,
  SessionDeviceRequirement,
} from "./types";
import { normalizeOsSelector } from "./version";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): RequirementResult<true> {
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  return unexpected.length === 0
    ? success(true)
    : failure("invalid_request", `Unexpected field(s): ${unexpected.join(", ")}.`);
}

function nonEmptyString(value: unknown, field: string): RequirementResult<string> {
  return typeof value === "string" && value.length > 0
    ? success(value)
    : failure("invalid_request", `${field} must be a non-empty string.`, { field });
}

function parseExactModel(value: unknown): RequirementResult<IosExactModelReference> {
  if (!isRecord(value)) {
    return failure("invalid_request", "hardware.model must be an exact model reference.", {
      field: "hardware.model",
    });
  }
  const keys = hasOnlyKeys(value, ["namespace", "value"]);
  if (!keys.ok) {
    return keys;
  }
  if (
    value.namespace !== "product-model" &&
    value.namespace !== "simulator-device-type" &&
    value.namespace !== "alias"
  ) {
    return failure(
      "invalid_request",
      "hardware.model.namespace must be product-model, simulator-device-type, or alias.",
      { field: "hardware.model.namespace" },
    );
  }
  const parsedValue = nonEmptyString(value.value, "hardware.model.value");
  return parsedValue.ok
    ? success({ namespace: value.namespace, value: parsedValue.value })
    : parsedValue;
}

function parseIphoneModelType(value: Record<string, unknown>): RequirementResult<IosModelType> {
  const keys = hasOnlyKeys(value, ["family", "variant"]);
  if (!keys.ok) {
    return keys;
  }
  const variant = value.variant;
  if (variant === "standard" || variant === "pro" || variant === "pro-max" || variant === "air") {
    return success({ family: "iphone", variant });
  }
  return failure("invalid_request", "Unsupported iPhone model type.", {
    field: "hardware.modelType.variant",
  });
}

function parseDuoModelType(value: Record<string, unknown>): RequirementResult<IosModelType> {
  const keys = hasOnlyKeys(value, ["family", "variant"]);
  if (!keys.ok) {
    return keys;
  }
  return value.variant === "duo"
    ? success({ family: "duo", variant: "duo" })
    : failure("invalid_request", "Unsupported Duo model type.", {
        field: "hardware.modelType.variant",
      });
}

function parseIosModelType(value: unknown): RequirementResult<IosModelType> {
  if (!isRecord(value)) {
    return failure("invalid_request", "hardware.modelType must be an object.", {
      field: "hardware.modelType",
    });
  }
  if (value.family === "iphone") {
    return parseIphoneModelType(value);
  }
  if (value.family === "ipad") {
    return parseIpadModelType(value);
  }
  if (value.family === "duo") {
    return parseDuoModelType(value);
  }
  return failure("invalid_request", "Unsupported iOS model family.", {
    field: "hardware.modelType.family",
  });
}

function parseIpadModelType(value: Record<string, unknown>): RequirementResult<IosModelType> {
  const keys = hasOnlyKeys(value, ["family", "variant", "sizeInches"]);
  if (!keys.ok) {
    return keys;
  }
  const variant = value.variant;
  if (variant !== "standard" && variant !== "mini" && variant !== "air" && variant !== "pro") {
    return failure("invalid_request", "Unsupported iPad model type.", {
      field: "hardware.modelType.variant",
    });
  }
  if (value.sizeInches === undefined) {
    return success({ family: "ipad", variant });
  }
  if (typeof value.sizeInches !== "string" || !/^\d+(?:\.\d+)?$/.test(value.sizeInches)) {
    return failure("invalid_request", "hardware.modelType.sizeInches must be numeric.", {
      field: "hardware.modelType.sizeInches",
    });
  }
  return success({ family: "ipad", variant, sizeInches: value.sizeInches });
}

function parseIosArchetype(value: Record<string, unknown>): RequirementResult<IosHardwareSelector> {
  const keys = hasOnlyKeys(value, ["kind", "archetype"]);
  if (!keys.ok) {
    return keys;
  }
  if (value.archetype === "phone" || value.archetype === "tablet" || value.archetype === "duo") {
    return success({ kind: "archetype", archetype: value.archetype });
  }
  return failure("invalid_request", "Unsupported iOS hardware archetype.", {
    field: "hardware.archetype",
  });
}

function parseIosModelTypeSelector(
  value: Record<string, unknown>,
): RequirementResult<IosHardwareSelector> {
  const keys = hasOnlyKeys(value, ["kind", "modelType"]);
  if (!keys.ok) {
    return keys;
  }
  const modelType = parseIosModelType(value.modelType);
  return modelType.ok ? success({ kind: "model-type", modelType: modelType.value }) : modelType;
}

function parseIosExactModelSelector(
  value: Record<string, unknown>,
): RequirementResult<IosHardwareSelector> {
  const keys = hasOnlyKeys(value, ["kind", "model"]);
  if (!keys.ok) {
    return keys;
  }
  const model = parseExactModel(value.model);
  return model.ok ? success({ kind: "exact-model", model: model.value }) : model;
}

function parseIosHardware(value: unknown): RequirementResult<IosHardwareSelector> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return failure("invalid_request", "hardware must have an explicit selector kind.", {
      field: "hardware",
    });
  }
  if (value.kind === "omitted") {
    const keys = hasOnlyKeys(value, ["kind"]);
    return keys.ok ? success({ kind: "omitted" }) : keys;
  }
  if (value.kind === "archetype") {
    return parseIosArchetype(value);
  }
  if (value.kind === "model-type") {
    return parseIosModelTypeSelector(value);
  }
  if (value.kind === "exact-model") {
    return parseIosExactModelSelector(value);
  }
  return failure("invalid_request", `Unsupported iOS hardware selector '${value.kind}'.`, {
    field: "hardware.kind",
  });
}

function parseAndroidHardware(value: unknown): RequirementResult<AndroidHardwareSelector> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return failure("invalid_request", "hardware must have an explicit selector kind.", {
      field: "hardware",
    });
  }
  if (value.kind === "omitted") {
    const keys = hasOnlyKeys(value, ["kind"]);
    return keys.ok ? success({ kind: "omitted" }) : keys;
  }
  if (value.kind === "archetype") {
    const keys = hasOnlyKeys(value, ["kind", "archetype"]);
    if (!keys.ok) {
      return keys;
    }
    return value.archetype === "phone" || value.archetype === "tablet"
      ? success({ kind: "archetype", archetype: value.archetype })
      : failure("invalid_request", "Android hardware supports only phone or tablet.", {
          field: "hardware.archetype",
        });
  }
  return failure("invalid_request", `Unsupported Android hardware selector '${value.kind}'.`, {
    field: "hardware.kind",
  });
}

function parseMajorOs(value: Record<string, unknown>): RequirementResult<OsSelector> {
  const keys = hasOnlyKeys(value, ["kind", "major"]);
  if (!keys.ok) {
    return keys;
  }
  if (typeof value.major !== "number") {
    return failure("invalid_request", "os.major must be a number.", { field: "os.major" });
  }
  const selector = { kind: "major" as const, major: value.major };
  const validated = normalizeOsSelector(selector);
  return validated.ok ? success(selector) : validated;
}

function parseVersionOs(
  value: Record<string, unknown>,
  kind: "exact" | "minimum",
): RequirementResult<OsSelector> {
  const keys = hasOnlyKeys(value, ["kind", "version"]);
  if (!keys.ok) {
    return keys;
  }
  if (typeof value.version !== "string") {
    return failure("invalid_request", "os.version must be a string.", { field: "os.version" });
  }
  const selector = { kind, version: value.version };
  const validated = normalizeOsSelector(selector);
  return validated.ok ? success(selector) : validated;
}

function parseOs(value: unknown): RequirementResult<OsSelector> {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return failure("invalid_request", "os must have an explicit selector kind.", { field: "os" });
  }
  if (value.kind === "omitted") {
    const keys = hasOnlyKeys(value, ["kind"]);
    return keys.ok ? success({ kind: "omitted" }) : keys;
  }
  if (value.kind === "major") {
    return parseMajorOs(value);
  }
  if (value.kind === "exact" || value.kind === "minimum") {
    return parseVersionOs(value, value.kind);
  }
  return failure("invalid_request", `Unsupported OS selector '${value.kind}'.`, {
    field: "os.kind",
  });
}

function parseIosRequest(
  value: Record<string, unknown>,
): RequirementResult<IosSessionDeviceRequirement> {
  const hardware = parseIosHardware(value.hardware);
  if (!hardware.ok) {
    return hardware;
  }
  const os = parseOs(value.os);
  return os.ok
    ? success({ schemaVersion: 1, platform: "ios", hardware: hardware.value, os: os.value })
    : os;
}

function parseAndroidRequest(
  value: Record<string, unknown>,
): RequirementResult<AndroidSessionDeviceRequirement> {
  const hardware = parseAndroidHardware(value.hardware);
  if (!hardware.ok) {
    return hardware;
  }
  const os = parseOs(value.os);
  return os.ok
    ? success({ schemaVersion: 1, platform: "android", hardware: hardware.value, os: os.value })
    : os;
}

export function parseSessionDeviceRequirement(
  value: unknown,
): RequirementResult<SessionDeviceRequirement> {
  if (!isRecord(value)) {
    return failure("invalid_request", "Session device requirement must be an object.");
  }
  const keys = hasOnlyKeys(value, ["schemaVersion", "platform", "hardware", "os"]);
  if (!keys.ok) {
    return keys;
  }
  if (value.schemaVersion !== 1) {
    return failure("invalid_request", "schemaVersion must be 1.", { field: "schemaVersion" });
  }
  if (value.platform === "ios") {
    return parseIosRequest(value);
  }
  if (value.platform === "android") {
    return parseAndroidRequest(value);
  }
  return failure("invalid_request", "platform must be ios or android.", { field: "platform" });
}
