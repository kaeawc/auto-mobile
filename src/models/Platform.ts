import { ActionableError } from "./ActionableError";

/**
 * Platforms AutoMobile drives. `"watchos"` is an Apple Watch simulator and `"tvos"` an Apple TV
 * simulator. A tool rejects either unless the tool opts in (docs/decisions/watchos-platform.md),
 * so neither is ever driven as an iPhone.
 */
export type Platform = "android" | "ios" | "watchos" | "tvos";

/** The platforms every tool supports. */
export type AndroidOrIosPlatform = "android" | "ios";

/** Apple platforms other than iOS. A tool supports each only by opting in. */
export type NonIosApplePlatform = Exclude<Platform, AndroidOrIosPlatform>;

/** How messages name each non-iOS Apple platform. */
export const NON_IOS_APPLE_PLATFORM_LABELS: Readonly<Record<NonIosApplePlatform, string>> = {
  watchos: "watchOS",
  tvos: "tvOS",
};

/** A platform selector: one platform, or `"either"` for whichever is connected. */
export type SomePlatform = Platform | "either";

/** A selector for code that only handles Android and iOS. */
export type AndroidOrIosSelector = AndroidOrIosPlatform | "either";

export function isAndroidOrIosPlatform(platform: string): platform is AndroidOrIosPlatform {
  return platform === "android" || platform === "ios";
}

/**
 * Whether a device on `platform` satisfies an optional platform request. No request means
 * "either" (Android or iOS): a watch or an Apple TV is reached only when asked for by name (#14908).
 */
export function matchesPlatformSelector(
  platform: Platform,
  requested: Platform | undefined,
): boolean {
  return requested === undefined ? isAndroidOrIosPlatform(platform) : platform === requested;
}

/**
 * Narrow a device platform for Android/iOS-only code. Throws an ActionableError naming the
 * operation and platform for a watch or an Apple TV, so platform branches never fall through to
 * the iPhone or Android path.
 */
export function requireAndroidOrIosPlatform(
  platform: Platform,
  operation: string,
): AndroidOrIosPlatform {
  if (isAndroidOrIosPlatform(platform)) {
    return platform;
  }
  throw nonIosApplePlatformNotSupportedError(operation, platform);
}

/** Like requireAndroidOrIosPlatform, for a selector that may be `"either"`. */
export function requireAndroidOrIosSelector(
  platform: SomePlatform,
  operation: string,
): AndroidOrIosSelector {
  return platform === "either" ? platform : requireAndroidOrIosPlatform(platform, operation);
}

function nonIosApplePlatformNotSupportedError(
  operation: string,
  platform: NonIosApplePlatform,
): ActionableError {
  return new ActionableError(
    `${operation} is not supported on ${NON_IOS_APPLE_PLATFORM_LABELS[platform]} yet. ` +
      "Target an Android or iOS device instead.",
  );
}
