import type { DeviceInfo } from "../../models";
import { androidProfileFormFactor } from "../../models/formFactor";
import { logger } from "../logger";
import type { AvdConfig, AvdConfigReader } from "./AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "./AndroidSystemImageRuntime";
import { configuredAvdArchitecture } from "./AndroidDeviceInventoryScanner";

/**
 * Enrich a list of DeviceInfo with config.ini metadata (osVersion, screen size, form factor)
 */
export async function enrichDeviceInfoList(
  avdConfigReader: AvdConfigReader,
  devices: DeviceInfo[],
): Promise<DeviceInfo[]> {
  const enriched = await Promise.all(
    devices.map(async (device) => {
      try {
        const config = await avdConfigReader.readConfig(device.name);
        if (!config) {
          return device;
        }
        const formFactor = avdConfigFormFactor(config);
        return deviceInfoFromConfig(device, config, formFactor);
      } catch (error) {
        logger.debug(`Failed to enrich AVD ${device.name}: ${error}`);
        return device;
      }
    }),
  );
  return enriched;
}

function deviceInfoFromConfig(
  device: DeviceInfo,
  config: AvdConfig,
  formFactor: ReturnType<typeof androidProfileFormFactor>,
): DeviceInfo {
  return {
    ...device,
    apiLevel: config.apiLevel ?? device.apiLevel,
    osVersion: config.osVersion ?? device.osVersion,
    runtimeId: config.systemImagePackage ?? device.runtimeId,
    deviceType: config.deviceName ?? device.deviceType,
    architecture: configuredAvdArchitecture(config, device.architecture),
    screenWidth: config.screenWidth ?? device.screenWidth,
    screenHeight: config.screenHeight ?? device.screenHeight,
    screenDensity: config.screenDensity ?? device.screenDensity,
    formFactor: formFactor === "unknown" ? device.formFactor : formFactor,
    capabilityInventory: config.capabilityInventory ?? device.capabilityInventory,
    ...guestHardwareFromConfig(device, config),
  };
}

function guestHardwareFromConfig(
  device: DeviceInfo,
  config: AvdConfig,
): Pick<
  DeviceInfo,
  "configuredRamMb" | "configuredCpuCores" | "effectiveRamMb" | "effectiveCpuCores"
> {
  return {
    configuredRamMb: config.ramSizeMb ?? device.configuredRamMb,
    configuredCpuCores: config.hardware?.cpuCores ?? device.configuredCpuCores,
    effectiveRamMb: config.effectiveRamMb ?? device.effectiveRamMb,
    effectiveCpuCores: config.effectiveCpuCores ?? device.effectiveCpuCores,
  };
}

/** The same configured profile and geometry classify inventory and sessionless reads. */
export function avdConfigFormFactor(
  config: AvdConfig,
): ReturnType<typeof androidProfileFormFactor> {
  return androidProfileFormFactor({
    systemImageTag: config.systemImagePackage
      ? parseAndroidSystemImageRuntime(config.systemImagePackage)?.tag
      : undefined,
    profileId: config.deviceName,
    width: config.screenWidth,
    height: config.screenHeight,
    density: config.screenDensity,
  });
}
