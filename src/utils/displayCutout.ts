import type { Platform } from "../models/Platform";

export const DISPLAY_CUTOUT_PREFERENCES = [
  "none",
  "notch",
  "dynamic_island",
  "hole_punch",
  "any",
] as const;

export type DisplayCutoutPreference = (typeof DISPLAY_CUTOUT_PREFERENCES)[number];
export type DisplayCutoutClassification = Exclude<DisplayCutoutPreference, "any"> | "unknown";

const IOS_NO_CUTOUT_IDENTIFIERS = new Set([
  "iphone-se",
  "iphone-se-2nd-generation",
  "iphone-se-3rd-generation",
  "iphone-6",
  "iphone-6-plus",
  "iphone-6s",
  "iphone-6s-plus",
  "iphone-7",
  "iphone-7-plus",
  "iphone-8",
  "iphone-8-plus",
  "ipod-touch-7th-generation",
]);

const IOS_NOTCH_IDENTIFIERS = new Set([
  "iphone-x",
  "iphone-xr",
  "iphone-xs",
  "iphone-xs-max",
  "iphone-11",
  "iphone-11-pro",
  "iphone-11-pro-max",
  "iphone-12",
  "iphone-12-mini",
  "iphone-12-pro",
  "iphone-12-pro-max",
  "iphone-13",
  "iphone-13-mini",
  "iphone-13-pro",
  "iphone-13-pro-max",
  "iphone-14",
  "iphone-14-plus",
  "iphone-16e",
]);

const IOS_DYNAMIC_ISLAND_IDENTIFIERS = new Set([
  "iphone-14-pro",
  "iphone-14-pro-max",
  "iphone-15",
  "iphone-15-plus",
  "iphone-15-pro",
  "iphone-15-pro-max",
  "iphone-16",
  "iphone-16-plus",
  "iphone-16-pro",
  "iphone-16-pro-max",
  "iphone-17",
  "iphone-17-pro",
  "iphone-17-pro-max",
  "iphone-air",
  "iphone-17e",
]);

const ANDROID_NO_CUTOUT_IDS = new Set([
  "pixel",
  "pixel_2",
  "pixel_2_xl",
  "pixel_3",
  "pixel_3a",
  "pixel_3a_xl",
  "pixel_4",
  "pixel_4_xl",
  "pixel_c",
  "pixel_tablet",
]);

const ANDROID_NOTCH_IDS = new Set(["pixel_3_xl"]);

const ANDROID_HOLE_PUNCH_IDS = new Set([
  "pixel_4a",
  "pixel_4a_5g",
  "pixel_5",
  "pixel_5a",
  "pixel_6",
  "pixel_6_pro",
  "pixel_6a",
  "pixel_7",
  "pixel_7_pro",
  "pixel_7a",
  "pixel_8",
  "pixel_8_pro",
  "pixel_8a",
  "pixel_9",
  "pixel_9_pro",
  "pixel_9_pro_xl",
  "pixel_9_pro_fold",
]);

function simulatorDeviceTypeName(deviceType: string): string {
  const prefix = "com.apple.CoreSimulator.SimDeviceType.";
  return deviceType.startsWith(prefix)
    ? deviceType
        .slice(prefix.length)
        .toLowerCase()
        .replaceAll(/-+/g, "-")
        .replaceAll(/(^-|-$)/g, "")
    : "";
}

/**
 * Classifies device profiles from their public platform identifiers. This
 * intentionally never uses camera metadata: a device may have cameras without
 * a display obstruction, and the simulator/AVD catalog does not publish a
 * portable cutout capability.
 */
export function classifyDisplayCutout(
  platform: Platform,
  deviceType: string,
): DisplayCutoutClassification {
  if (platform === "ios") {
    const identifier = simulatorDeviceTypeName(deviceType);
    if (IOS_NO_CUTOUT_IDENTIFIERS.has(identifier) || identifier.startsWith("ipad-")) {
      return "none";
    }
    if (IOS_NOTCH_IDENTIFIERS.has(identifier)) {
      return "notch";
    }
    if (IOS_DYNAMIC_ISLAND_IDENTIFIERS.has(identifier)) {
      return "dynamic_island";
    }
    return "unknown";
  }

  const identifier = deviceType.toLowerCase();
  if (ANDROID_NO_CUTOUT_IDS.has(identifier)) {
    return "none";
  }
  if (ANDROID_NOTCH_IDS.has(identifier)) {
    return "notch";
  }
  if (ANDROID_HOLE_PUNCH_IDS.has(identifier)) {
    return "hole_punch";
  }
  return "unknown";
}
