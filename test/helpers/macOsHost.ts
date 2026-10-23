import { describe, test } from "bun:test";

/**
 * iOS simulator behaviour only exists on a macOS host, and several iOS-only
 * assertions depend on the host's path rules (POSIX file URLs). Gate them with
 * `macOsOnlyTest` / `macOsOnlyDescribe` so they never run on the Linux or Windows runners.
 */
export const isMacOsHost = process.platform === "darwin";

/** `test`, skipped on any host that is not macOS. */
export const macOsOnlyTest = test.skipIf(!isMacOsHost);

/** `describe`, skipped on any host that is not macOS. */
export const macOsOnlyDescribe = describe.skipIf(!isMacOsHost);
