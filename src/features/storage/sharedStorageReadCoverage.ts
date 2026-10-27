import type { Platform } from "../../models";

export interface SharedStorageReadCoverage {
  readonly list: boolean;
  readonly read: boolean;
}

export const IOS_MEDIA_READ_UNSUPPORTED_REASON =
  "simctl addmedia imports fixtures but exposes no supported bounded enumeration or read API for imported media.";

/** Coverage of registered bounded namespace readers. */
export function describeDefaultSharedStorageReadCoverage(
  platform: Platform,
  domain: "user_files" | "media_library" = "user_files",
): SharedStorageReadCoverage {
  const available = domain === "user_files" || platform === "android";
  return { list: available, read: available };
}
