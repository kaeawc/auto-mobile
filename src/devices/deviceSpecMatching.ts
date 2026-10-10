import type { DeviceInfo } from "../models";
import type { AndroidAvdConfiguration } from "../models/AndroidAvdConfiguration";
import type { Platform } from "../models/Platform";
import type { AvdConfigReader } from "../utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import type { AppleDeviceRuntime, AppleDeviceType } from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  evaluateRuntimeCompatibility,
  type DeviceTypeRuntimeBounds,
} from "../utils/ios-cmdline-tools/runtimeCompatibility";
import {
  classifyDisplayCutout,
  type DisplayCutoutClassification,
  type DisplayCutoutPreference,
} from "../utils/displayCutout";

/**
 * Spec-to-device matchers shared by exact provisioning (#11100) and managed-slot reconciliation
 * (#11175). One definition of "this existing device satisfies this spec", so the generic adopt
 * path and the slot reuse/replace decision can never disagree.
 *
 * Omitted optional fields are unconstrained: an absent `configuration` key or `displayCutout`
 * accepts any value the device has (owner decision Q4, #11172).
 */

export interface AndroidSpecConstraints {
  runtime: string;
  deviceType: string;
  configuration?: AndroidAvdConfiguration;
}

export interface IosSpecConstraints {
  runtime: string;
  deviceType: string;
}

export type AndroidAvdConfigSnapshot = Awaited<ReturnType<AvdConfigReader["readConfig"]>>;

/** Same system image (API, tag, ABI, package) and the same hardware profile. */
export function matchesAndroidDeviceIdentity(
  spec: AndroidSpecConstraints,
  config: AndroidAvdConfigSnapshot,
): boolean {
  const runtime = parseAndroidSystemImageRuntime(spec.runtime);
  if (!runtime || !config) {
    return false;
  }
  return (
    config.apiLevel === runtime.apiLevel &&
    config.tag === runtime.tag &&
    config.architecture === runtime.architecture &&
    config.deviceName === spec.deviceType &&
    config.systemImagePackage === runtime.systemImagePackage
  );
}

/** Identity plus every explicitly requested hardware configuration key. */
export function matchesAndroidDeviceSpecification(
  spec: AndroidSpecConstraints,
  config: AndroidAvdConfigSnapshot,
): boolean {
  return (
    matchesAndroidDeviceIdentity(spec, config) &&
    (spec.configuration?.memoryMb === undefined ||
      config?.ramSizeMb === spec.configuration.memoryMb) &&
    Object.entries(spec.configuration ?? {}).every(
      ([key, value]) =>
        key === "memoryMb" ||
        value === undefined ||
        ((key !== "gpuMode" || config?.gpuEnabled === true) &&
          config?.hardware?.[key as keyof AndroidAvdConfiguration] === value),
    )
  );
}

/** Why an existing simulator does not satisfy a spec, or undefined when it does. */
export type IosSpecMismatch = "unavailable" | "mismatch";

export function iosDeviceSpecificationMismatch(
  spec: IosSpecConstraints,
  device: Pick<DeviceInfo, "isAvailable" | "runtime" | "deviceType">,
): IosSpecMismatch | undefined {
  if (device.isAvailable === false) {
    return "unavailable";
  }
  if (device.runtime !== spec.runtime || device.deviceType !== spec.deviceType) {
    return "mismatch";
  }
  return undefined;
}

export type DisplayCutoutResolution =
  | { kind: "resolved"; displayCutout: DisplayCutoutClassification }
  | { kind: "unsupported" | "identity_conflict"; message: string };

/**
 * Resolve a requested cutout preference against the exact device type. An omitted or `any`
 * preference is unconstrained and records the type's actual classification.
 */
export function resolveDisplayCutoutPreference(
  platform: Platform,
  spec: { deviceType: string; displayCutout?: DisplayCutoutPreference },
): DisplayCutoutResolution {
  const resolved = classifyDisplayCutout(platform, spec.deviceType);
  const preference = spec.displayCutout;
  if (preference === undefined || preference === "any") {
    return { kind: "resolved", displayCutout: resolved };
  }
  if (resolved === "unknown") {
    return {
      kind: "unsupported",
      message: `Display cutout preference '${preference}' is unsupported for ${platform} device type '${spec.deviceType}' because its cutout class is unknown.`,
    };
  }
  if (resolved !== preference) {
    return {
      kind: "identity_conflict",
      message: `Exact ${platform} device type '${spec.deviceType}' has display cutout '${resolved}', not requested '${preference}'.`,
    };
  }
  return { kind: "resolved", displayCutout: resolved };
}

/** Proven incompatibility of an exact iOS model/runtime pair, with installed alternatives. */
export interface IosPairIncompatibility {
  /** The runtime is installed but CoreSimulator marked it unavailable. */
  unavailable: boolean;
  runtime: AppleDeviceRuntime;
  bounds: DeviceTypeRuntimeBounds | undefined;
  /** Installed, available runtimes that do support the requested model. */
  compatibleRuntimes: Array<{ id: string; version: string }>;
}

/**
 * Evaluate an exact iOS pair against a simctl catalog. Returns undefined unless the catalog
 * proves the pair incompatible: a runtime or device type missing from the catalog, or a model
 * without runtime-range metadata, is unknown, not unsupported, and simctl stays the authority.
 */
export function evaluateIosPairCompatibility(
  spec: IosSpecConstraints,
  runtimes: readonly AppleDeviceRuntime[],
  deviceTypes: readonly AppleDeviceType[],
): IosPairIncompatibility | undefined {
  const runtime = runtimes.find((entry) => entry.identifier === spec.runtime);
  const deviceType = deviceTypes.find((entry) => entry.identifier === spec.deviceType);
  if (!runtime || !deviceType) {
    return undefined;
  }
  const evaluation = evaluateRuntimeCompatibility(deviceType, runtime.version);
  const unavailable = !runtime.isAvailable;
  if (!unavailable && evaluation.status !== "unsupported") {
    return undefined;
  }
  return {
    unavailable,
    runtime,
    bounds: evaluation.bounds,
    compatibleRuntimes: runtimes
      .filter(
        (entry) =>
          entry.isAvailable &&
          evaluateRuntimeCompatibility(deviceType, entry.version).status === "supported",
      )
      .map((entry) => ({ id: entry.identifier, version: entry.version })),
  };
}
