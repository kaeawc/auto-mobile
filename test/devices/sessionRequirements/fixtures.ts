import type {
  AndroidSessionDeviceCatalog,
  AndroidSessionRequirementDefaults,
  IosCatalogModel,
  IosSessionDeviceCatalog,
  IosSessionRequirementDefaults,
  RequirementResult,
  SessionRequirementError,
} from "../../../src/devices/sessionRequirements";

export const IOS_PRO: IosCatalogModel = {
  simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
  modelIdentifier: "iPhone18,1",
  name: "iPhone 17 Pro",
  productFamily: "iPhone",
  aliases: ["current-pro"],
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro" },
  metadataState: "current",
  minOsVersion: "26",
  maxOsVersion: null,
};

export const IOS_PRO_MAX: IosCatalogModel = {
  simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
  modelIdentifier: "iPhone18,2",
  name: "iPhone 17 Pro Max",
  productFamily: "iPhone",
  aliases: ["current-pro-max"],
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro-max" },
  metadataState: "current",
  minOsVersion: "26",
  maxOsVersion: null,
};

export const IOS_IPAD_AIR_11: IosCatalogModel = {
  simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-M4",
  modelIdentifier: "iPad16,1",
  name: "iPad Air 11-inch (M4)",
  productFamily: "iPad",
  aliases: ["current-ipad-air-11"],
  archetype: "tablet",
  modelType: { family: "ipad", variant: "air", sizeInches: "11" },
  metadataState: "current",
  minOsVersion: "26",
  maxOsVersion: null,
};

export const IOS_IPAD_AIR_13: IosCatalogModel = {
  simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-13-M4",
  modelIdentifier: "iPad16,2",
  name: "iPad Air 13-inch (M4)",
  productFamily: "iPad",
  aliases: ["current-ipad-air-13"],
  archetype: "tablet",
  modelType: { family: "ipad", variant: "air", sizeInches: "13" },
  metadataState: "current",
  minOsVersion: "26",
  maxOsVersion: null,
};

export const IOS_DUO: IosCatalogModel = {
  simulatorDeviceTypeIdentifier: "com.example.CoreSimulator.SimDeviceType.iPhone-Duo",
  modelIdentifier: "iPhoneDuo1,1",
  name: "iPhone Duo",
  productFamily: "Duo",
  aliases: ["duo-preview"],
  archetype: "duo",
  modelType: { family: "duo", variant: "duo" },
  metadataState: "current",
  minOsVersion: "27",
  maxOsVersion: null,
};

export function iosCatalog(
  overrides: Partial<IosSessionDeviceCatalog> = {},
): IosSessionDeviceCatalog {
  return {
    platform: "ios",
    provenance: { source: "fake-simctl", revision: "catalog-ios-1", state: "ready" },
    models: [IOS_PRO, IOS_PRO_MAX, IOS_IPAD_AIR_11, IOS_IPAD_AIR_13, IOS_DUO],
    releases: [
      {
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
        osVersion: "27.0",
        installed: true,
        metadataState: "current",
      },
      {
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0-1",
        osVersion: "27.0.1",
        installed: true,
        metadataState: "current",
      },
      {
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-28-0",
        osVersion: "28",
        installed: true,
        metadataState: "current",
      },
    ],
    ...overrides,
  };
}

export function iosDefaults(
  overrides: Partial<IosSessionRequirementDefaults> = {},
): IosSessionRequirementDefaults {
  return {
    platform: "ios",
    policyVersion: "defaults-ios-1",
    hardware: {
      omitted: "phone",
      archetypes: [
        {
          archetype: "phone",
          modelType: { family: "iphone", variant: "pro-max" },
        },
        {
          archetype: "tablet",
          modelType: { family: "ipad", variant: "air", sizeInches: "11" },
        },
      ],
      modelTypes: [
        {
          modelType: { family: "iphone", variant: "pro" },
          model: { namespace: "product-model", value: "iPhone18,1" },
        },
        {
          modelType: { family: "iphone", variant: "pro-max" },
          model: { namespace: "product-model", value: "iPhone18,2" },
        },
        {
          modelType: { family: "ipad", variant: "air", sizeInches: "11" },
          model: { namespace: "product-model", value: "iPad16,1" },
        },
        {
          modelType: { family: "ipad", variant: "air", sizeInches: "13" },
          model: { namespace: "product-model", value: "iPad16,2" },
        },
      ],
    },
    os: { selector: { kind: "exact", version: "27.0" }, preferredVersion: "27.0" },
    ...overrides,
  };
}

export function androidCatalog(
  overrides: Partial<AndroidSessionDeviceCatalog> = {},
): AndroidSessionDeviceCatalog {
  return {
    platform: "android",
    provenance: { source: "fake-sdk", revision: "catalog-android-1", state: "ready" },
    profiles: [
      { profileId: "pixel_phone", archetype: "phone", metadataState: "current" },
      { profileId: "pixel_tablet", archetype: "tablet", metadataState: "current" },
    ],
    releases: [
      {
        systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
        osVersion: "15",
        versionPrecision: "major",
        apiLevel: 35,
        abi: "arm64-v8a",
        flavor: "google_apis",
        installed: true,
        metadataState: "current",
      },
      {
        systemImagePackage: "system-images;android-35.1;google_apis;arm64-v8a",
        osVersion: "15.0.1",
        versionPrecision: "patch",
        apiLevel: 35,
        abi: "arm64-v8a",
        flavor: "google_apis",
        installed: true,
        metadataState: "current",
      },
      {
        systemImagePackage: "system-images;android-36;google_apis;arm64-v8a",
        osVersion: "16",
        versionPrecision: "major",
        apiLevel: 36,
        abi: "arm64-v8a",
        flavor: "google_apis",
        installed: true,
        metadataState: "current",
      },
    ],
    ...overrides,
  };
}

export function androidDefaults(
  overrides: Partial<AndroidSessionRequirementDefaults> = {},
): AndroidSessionRequirementDefaults {
  return {
    platform: "android",
    policyVersion: "defaults-android-1",
    hardware: {
      omitted: "phone",
      profiles: [
        { archetype: "phone", profileId: "pixel_phone" },
        { archetype: "tablet", profileId: "pixel_tablet" },
      ],
    },
    os: { selector: { kind: "exact", version: "15" }, preferredVersion: "15" },
    ...overrides,
  };
}

export function unwrap<T>(result: RequirementResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

export function unwrapError(result: RequirementResult<unknown>): SessionRequirementError {
  if (result.ok) {
    throw new Error("Expected a requirement error.");
  }
  return result.error;
}
