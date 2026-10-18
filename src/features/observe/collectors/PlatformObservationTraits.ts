import type { BootedDevice, ObserveResult } from "../../../models";
import { wasIosHierarchyAcquiredFromDevice } from "../observationReadScope";

/**
 * The per-platform facts an observation stamps onto its result. Each platform
 * answers once here instead of ObserveScreen comparing `device.platform` inline.
 */
export interface PlatformObservationTraits {
  /** Coordinate unit stamped onto `screenSize` (output only; numbers stay platform-native). */
  screenSizeUnits(): NonNullable<ObserveResult["screenSize"]["units"]>;
  /** Orientation of a settled screenshot relative to the display. */
  settledScreenshotOrientation(): NonNullable<ObserveResult["screenshotOrientation"]>;
  /** True for an iOS device exposing more than one display panel (foldable / multi-screen). */
  isIosMultiPanel(): boolean;
  /**
   * Whether the hierarchy was read from the device, so the observation may grant action
   * acquisition authority. Android's cached-ok may serve a client cache with fresh=false.
   */
  grantsObservationRead(result: ObserveResult): boolean;
}

const ANDROID_TRAITS: PlatformObservationTraits = {
  screenSizeUnits: () => "physical-pixels",
  settledScreenshotOrientation: () => "display",
  isIosMultiPanel: () => false,
  grantsObservationRead: (result) => result.viewHierarchy?.fresh === true,
};

/** Other platforms keep the Android defaults and always grant the observation read. */
const UNKNOWN_TRAITS: PlatformObservationTraits = {
  ...ANDROID_TRAITS,
  grantsObservationRead: () => true,
};

function iosTraits(device: () => BootedDevice): PlatformObservationTraits {
  return {
    screenSizeUnits: () => "points",
    settledScreenshotOrientation: () => "native",
    isIosMultiPanel: () => (device().displays?.panels.length ?? 0) > 1,
    grantsObservationRead: (result) => wasIosHierarchyAcquiredFromDevice(result.viewHierarchy),
  };
}

export function platformObservationTraits(
  platform: BootedDevice["platform"],
  device: () => BootedDevice,
): PlatformObservationTraits {
  if (platform === "ios") {
    return iosTraits(device);
  }
  return platform === "android" ? ANDROID_TRAITS : UNKNOWN_TRAITS;
}
