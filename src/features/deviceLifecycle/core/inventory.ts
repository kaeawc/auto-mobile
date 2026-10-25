import { BootedDevice, DeviceInfo, Platform } from "../../../models";
import { IOSCtrlProxyManager } from "../../../ctrlProxy/IOSCtrlProxyManager";
import {
  describeInventoryDevice,
  type TransitionalHold,
  transitionalHoldInputs,
} from "../../../daemon/inventoryDeviceDescription";
import { projectListDevicesEntry, poolHoldFor } from "../../../daemon/deviceDescription";
import { defaultDaemonContext, type DevicePoolReads } from "../../../daemon/daemonContext";
import {
  type StableConfiguredDeviceImage,
  configuredImageForBootedDevice,
  configuredImagesByStableId,
} from "../../../utils/configuredDeviceInventory";
import {
  AndroidAvdProvenanceCache,
  CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
} from "../../../utils/AndroidAvdProvenanceCache";
import {
  PlatformDeviceManager,
  type BootedDeviceDiscoveryOptions,
} from "../../../devices/deviceUtils";
import { type AvdManager } from "../../../utils/android-cmdline-tools/interfaces/AvdManager";
import { type Timer } from "../../../utils/SystemTimer";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { ANDROID_INVENTORY_RETRY_AFTER_MS } from "../../../constants/deviceResourceUris";
import { type DeviceMatchCriteria } from "../../../models/DeviceMatchCriteria";
import { INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM } from "../../../daemon/wire/constants";
import { type AvdInfo } from "../../../utils/android-cmdline-tools/avdmanager";

export function androidSourceImageWithBootedMetadata(
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
  admittedAndroidImage: DeviceInfo | undefined,
): DeviceInfo | undefined {
  if (device.platform !== "android") {
    return sourceImage;
  }
  if (!sourceImage && !admittedAndroidImage) {
    return undefined;
  }
  return {
    ...(sourceImage ?? admittedAndroidImage),
    name: sourceImage?.name ?? device.name,
    platform: "android",
    isRunning: true,
    apiLevel: [device.apiLevel, sourceImage?.apiLevel, admittedAndroidImage?.apiLevel].find(
      (value) => value !== undefined,
    ),
    osVersion: [device.osVersion, sourceImage?.osVersion, admittedAndroidImage?.osVersion].find(
      (value) => value !== undefined,
    ),
  };
}

export function androidDeviceIdentityPayload(
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): Record<string, unknown> {
  const portMatch = /^emulator-(\d+)$/.exec(device.deviceId);
  const androidImage = sourceImage?.platform === "android" ? sourceImage : undefined;
  return {
    platform: "android",
    avdName: androidImage?.name ?? device.name,
    adbSerial: device.deviceId,
    emulatorConsolePort: portMatch ? Number(portMatch[1]) : null,
  };
}

export function deviceIdentityPayload(
  device: BootedDevice,
  sourceImage?: DeviceInfo,
): Record<string, unknown> {
  if (device.platform === "android") {
    return androidDeviceIdentityPayload(device, sourceImage);
  }

  const ctrlProxy = IOSCtrlProxyManager.getInstance(device);
  return {
    platform: "ios",
    simulatorUdid: device.deviceId,
    simulatorName: device.name,
    iosServicePort: ctrlProxy.getServicePort(),
    iosRunnerGeneration: ctrlProxy.getRunnerGeneration(),
  };
}

export function projectAndroidTransportDescription(
  description: ReturnType<typeof describeInventoryDevice>,
  aliases: string[],
) {
  const projected = projectListDevicesEntry(description);
  return { ...projected, ...(aliases.length ? { transportAliases: aliases } : {}) };
}

export function initializedDeviceSessionUuid(deviceId: string): string | undefined {
  return defaultDaemonContext.deviceSessionRegistry()?.getByDeviceId(deviceId)?.deviceSessionUuid;
}

export function listDevicePayloads(
  booted: BootedDevice[],
  devicePool: DevicePoolReads | undefined,
  configuredImages: ReadonlyMap<string, StableConfiguredDeviceImage>,
  aliasesForDevice: (deviceId: string) => string[] = (deviceId) =>
    devicePool?.getAndroidTransportAliases(deviceId) ?? [],
  transportAvdNameForDevice: (deviceId: string) => string | undefined = (deviceId) =>
    devicePool?.getAndroidTransportAvdName(deviceId),
  /**
   * Held devices their platform lists in a transitional state, by device id: Android in a
   * non-`device` adb state (#11455), iOS `Booting` / `Shutting Down` (#11573).
   */
  transitionalHolds: ReadonlyMap<string, TransitionalHold> = new Map(),
) {
  const sessionManager = defaultDaemonContext.sessionManager();
  const sessions = new Map(
    sessionManager?.getAllSessions().map((session) => [session.sessionId, session]),
  );
  return booted.map((device) => {
    const pooled = devicePool?.describesPooledRuntime(device)
      ? (devicePool.getDevice(device.deviceId) ?? undefined)
      : undefined;
    const description = describeInventoryDevice({
      device,
      pooled,
      unhealthy: pooled ? devicePool?.getDeviceHealthMarker(device.deviceId) : undefined,
      configuredImages,
      sessionsById: sessions,
      deviceSessionUuid: pooled ? initializedDeviceSessionUuid(device.deviceId) : undefined,
      hold: pooled ? poolHoldFor(devicePool, device.deviceId) : undefined,
      poolStatus: pooled ? devicePool?.poolBucket(device.deviceId) : undefined,
      ...transitionalHoldInputs(transitionalHolds.get(device.deviceId)),
      transportAvdName: transportAvdNameForDevice(device.deviceId),
    });
    if (device.platform === "android") {
      return projectAndroidTransportDescription(description, aliasesForDevice(device.deviceId));
    }
    return projectListDevicesEntry(description);
  });
}

