import type {
  CatalogMetadataState,
  IosArchetype,
  IosCatalogModel,
  IosCatalogRelease,
  IosModelType,
  IosSessionDeviceCatalog,
} from "../sessionRequirements";
import { parseNumericVersion } from "../sessionRequirements";
import { errorMessage } from "../../utils/describeUnknownError";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  deviceTypeRuntimeBounds,
  hasRuntimeRangeMetadata,
} from "../../utils/ios-cmdline-tools/runtimeCompatibility";
import { logger as defaultLogger } from "../../utils/logger";
import { nativeCatalogRevision } from "./revision";

const IOS_CATALOG_SOURCE = "simctl-installed-catalog";

/**
 * Versioned classification policy over exact CoreSimulator fields. Product
 * family establishes the archetype. Anchored display-name grammars establish
 * model type and iPad size; unknown names retain an unknown model type.
 */
export const IOS_CATALOG_CLASSIFICATION_VERSION = "simctl-fields-v1";

export interface IosNativeRuntime extends Omit<AppleDeviceRuntime, "isAvailable"> {
  isAvailable?: boolean;
  platform?: string;
}

export interface IosNativeCatalogReader {
  getDeviceTypesChecked(signal?: AbortSignal): Promise<AppleDeviceType[]>;
  getRuntimesChecked(timeoutMs?: number, signal?: AbortSignal): Promise<IosNativeRuntime[]>;
}

/** Exact-ID escape hatch for metadata that the bounded field grammar cannot classify. */
export interface IosCatalogClassification {
  simulatorDeviceTypeIdentifier: string;
  modelType: IosModelType;
  aliases?: readonly string[];
}

export interface IosCatalogAdapterOptions {
  classifications?: readonly IosCatalogClassification[];
  metadataState?: CatalogMetadataState;
}

export interface IosCatalogReadOptions extends IosCatalogAdapterOptions {
  signal?: AbortSignal;
  logger?: Pick<typeof defaultLogger, "warn">;
}

interface IosClassification {
  archetype?: IosArchetype;
  modelType?: IosModelType;
  aliases?: readonly string[];
  conflict: boolean;
}

function modelTypeArchetype(modelType: IosModelType): IosArchetype {
  if (modelType.family === "duo") {
    return "duo";
  }
  return modelType.family === "ipad" ? "tablet" : "phone";
}

function normalizedSize(size: string | undefined): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  const [whole, fraction] = size.split(".");
  const normalizedFraction = fraction?.replace(/0+$/, "");
  return normalizedFraction ? `${Number(whole)}.${normalizedFraction}` : String(Number(whole));
}

function mergeModelType(
  native: IosModelType | undefined,
  configured: IosModelType,
): { modelType: IosModelType; conflict: boolean } {
  if (native === undefined) {
    return { modelType: configured, conflict: false };
  }
  if (native.family !== configured.family || native.variant !== configured.variant) {
    return { modelType: native, conflict: true };
  }
  if (native.family !== "ipad" || configured.family !== "ipad") {
    return { modelType: native, conflict: false };
  }
  const nativeSize = normalizedSize(native.sizeInches);
  const configuredSize = normalizedSize(configured.sizeInches);
  if (nativeSize !== undefined && configuredSize !== undefined && nativeSize !== configuredSize) {
    return { modelType: native, conflict: true };
  }
  return {
    modelType: nativeSize === undefined ? configured : native,
    conflict: false,
  };
}

function classifyIphoneName(name: string): IosModelType | undefined {
  if (/^iPhone (?:\d+ )?Pro Max$/.test(name)) {
    return { family: "iphone", variant: "pro-max" };
  }
  if (/^iPhone (?:\d+ )?Pro$/.test(name)) {
    return { family: "iphone", variant: "pro" };
  }
  if (/^iPhone (?:\d+ )?Air$/.test(name)) {
    return { family: "iphone", variant: "air" };
  }
  const standard =
    /^iPhone (?:\d+(?:s|c)?(?: Plus| mini|e)?|SE \(\d+(?:st|nd|rd|th) generation\)|X|Xʀ|XR|Xs|XS|Xs Max|XS Max)$/;
  return standard.test(name) ? { family: "iphone", variant: "standard" } : undefined;
}

