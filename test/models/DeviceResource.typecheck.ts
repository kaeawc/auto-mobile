import type {
  AndroidDeviceResource,
  AppleDeviceResource,
  DeviceResource,
  DeviceResourceMap,
  DeviceResourceState,
  DeviceResourceStatus,
} from "../../src/models";

type Assert<Condition extends true> = Condition;

/** Compile-only regression checks, enforced by the normal typecheck gate. */
export type DeviceResourceContractChecks = [
  Assert<AndroidDeviceResource extends DeviceResource ? true : false>,
  Assert<AppleDeviceResource extends DeviceResource ? true : false>,
  Assert<{} extends AndroidDeviceResource["resources"] ? false : true>,
  Assert<{} extends AppleDeviceResource["resources"] ? false : true>,
  Assert<"icloudSync" extends keyof AndroidDeviceResource["resources"] ? false : true>,
  Assert<"googlePlayServices" extends keyof AppleDeviceResource["resources"] ? false : true>,
  Assert<AndroidDeviceResource["platform"] extends "android" ? true : false>,
  Assert<AppleDeviceResource["platform"] extends "ios" ? true : false>,
  Assert<
    Omit<AppleDeviceResource["resources"], "icloudSync"> extends AppleDeviceResource["resources"]
      ? false
      : true
  >,
  Assert<
    Omit<AppleDeviceResource["resources"], "photoAnalysis"> extends AppleDeviceResource["resources"]
      ? false
      : true
  >,
  Assert<
    Omit<
      AndroidDeviceResource["resources"],
      "googlePlayServices"
    > extends AndroidDeviceResource["resources"]
      ? false
      : true
  >,
  Assert<"requested" extends DeviceResourceState ? false : true>,
  Assert<
    { state: "enabled" | "disabled" | "unsupported" | "unknown" } extends DeviceResourceStatus
      ? true
      : false
  >,
];

// Use assignments here: conditional types do not reproduce the compiler's
// permissive assignment of an index signature to a mapped Record.
declare const resources: Record<string, DeviceResourceStatus>;
// @ts-expect-error Unchecked dictionaries do not establish required Android fields.
const android: AndroidDeviceResource = { deviceId: "android", platform: "android", resources };
// @ts-expect-error Unchecked dictionaries do not establish required Apple fields.
const apple: AppleDeviceResource = { deviceId: "ios", platform: "ios", resources };
void [android, apple];

declare const commonResources: DeviceResourceMap & Record<string, DeviceResourceStatus>;
const androidWithOnlyCommon: AndroidDeviceResource = {
  deviceId: "android",
  platform: "android",
  // @ts-expect-error Verified common keys do not establish Android-specific fields.
  resources: commonResources,
};
const appleWithOnlyCommon: AppleDeviceResource = {
  deviceId: "ios",
  platform: "ios",
  // @ts-expect-error Verified common keys do not establish Apple-specific fields.
  resources: commonResources,
};
void [androidWithOnlyCommon, appleWithOnlyCommon];