/**
 * The acquisition boot already resolved its selected image. Re-project that
 * known image rather than rediscovering the entire configured inventory while
 * returning the session response. Android provenance is optional cache-only
 * enrichment; a cold cache deliberately leaves the nullable image link empty.
 */
export function configuredImageForAcquiredDevice(
  device: BootedDevice,
  sourceImage: DeviceInfo | undefined,
): StableConfiguredDeviceImage | undefined {
  if (sourceImage?.platform !== device.platform) {
    return undefined;
  }
  const image =
    device.platform === "ios" && !sourceImage.deviceId
      ? { ...sourceImage, deviceId: device.deviceId }
      : sourceImage;
  const configured = configuredImageForBootedDevice(
    device,
    configuredImagesByStableId(device.platform, {
      devices: [image],
      succeededPlatforms: new Set([device.platform]),
    }),
  );
  if (!configured || device.platform !== "android") {
    return configured;
  }
  const provenance = AndroidAvdProvenanceCache.getInstance()
    .getCachedByName()
    ?.get(configured.name);
  return provenance
    ? {
        ...configured,
        image: {
          path: provenance.path,
          target: provenance.target,
          basedOn: provenance.basedOn,
        },
      }
    : configured;
}

export async function configuredImagesForBootedDevices(
  deviceManager: PlatformDeviceManager,
  avdManager: Pick<AvdManager, "listDeviceImages">,
  booted: readonly BootedDevice[],
  timer: Timer,
): Promise<{
  images: ReadonlyMap<string, StableConfiguredDeviceImage>;
  enrichment?: {
    complete: false;
    missing: Array<"configuredImages" | "provenance">;
    retryable: boolean;
    retryAfterMs?: number;
    reason?: string;
  };
}> {
  const images = new Map<string, StableConfiguredDeviceImage>();
  let incomplete = false;
  const platforms = [...new Set(booted.map((device) => device.platform))];
  await Promise.all(
    platforms.map(async (platform) => {
      const controller = new AbortController();
      try {
        const [discovery, androidProvenance] = await raceWithDeadline(
          Promise.all([
            deviceManager.getDeviceImagesDetailed(platform, {
              signal: controller.signal,
              coalesceInventoryEnrichment: true,
            }),
            platform === "android"
              ? AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer)
              : Promise.resolve(new Map()),
          ]),
          {
            timer,
            signal: controller.signal,
            label: "Configured image inventory",
            timeoutMs: CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
            onTimeout: () =>
              controller.abort(new Error("Configured image inventory caller budget elapsed")),
          },
        );
        if (!discovery.succeededPlatforms.has(platform)) {
          incomplete = true;
        }
        for (const [key, image] of configuredImagesByStableId(platform, discovery)) {
          const provenance = androidProvenance.get(image.name);
          images.set(
            key,
            provenance
              ? {
                  ...image,
                  image: {
                    path: provenance.path,
                    target: provenance.target,
                    basedOn: provenance.basedOn,
                  },
                }
              : image,
          );
        }
      } catch (error) {
        incomplete = true;
        logger.warn(
          `listDevices configured ${platform} image inventory failed: ${errorMessage(error)}`,
          error,
        );
      }
    }),
  );
  const provenance = platforms.includes("android")
    ? AndroidAvdProvenanceCache.getInstance().getStatus()
    : { state: "cached" as const };
  if (provenance.state === "failed") {
    return {
      images,
      enrichment: {
        complete: false,
        missing: ["provenance"],
        retryable: false,
        reason: `avdmanager unavailable: ${provenance.cause}`,
      },
    };
  }
  if (incomplete || provenance.state !== "cached") {
    return {
      images,
      enrichment: {
        complete: false,
        missing: ["configuredImages"],
        retryable: true,
        retryAfterMs: ANDROID_INVENTORY_RETRY_AFTER_MS,
      },
    };
  }
  return { images };
}

export interface ListDeviceImagesArgs {
  platform: Platform;
}

export interface ListDevicesArgs {
  platform?: "android" | "ios";
  requires?: DeviceMatchCriteria["requires"];
}

export function acceptancePresentationOrder(
  args: Record<string, unknown>,
): "forward" | "reverse" | undefined {
  const order = args[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM];
  return order === "forward" || order === "reverse" ? order : undefined;
}

export function detailedDiscoveryOptions(
  presentationOrder: "forward" | "reverse" | undefined,
): BootedDeviceDiscoveryOptions {
  return presentationOrder === undefined ? {} : { presentationOrder };
}

export async function androidProvenanceByAvdName(
  avdManager: Pick<AvdManager, "listDeviceImages">,
  timer: Timer,
): Promise<ReadonlyMap<string, AvdInfo>> {
  return AndroidAvdProvenanceCache.getInstance().getByName(avdManager, timer);
}
