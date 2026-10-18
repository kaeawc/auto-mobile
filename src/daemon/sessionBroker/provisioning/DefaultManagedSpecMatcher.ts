import {
  iosDeviceSpecificationMismatch,
  matchesAndroidDeviceSpecification,
} from "../../../devices/deviceSpecMatching";
import { type AndroidDeviceSpecification } from "../../../devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../models/index";
import type { FormFactor } from "../../../models/DeviceMatchCriteria";
import { androidProfileFormFactor } from "../../../models/formFactor";
import type { BindingDeviceFamily } from "./reconciler";
import { inferIosFormFactor } from "../../../utils/ios-cmdline-tools/iosDeviceType";
import type { AvdConfigReader } from "../../../utils/android-cmdline-tools/AvdConfigReader";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type {
  BindingRequestedSpec,
  ManagedSpecMatch,
  ManagedSpecMatcher,
  WithOptionalDeviceType,
} from "./reconciler";

/** Matches with the shared exact-provisioning matchers (#11100) — one definition of "matches". */
export class DefaultManagedSpecMatcher implements ManagedSpecMatcher {
  constructor(private readonly androidConfigReader: Pick<AvdConfigReader, "readConfig">) {}

  async matches(device: DeviceInfo, spec: BindingRequestedSpec): Promise<ManagedSpecMatch> {
    if (device.platform === "android") {
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
          profileId: config.deviceName,
          width: config.screenWidth,
          height: config.screenHeight,
          density: config.screenDensity,
        }),
      );
    }
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
}

export function matchDeviceFamily(
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
