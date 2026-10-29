import { ActionableError } from "./ActionableError";

/**
 * Platforms AutoMobile drives. `"watchos"` is an Apple Watch simulator. A tool rejects it unless
 * the tool opts in (docs/decisions/watchos-platform.md), so a watch is never driven as an iPhone.
 */
export type Platform = "android" | "ios" | "watchos";

/** The platforms every tool supports. */
export type AndroidOrIosPlatform = "android" | "ios";

/** A platform selector: one platform, or `"either"` for whichever is connected. */
export type SomePlatform = Platform | "either";

/** A selector for code that only handles Android and iOS. */
export type AndroidOrIosSelector = AndroidOrIosPlatform | "either";

export function isAndroidOrIosPlatform(platform: string): platform is AndroidOrIosPlatform {
  return platform === "android" || platform === "ios";
}

/**
 * Whether a device on `platform` satisfies an optional platform request. No request means
 * "either" (Android or iOS): a watch is reached only when asked for by name (#14908).
 */
export function matchesPlatformSelector(
  platform: Platform,
  requested: Platform | undefined,
): boolean {
  return requested === undefined ? isAndroidOrIosPlatform(platform) : platform === requested;
}

/**
 * Narrow a device platform for Android/iOS-only code. Throws an ActionableError naming the
 * operation for a watch, so platform branches never fall through to the iPhone or Android path.
 */
export function requireAndroidOrIosPlatform(
  platform: Platform,
  operation: string,
): AndroidOrIosPlatform {
  if (isAndroidOrIosPlatform(platform)) {
    return platform;
  }
  throw watchOsNotSupportedError(operation);
}

/** Like requireAndroidOrIosPlatform, for a selector that may be `"either"`. */
export function requireAndroidOrIosSelector(
  platform: SomePlatform,
  operation: string,
): AndroidOrIosSelector {
  return platform === "either" ? platform : requireAndroidOrIosPlatform(platform, operation);
}

function watchOsNotSupportedError(operation: string): ActionableError {
  return new ActionableError(
    `${operation} is not supported on watchOS yet. Target an Android or iOS device instead.`,
  );
}
