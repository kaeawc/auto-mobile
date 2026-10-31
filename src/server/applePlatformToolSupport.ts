import { ActionableError, type BootedDevice } from "../models";
import {
  isAndroidOrIosPlatform,
  NON_IOS_APPLE_PLATFORM_LABELS,
  type NonIosApplePlatform,
} from "../models/Platform";

/**
 * Device-aware tools that accept each non-iOS Apple platform. Every other device-aware tool rejects
 * such a device before its handler runs (docs/decisions/watchos-platform.md). Add a tool to a
 * platform only together with that platform's behaviour and tests that make it safe.
 */
export const APPLE_PLATFORM_SUPPORTED_TOOLS: Readonly<
  Record<NonIosApplePlatform, ReadonlySet<string>>
> = {
  watchos: new Set<string>([
    "installApp",
    "uninstallApp",
    "listApps",
    "launchApp",
    "terminateApp",
    "observe",
  ]),
  tvos: new Set<string>(),
};

export function unsupportedPlatformToolMessage(
  toolName: string,
  platform: NonIosApplePlatform,
): string {
  return (
    `${toolName} does not support ${NON_IOS_APPLE_PLATFORM_LABELS[platform]} yet. ` +
    "Target an Android or iOS device instead."
  );
}

/** Throws an ActionableError when `device` is a watch or an Apple TV and `toolName` has not opted in. */
export function assertToolSupportsDevicePlatform(
  toolName: string,
  device: Pick<BootedDevice, "platform">,
  supportedTools: Readonly<
    Record<NonIosApplePlatform, ReadonlySet<string>>
  > = APPLE_PLATFORM_SUPPORTED_TOOLS,
): void {
  const platform = device.platform;
  if (isAndroidOrIosPlatform(platform) || supportedTools[platform].has(toolName)) {
    return;
  }
  throw new ActionableError(unsupportedPlatformToolMessage(toolName, platform));
}

/**
 * Plain tools (device management such as killDevice) look up their target themselves and are not
 * behind the registry's device gate, so each refuses an Apple TV request by name before any lookup.
 * Without this, a `tvos` request could fall through to the iOS simulator path.
 */
export function assertRequestNotTvos(toolName: string, args: object): void {
  const { platform, target } = args as { platform?: unknown; target?: unknown };
  const targetPlatform =
    target !== null && typeof target === "object"
      ? (target as { platform?: unknown }).platform
      : undefined;
  if (platform === "tvos" || targetPlatform === "tvos") {
    throw new ActionableError(unsupportedPlatformToolMessage(toolName, "tvos"));
  }
}
