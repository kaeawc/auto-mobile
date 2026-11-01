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
    "tapOn",
    "tapAt",
    "swipeOn",
    "pressButton",
    "installApp",
    "uninstallApp",
    "listApps",
    "launchApp",
    "terminateApp",
    "observe",
  ]),
  tvos: new Set<string>([
    "installApp",
    "uninstallApp",
    "launchApp",
    "terminateApp",
    "listApps",
    "listDevices",
    "listDeviceImages",
    "provisionDevice",
    "deleteDevice",
    "startDevice",
    "setActiveDevice",
    "killDevice",
  ]),
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

/** A non-iOS Apple platform a request names, or undefined for Android, iOS or none. */
function requestedApplePlatform(value: unknown): NonIosApplePlatform | undefined {
  return typeof value === "string" && value in NON_IOS_APPLE_PLATFORM_LABELS
    ? (value as NonIosApplePlatform)
    : undefined;
}

/**
 * Device-aware tools refuse a request that names a non-iOS Apple platform the tool has not opted in
 * to, before target resolution. Resolution replaces the requested platform with a session's own,
 * so without this a `tvos` request with an iOS session would run on that iPhone.
 */
export function assertRequestedPlatformSupported(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  supportedTools: Readonly<
    Record<NonIosApplePlatform, ReadonlySet<string>>
  > = APPLE_PLATFORM_SUPPORTED_TOOLS,
): void {
  const platform = requestedApplePlatform(args.platform);
  if (platform !== undefined && !supportedTools[platform].has(toolName)) {
    throw new ActionableError(unsupportedPlatformToolMessage(toolName, platform));
  }
}

/** Where a plain tool's request can name its platform: top level, or in a nested object. */
const NESTED_PLATFORM_KEYS = ["target", "device"] as const;

function nestedPlatform(value: unknown): unknown {
  return value !== null && typeof value === "object"
    ? (value as { platform?: unknown }).platform
    : undefined;
}

/**
 * Plain tools (device management such as killDevice) look up their target themselves and are not
 * behind the registry's device gate, so tools that have not opted in refuse an Apple TV request
 * by name before any lookup.
 * Without this, a `tvos` request could fall through to the iOS simulator path.
 */
export function assertRequestNotTvos(toolName: string, args: object): void {
  const record = args as Record<string, unknown>;
  const named = [
    record.platform,
    ...NESTED_PLATFORM_KEYS.map((key) => nestedPlatform(record[key])),
  ];
  if (named.includes("tvos") && !APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has(toolName)) {
    throw new ActionableError(unsupportedPlatformToolMessage(toolName, "tvos"));
  }
}