function ipadSize(name: string): string | undefined {
  return /(?:^|[\s(])(\d+(?:\.\d+)?)-inch(?:[\s)]|$)/.exec(name)?.[1];
}

function classifyIpadName(name: string): IosModelType | undefined {
  const sizeInches = ipadSize(name);
  const withSize = <T extends IosModelType>(modelType: T): T =>
    sizeInches === undefined ? modelType : ({ ...modelType, sizeInches } as T);

  if (/^iPad Pro(?:\s|\()/.test(name)) {
    return withSize({ family: "ipad", variant: "pro" });
  }
  if (/^iPad Air(?:\s|\()/.test(name)) {
    return withSize({ family: "ipad", variant: "air" });
  }
  if (/^iPad mini(?:\s|\()/.test(name)) {
    return withSize({ family: "ipad", variant: "mini" });
  }
  if (/^iPad(?:\s+\(|\s+\d|$)/.test(name)) {
    return withSize({ family: "ipad", variant: "standard" });
  }
  return undefined;
}

function builtInClassification(deviceType: AppleDeviceType): IosClassification {
  if (deviceType.productFamily === "Duo" || deviceType.name === "iPhone Duo") {
    return {
      archetype: "duo",
      modelType: { family: "duo", variant: "duo" },
      conflict: false,
    };
  }
  if (deviceType.productFamily === "iPhone") {
    const modelType = classifyIphoneName(deviceType.name);
    return {
      archetype: "phone",
      ...(modelType === undefined ? {} : { modelType }),
      conflict: false,
    };
  }
  if (deviceType.productFamily === "iPad") {
    const modelType = classifyIpadName(deviceType.name);
    return {
      archetype: "tablet",
      ...(modelType === undefined ? {} : { modelType }),
      conflict: false,
    };
  }
  return { conflict: false };
}

function classifyDeviceType(
  deviceType: AppleDeviceType,
  classifications: readonly IosCatalogClassification[],
): IosClassification {
  const native = builtInClassification(deviceType);
  const configured = classifications.filter(
    (entry) => entry.simulatorDeviceTypeIdentifier === deviceType.identifier,
  );
  if (configured.length > 1) {
    return { ...native, conflict: true };
  }
  const exact = configured[0];
  if (!exact) {
    return native;
  }
  const configuredArchetype = modelTypeArchetype(exact.modelType);
  if (native.archetype !== undefined && native.archetype !== configuredArchetype) {
    return { ...native, conflict: true };
  }
  const merged = mergeModelType(native.modelType, exact.modelType);
  return {
    archetype: native.archetype ?? configuredArchetype,
    modelType: merged.modelType,
    ...(merged.conflict || exact.aliases === undefined ? {} : { aliases: exact.aliases }),
    conflict: merged.conflict,
  };
}

function cleanAliases(aliases: readonly string[] | undefined): readonly string[] | undefined {
  if (aliases === undefined) {
    return undefined;
  }
  const cleaned = [...new Set(aliases.filter((alias) => alias.length > 0))].sort();
  return cleaned.length === 0 ? undefined : cleaned;
}

function iosModelMetadataState(
  deviceType: AppleDeviceType,
  snapshotState: CatalogMetadataState,
  duplicate: boolean,
  classificationConflict: boolean,
  malformedBounds: boolean,
): CatalogMetadataState {
  const requiredFieldsPresent =
    deviceType.identifier.length > 0 &&
    deviceType.name.length > 0 &&
    deviceType.productFamily.length > 0;
  return snapshotState === "stale" ||
    duplicate ||
    classificationConflict ||
    malformedBounds ||
    !requiredFieldsPresent
    ? "stale"
    : "current";
}

function iosModel(
  deviceType: AppleDeviceType,
  classifications: readonly IosCatalogClassification[],
  snapshotState: CatalogMetadataState,
  duplicate: boolean,
): IosCatalogModel {
  const classification = classifyDeviceType(deviceType, classifications);
  const bounds = deviceTypeRuntimeBounds(deviceType);
  const malformedBounds = hasRuntimeRangeMetadata(deviceType) && bounds === undefined;
  const metadataState = iosModelMetadataState(
    deviceType,
    snapshotState,
    duplicate,
    classification.conflict,
    malformedBounds,
  );
  const aliases = cleanAliases(classification.aliases);

  return {
    simulatorDeviceTypeIdentifier: deviceType.identifier,
    ...(deviceType.modelIdentifier ? { modelIdentifier: deviceType.modelIdentifier } : {}),
    name: deviceType.name,
    productFamily: deviceType.productFamily,
    ...(aliases === undefined ? {} : { aliases }),
    ...(classification.archetype === undefined ? {} : { archetype: classification.archetype }),
    ...(classification.modelType === undefined ? {} : { modelType: classification.modelType }),
    metadataState,
    ...(bounds === undefined
      ? {}
      : { minOsVersion: bounds.minVersion, maxOsVersion: bounds.maxVersion }),
  };
}

function isIosRuntime(runtime: IosNativeRuntime): boolean {
  return (
    runtime.platform === "iOS" ||
    runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") ||
    runtime.name.startsWith("iOS ")
  );
}

function iosRelease(
  runtime: IosNativeRuntime,
  snapshotState: CatalogMetadataState,
  duplicate: boolean,
): IosCatalogRelease {
  const version = parseNumericVersion(runtime.version);
  return {
    runtimeId: runtime.identifier,
    ...(version.ok ? { osVersion: version.value.value } : {}),
    installed: runtime.isAvailable === true,
    metadataState:
      snapshotState === "stale" ||
      duplicate ||
      !runtime.identifier ||
      !version.ok ||
      runtime.isAvailable === undefined
        ? "stale"
        : "current",
  };
}

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

export function adaptIosSessionDeviceCatalog(
  deviceTypes: readonly AppleDeviceType[],
  runtimes: readonly IosNativeRuntime[],
  options: IosCatalogAdapterOptions = {},
): IosSessionDeviceCatalog {
  const snapshotState = options.metadataState ?? "current";
  const classifications = options.classifications ?? [];
  const duplicateModels = duplicateValues(deviceTypes.map((entry) => entry.identifier));
  const iosRuntimes = runtimes.filter(isIosRuntime);
  const duplicateRuntimes = duplicateValues(iosRuntimes.map((entry) => entry.identifier));
  const models = deviceTypes
    .map((entry) =>
      iosModel(entry, classifications, snapshotState, duplicateModels.has(entry.identifier)),
    )
    .sort((a, b) => a.simulatorDeviceTypeIdentifier.localeCompare(b.simulatorDeviceTypeIdentifier));
  const releases = iosRuntimes
    .map((entry) => iosRelease(entry, snapshotState, duplicateRuntimes.has(entry.identifier)))
    .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  const revision = nativeCatalogRevision(IOS_CATALOG_SOURCE, {
    classificationVersion: IOS_CATALOG_CLASSIFICATION_VERSION,
    classifications: [...classifications].sort((a, b) =>
      a.simulatorDeviceTypeIdentifier.localeCompare(b.simulatorDeviceTypeIdentifier),
    ),
    models,
    releases,
  });

  return {
    platform: "ios",
    provenance: { source: IOS_CATALOG_SOURCE, revision, state: "ready" },
    models,
    releases,
  };
}

async function readIosNativeCatalog(
  reader: IosNativeCatalogReader,
  signal: AbortSignal | undefined,
): Promise<readonly [AppleDeviceType[], IosNativeRuntime[]]> {
  const [deviceTypes, runtimes] = await Promise.allSettled([
    reader.getDeviceTypesChecked(signal),
    reader.getRuntimesChecked(undefined, signal),
  ]);
  if (deviceTypes.status === "rejected") {
    throw deviceTypes.reason;
  }
  if (runtimes.status === "rejected") {
    throw runtimes.reason;
  }
  return [deviceTypes.value, runtimes.value];
}

export async function readIosSessionDeviceCatalog(
  reader: IosNativeCatalogReader,
  options: IosCatalogReadOptions = {},
): Promise<IosSessionDeviceCatalog> {
  try {
    const [deviceTypes, runtimes] = await readIosNativeCatalog(reader, options.signal);
    return adaptIosSessionDeviceCatalog(deviceTypes, runtimes, options);
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const message = `Unable to read the installed iOS simulator catalog: ${errorMessage(error)}`;
    (options.logger ?? defaultLogger).warn(message, error);
    return {
      platform: "ios",
      provenance: {
        source: IOS_CATALOG_SOURCE,
        revision: "unavailable",
        state: "unavailable",
        message,
      },
      models: [],
      releases: [],
    };
  }
}
