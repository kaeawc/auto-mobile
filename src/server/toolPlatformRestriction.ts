import { ActionableError, type BootedDevice } from "../models";
import { PLATFORM_LABELS, type Platform } from "../models/Platform";

/**
 * A device-aware tool's typed platform restriction (#18721): the only platforms its handler can
 * drive. A tool without one runs on every platform the registry's platform gate admits.
 */
export type ToolPlatforms = readonly [Platform, ...Platform[]];

function platformList(platforms: ToolPlatforms, conjunction: "and" | "or"): string {
  const labels = platforms.map((platform) => PLATFORM_LABELS[platform]);
  return labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(", ")} ${conjunction} ${labels.at(-1)}`;
}

export function toolPlatformRestrictionMessage(
  toolName: string,
  platforms: ToolPlatforms,
  device: Pick<BootedDevice, "platform" | "deviceId">,
): string {
  // A device runs one platform, so the target suggestion offers the alternatives with "or" (#19172).
  return (
    `${toolName} is only supported on ${platformList(platforms, "and")}; ${device.deviceId} is ` +
    `${PLATFORM_LABELS[device.platform]}. Target a device running ${platformList(platforms, "or")} instead.`
  );
}

/** Throws one ActionableError when a restricted tool is dispatched to a device outside it. */
export function assertDeviceInToolPlatforms(
  toolName: string,
  platforms: ToolPlatforms | undefined,
  device: Pick<BootedDevice, "platform" | "deviceId">,
): void {
  if (platforms === undefined || platforms.includes(device.platform)) {
    return;
  }
  throw new ActionableError(toolPlatformRestrictionMessage(toolName, platforms, device));
}
