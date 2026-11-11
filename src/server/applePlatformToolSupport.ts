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
    "sendKeys",
    "postNotification",
    "rotateCrown",
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
    // simctl spawn <udid> log show, as on an iOS simulator (#17547).
    "getLogs",
  ]),
  tvos: new Set<string>([
    "getLogs",
    "crashApp",
    "explore",
    "executePlan",
    "sendKeys",
    "tapOn",
    "focusNavigate",
    "pressButton",
    "observe",
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
    "openLink",
    "getDeepLinks",
    // simctl io recordVideo / screenshot capture (#16725).
    "videoRecording",
    "compareScreenshot",
    // XCUIRemote home press (#17525), simctl push (#17526), simctl privacy (#17527).
    "homeScreen",
    "postNotification",
    "setAppPermissions",
  ]),
  // simctl lifecycle and app management; observe, tapOn and sendKeys go through the window-app XCUITest runner.
  visionos: new Set<string>([
    // simctl spawn <udid> log show, as on an iOS simulator (#18011).
    "getLogs",
    "installApp",
    "uninstallApp",
    "launchApp",
    "terminateApp",
    "listApps",
    "observe",
    "tapOn",
    "sendKeys",
    "listDevices",
    "listDeviceImages",
    "provisionDevice",
    "deleteDevice",
    "startDevice",
    "setActiveDevice",
    "killDevice",
  ]),
};

/**
 * Tools whose capability the tvOS simulator runtime itself lacks (#17529, captured on tvOS 26.5):
 * `simctl ui appearance|content_size` and `simctl status_bar` fail with NSPOSIXErrorDomain code 45
 * (Operation not supported), `simctl pbcopy|pbpaste` with "Pasteboard is not supported by this
 * runtime" (SimError 403), and `simctl privacy` has no read verb. These refuse as "not available",
 * not "not supported yet".
 */
const TVOS_UNAVAILABLE_CAPABILITIES: Readonly<Record<string, string>> = {
  displayConfig: "the tvOS simulator runtime does not support appearance or content size changes",
  statusBar: "the tvOS simulator runtime has no status bar override",
  clipboard: "the tvOS simulator runtime has no pasteboard",
  getAppPermissions:
    "simctl cannot read app permissions on an Apple TV simulator; set them with setAppPermissions",
};

export function unsupportedPlatformToolMessage(
  toolName: string,
  platform: NonIosApplePlatform,
): string {
  if (
    platform === "tvos" &&
    ["tapAt", "swipeOn", "pinchOn", "multiTouch", "dragAndDrop", "tapAny"].includes(toolName)
  ) {
    return `${toolName} does not support tvOS touch gestures; use focus navigation via pressButton (up/down/left/right/select).`;
  }
  if (platform === "tvos" && Object.hasOwn(TVOS_UNAVAILABLE_CAPABILITIES, toolName)) {
    return `${toolName} is not available on tvOS: ${TVOS_UNAVAILABLE_CAPABILITIES[toolName]}. Target an Android or iOS device instead.`;
  }
  return (
    `${toolName} does not support ${NON_IOS_APPLE_PLATFORM_LABELS[platform]} yet. ` +
    "Target an Android or iOS device instead."
  );
}

/** Throws an ActionableError when `device` is a non-iOS Apple device and `toolName` has not opted in. */
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
  for (const platform of ["tvos", "visionos"] as const) {
    if (named.includes(platform) && !APPLE_PLATFORM_SUPPORTED_TOOLS[platform].has(toolName)) {
      throw new ActionableError(unsupportedPlatformToolMessage(toolName, platform));
    }
  }
}
