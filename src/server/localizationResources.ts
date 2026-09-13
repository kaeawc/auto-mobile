import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { SystemConfigurationManager } from "../features/utility/SystemConfigurationManager";
import { BootedDevice, LocalizationSettingsResult } from "../models";
import { logger } from "../utils/logger";
import { findBootedDeviceForResource } from "./resourceDeviceResolver";

const LOCALIZATION_RESOURCE_TEMPLATES = {
  DEVICE_LOCALIZATION: "automobile:devices/{deviceId}/localization",
} as const;

export interface LocalizationSettingsProvider {
  getLocalizationSettings(): Promise<LocalizationSettingsResult>;
}

interface LocalizationResourceContent {
  deviceId: string;
  platform: BootedDevice["platform"];
  locale: string | null;
  timeZone: string | null;
  textDirection: "ltr" | "rtl" | null;
  timeFormat: "12" | "24" | null;
  calendarSystem: string | null;
  lastUpdated: string;
  success: boolean;
  error?: string;
}

async function findBootedDevice(deviceId: string): Promise<BootedDevice | null> {
  return findBootedDeviceForResource(deviceId, "LocalizationResources");
}

function toLocalizationResourceContent(
  device: BootedDevice,
  settings: LocalizationSettingsResult,
): LocalizationResourceContent {
  return {
    deviceId: device.deviceId,
    platform: device.platform,
    locale: settings.locale ?? null,
    timeZone: settings.timeZone ?? null,
    textDirection: settings.textDirection ?? null,
    timeFormat: settings.timeFormat ?? null,
    calendarSystem: settings.calendarSystem ?? null,
    lastUpdated: new Date().toISOString(),
    success: settings.success,
    error: settings.error,
  };
}

export async function getLocalizationResource(
  deviceId: string,
  createSettingsProvider: (device: BootedDevice) => LocalizationSettingsProvider = (device) =>
    new SystemConfigurationManager(device),
): Promise<ResourceContent> {
  const uri = `automobile:devices/${deviceId}/localization`;
  const device = await findBootedDevice(deviceId);
  if (!device) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Device not found or not booted: ${deviceId}`,
        },
        null,
        2,
      ),
    };
  }

  const provider = createSettingsProvider(device);
  const settings = await provider.getLocalizationSettings();
  const content = toLocalizationResourceContent(device, settings);

  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(content, null, 2),
  };
}

export function registerLocalizationResources(): void {
  ResourceRegistry.registerTemplate(
    LOCALIZATION_RESOURCE_TEMPLATES.DEVICE_LOCALIZATION,
    "Device Localization Settings",
    "Current localization settings (locale, time zone, text direction, time format, calendar) for a device.",
    "application/json",
    async (params) => getLocalizationResource(params.deviceId),
  );

  logger.info("[LocalizationResources] Registered localization resources");
}
