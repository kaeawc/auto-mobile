import {
  iosDeviceSpecificationMismatch,
  matchesAndroidDeviceSpecification,
} from "../../../devices/deviceSpecMatching";
import {
  type AndroidDeviceSpecification,
  type IosDeviceSpecification,
} from "../../../devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../models/index";
import type { FormFactor } from "../../../models/DeviceMatchCriteria";
import { androidProfileFormFactor } from "../../../models/formFactor";
import type { BindingDeviceFamily } from "../../../utils/provisionDeviceSpecSchemas";
import { inferIosFormFactor } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import { parseAndroidSystemImageRuntime } from "../../../utils/android-cmdline-tools/AndroidSystemImageRuntime";
import type { AvdConfigReader } from "../../../utils/android-cmdline-tools/AvdConfigReader";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { matchesWatchSimulator } from "./watchBindingSpec";

type WithOptionalDeviceType<T extends { deviceType: string }> = Omit<T, "deviceType"> & {
  deviceType?: string;
  deviceFamily?: BindingDeviceFamily;
};

/**
 * A binding's requested spec: an exact spec whose `deviceType` (the model or hardware
 * profile) may be omitted. Omitted means "any model" (owner decision Q4), constrained only by an
 * optional `deviceFamily`: matching retains the requested constraints, and a device that must be
 * created gets a compatible model the resolver picks and records in the resolved spec.
 */
export type BindingRequestedSpec =
  | WithOptionalDeviceType<AndroidDeviceSpecification>
  /**
   * Also an Apple Watch spec (#15882), which is the subset `{ runtime, deviceType }` with both
   * required (`watchBindingSpecSchema`); the watch resolver refuses anything more or less.
   */
  | WithOptionalDeviceType<IosDeviceSpecification>;

/** `unknown` means the device's configuration could not be read; it never justifies deletion. */
export type ManagedSpecMatch = "match" | "mismatch" | "unknown";

export interface ManagedSpecMatcher {
  matches(device: DeviceInfo, spec: BindingRequestedSpec): Promise<ManagedSpecMatch>;
}

/** Matches with the shared exact-provisioning matchers (#11100) — one definition of "matches". */
export class DefaultManagedSpecMatcher implements ManagedSpecMatcher {
  constructor(private readonly androidConfigReader: Pick<AvdConfigReader, "readConfig">) {}

  async matches(device: DeviceInfo, spec: BindingRequestedSpec): Promise<ManagedSpecMatch> {
    switch (device.platform) {
      case "watchos":
        // Exact runtime and device type only: never an AVD config or iOS form-factor inference.
        return matchesWatchSimulator(device, spec);
      case "android":
        return await this.matchesAndroid(device, spec);
      case "ios":
        return matchesIosSimulator(device, spec);
      case "tvos":
        // No binding spec describes an Apple TV yet, so one is never reused for a binding.
        return "mismatch";
    }
  }

  private async matchesAndroid(
    device: DeviceInfo,
    spec: BindingRequestedSpec,
  ): Promise<ManagedSpecMatch> {
    let config: Awaited<ReturnType<AvdConfigReader["readConfig"]>>;
    try {
      config = await this.androidConfigReader.readConfig(device.name);
    } catch (error) {
      logger.warn(
        `[Bindings] cannot read AVD config for '${device.name}': ${errorMessage(error)}`,
        error,
      );
      return "unknown";
    }
    if (!config) {
      return "unknown";
    }
    // An omitted hardware profile is unconstrained: the AVD's own profile (even an unset one)
    // satisfies it.
    const constraints = {
      ...(spec as WithOptionalDeviceType<AndroidDeviceSpecification>),
      deviceType: (spec.deviceType ?? config.deviceName) as string,
    };
    if (!matchesAndroidDeviceSpecification(constraints, config)) {
      return "mismatch";
    }
    return matchDeviceFamily(spec.deviceFamily, () =>
      androidProfileFormFactor({
        systemImageTag: config.systemImagePackage
          ? parseAndroidSystemImageRuntime(config.systemImagePackage)?.tag
          : undefined,
        profileId: config.deviceName,
        width: config.screenWidth,
        height: config.screenHeight,
        density: config.screenDensity,
      }),
    );
  }
}

function matchesIosSimulator(device: DeviceInfo, spec: BindingRequestedSpec): ManagedSpecMatch {
  // An unavailable simulator (runtime unmounted, or listed under a different Xcode or
  // DEVELOPER_DIR) proves nothing about its configuration, so it is never a mismatch to replace.
  if (
    device.isAvailable === false ||
    device.runtime === undefined ||
    (spec.deviceType !== undefined && device.deviceType === undefined)
  ) {
    return "unknown";
  }
  // An omitted model is unconstrained: the simulator's own model satisfies it.
  const constraints = {
    runtime: spec.runtime,
    deviceType: spec.deviceType ?? device.deviceType!,
  };
  return iosDeviceSpecificationMismatch(constraints, device) === undefined
    ? matchDeviceFamily(spec.deviceFamily, () => inferIosFormFactor(device.deviceType))
    : "mismatch";
}

function matchDeviceFamily(
  requested: BindingDeviceFamily | undefined,
  infer: () => FormFactor | undefined,
): ManagedSpecMatch {
  if (requested === undefined) {
    return "match";
  }
  const actual = infer();
  if (actual === undefined || actual === "unknown") {
    return "unknown";
  }
  return actual === requested ? "match" : "mismatch";
}
