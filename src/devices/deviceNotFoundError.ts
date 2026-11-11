import { ActionableError, type BootedDevice, type DeviceInfo } from "../models";
import {
  NON_IOS_APPLE_PLATFORM_LABELS,
  type NonIosApplePlatform,
  type Platform,
} from "../models/Platform";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { PlatformDeviceManager } from "./deviceDiscoveryContracts";

/** Platforms startDevice boots, in the order messages list them. */
export const START_DEVICE_PLATFORMS: readonly Platform[] = [
  "android",
  "ios",
  "watchos",
  "tvos",
  "visionos",
];

const OTHER_APPLE_PLATFORMS: readonly NonIosApplePlatform[] = ["watchos", "tvos", "visionos"];

const IOS_NOT_FOUND_HINT =
  ` startDevice platforms: ${START_DEVICE_PLATFORMS.join(", ")}. The iOS images above never include ` +
  'Apple Watch, Apple TV or Apple Vision Pro simulators: start a watch with platform: "watchos" ' +
  '(an Apple TV with "tvos", a Vision Pro with "visionos") and its UDID or exact name.' +
  ' To create a simulator, enable provisionDevice (enableTools) and call it with device {"platform":"ios","name":"<name>","spec":{"runtime":"<runtime identifier>","deviceType":"<device type identifier>","displayCutout":"any"}}' +
  ' (for a watch, "platform":"watchos" with a watchOS runtime and Apple Watch device type); remove it with deleteDevice.';

/**
 * The non-iOS Apple simulator family an iOS request's `deviceId` belongs to, so an iOS request for
 * a watch, TV or Vision Pro UDID names the platform to use (#18053). Other platforms are not
 * looked up. Families whose inventory cannot be read are skipped: the caller still reports the
 * device as not found.
 */
export async function findOtherAppleSimulatorPlatform(
  deviceManager: Pick<PlatformDeviceManager, "listDeviceImages">,
  { deviceId, platform: requested }: { deviceId: string; platform: Platform },
  signal?: AbortSignal,
): Promise<NonIosApplePlatform | undefined> {
  if (requested !== "ios") {
    return undefined;
  }
  const matches = await Promise.all(
    OTHER_APPLE_PLATFORMS.map(async (platform) => {
      try {
        const images = await deviceManager.listDeviceImages(platform, signal);
        return images.some((image) => image.deviceId === deviceId) ? platform : undefined;
      } catch (error) {
        signal?.throwIfAborted();
        logger.warn(
          `[DeviceBoot] ${platform} simulator lookup for '${deviceId}' failed: ${errorMessage(error)}`,
          error,
        );
        return undefined;
      }
    }),
  );
  return matches.find((platform) => platform !== undefined);
}

/** The error for an explicit deviceId that is neither booted nor an image on its platform. */
export function deviceNotFoundError(
  request: { deviceId: string; platform: Platform },
  booted: readonly BootedDevice[],
  images: readonly DeviceInfo[],
  otherPlatform?: NonIosApplePlatform,
): ActionableError {
  if (otherPlatform) {
    return new ActionableError(
      `Device '${request.deviceId}' is a ${NON_IOS_APPLE_PLATFORM_LABELS[otherPlatform]} simulator, not an iOS simulator. ` +
        `Call startDevice with platform: "${otherPlatform}" and the same deviceId.`,
    );
  }
  return new ActionableError(
    `Device '${request.deviceId}' not found. Available booted: ${booted.map((device) => device.deviceId).join(", ") || "none"}. ` +
      `Available images: ${images.map((device) => device.name).join(", ") || "none"}.` +
      (request.platform === "ios" ? IOS_NOT_FOUND_HINT : ""),
  );
}
