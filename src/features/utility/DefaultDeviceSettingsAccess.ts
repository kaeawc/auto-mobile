import type { BootedDevice } from "../../models";
import {
  type DeviceSettingKey,
  type DeviceSettingValue,
  type DeviceSettingValues,
} from "../../models/DeviceSettingDefaults";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  DisplayConfig,
  type DisplayConfigDependencies,
  type DisplayConfigValues,
  type DisplayTheme,
  type SetDisplayConfigInput,
  type ThemeBaselineStore,
} from "./DisplayConfig";
import { SystemConfigurationManager } from "./SystemConfigurationManager";
import {
  isIosContentSizeCategory,
  unrecordedContentSizeBaselines,
} from "./IosSimulatorDisplayConfig";
import {
  ACCESSIBILITY_DISPLAY_FIELDS,
  type AccessibilityDisplayField,
  type AccessibilityDisplaySnapshot,
} from "./AccessibilityDisplayPreferences";
import type { DeviceSettingsAccess } from "./DeviceSettingDefaults";
import { getAbortSignal, runWithAbortSignal } from "../../utils/AbortContext";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";

export const DISPLAY_KEYS = ["fontScale", "contentSize", "density", "nightMode"] as const;

/** Keys read and written through DisplayConfig (display fields and accessibility preferences). */
const DISPLAY_CONFIG_KEYS: readonly DeviceSettingKey[] = [
  ...DISPLAY_KEYS,
  ...ACCESSIBILITY_DISPLAY_FIELDS,
];

function accessibilityKeys(keys: readonly DeviceSettingKey[]): AccessibilityDisplayField[] {
  return ACCESSIBILITY_DISPLAY_FIELDS.filter((field) => keys.includes(field));
}

export function pick(
  values: DeviceSettingValues,
  keys: readonly DeviceSettingKey[],
): DeviceSettingValues {
  return Object.fromEntries(
    keys.filter((key) => key in values).map((key) => [key, values[key]]),
  ) as DeviceSettingValues;
}

/** Night mode written by a reset must not be taken for a displayConfig night-mode baseline. */
export const unrecordedThemeBaselines: ThemeBaselineStore = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
};

/** Reads and writes settings through DisplayConfig and SystemConfigurationManager. */
export class DefaultDeviceSettingsAccess implements DeviceSettingsAccess {
  constructor(
    private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory,
    /** iOS Simulator seam; DisplayConfig's own SimCtlClient when omitted. */
    private readonly simctlFor?: (device: BootedDevice) => DisplayConfigDependencies["simctl"],
  ) {}

  private displayConfig(
    device: BootedDevice,
    dependencies: DisplayConfigDependencies = {},
  ): DisplayConfig {
    const simctl = this.simctlFor?.(device);
    return new DisplayConfig(device, {
      adbFactory: this.adbFactory,
      ...(simctl ? { simctl } : {}),
      ...dependencies,
    });
  }

  async read(
    device: BootedDevice,
    keys: readonly DeviceSettingKey[],
    signal: AbortSignal | undefined = getAbortSignal(),
  ): Promise<DeviceSettingValues> {
    signal?.throwIfAborted();
    return runWithAbortSignal(signal, () =>
      awaitWhileRequestIsLive(this.readValues(device, keys), signal),
    );
  }

  private async readValues(
    device: BootedDevice,
    keys: readonly DeviceSettingKey[],
  ): Promise<DeviceSettingValues> {
    const values: DeviceSettingValues = {};
    if (keys.some((key) => (DISPLAY_KEYS as readonly string[]).includes(key))) {
      Object.assign(
        values,
        displaySettingValues(await this.displayConfig(device).getRestorableConfig()),
      );
    }
    const accessibility = accessibilityKeys(keys);
    if (accessibility.length > 0) {
      Object.assign(
        values,
        await this.displayConfig(device).accessibility().readSnapshot(accessibility),
      );
    }
    if (keys.some((key) => !DISPLAY_CONFIG_KEYS.includes(key))) {
      const settings = await new SystemConfigurationManager(
        device,
        this.adbFactory,
      ).getLocalizationSettings();
      if (settings.success) {
        Object.assign(values, {
          // Android locale changes are per app (API 33+) or need root and a framework restart
          // (older): only the iOS Simulator's device-wide locale is reset.
          ...(device.platform === "ios" && settings.locale ? { locale: settings.locale } : {}),
          ...(settings.timeFormat !== undefined ? { timeFormat: settings.timeFormat } : {}),
          ...(settings.calendarSystem ? { calendarSystem: settings.calendarSystem } : {}),
        });
      }
    }
    return pick(values, keys);
  }

  async write(device: BootedDevice, values: DeviceSettingValues): Promise<DeviceSettingKey[]> {
    const written: DeviceSettingKey[] = [];
    const display = displayInput(values);
    if (display.keys.length > 0) {
      const result = await this.displayConfig(device, {
        themeBaselines: unrecordedThemeBaselines,
        contentSizeBaselines: unrecordedContentSizeBaselines,
      }).setConfig(display.input);
      if (result.success) {
        written.push(...display.keys);
      } else {
        logger.warn(`Failed to reset display settings on ${device.deviceId}: ${result.error}`);
      }
    }
    written.push(...(await this.writeAccessibility(device, values)));
    const manager = new SystemConfigurationManager(device, this.adbFactory);
    if (typeof values.locale === "string") {
      const result = await manager.setLocale(values.locale, { broadcast: false });
      this.collect(result, "locale", device, written);
    }
    if ("timeFormat" in values) {
      if (await this.writeTimeFormat(device, manager, values.timeFormat ?? null)) {
        written.push("timeFormat");
      }
    }
    if (typeof values.calendarSystem === "string") {
      const result = await manager.setCalendarSystem(values.calendarSystem);
      this.collect(result, "calendarSystem", device, written);
    }
    return written;
  }

  /** Restore recorded accessibility preferences without recording a displayConfig baseline. */
  private async writeAccessibility(
    device: BootedDevice,
    values: DeviceSettingValues,
  ): Promise<DeviceSettingKey[]> {
    const snapshot: AccessibilityDisplaySnapshot = Object.fromEntries(
      ACCESSIBILITY_DISPLAY_FIELDS.filter(
        (field) => typeof values[field] === "string" || values[field] === null,
      ).map((field) => [field, values[field]]),
    );
    if (Object.keys(snapshot).length === 0) {
      return [];
    }
    return this.displayConfig(device).accessibility().restoreSnapshot(snapshot);
  }

  private collect(
    result: { success: boolean; error?: string },
    key: DeviceSettingKey,
    device: BootedDevice,
    written: DeviceSettingKey[],
  ): void {
    if (result.success) {
      written.push(key);
    } else {
      logger.warn(`Failed to reset ${key} on ${device.deviceId}: ${result.error}`);
    }
  }

  private async writeTimeFormat(
    device: BootedDevice,
    manager: SystemConfigurationManager,
    value: DeviceSettingValue,
  ): Promise<boolean> {
    if (value === "12" || value === "24") {
      const result = await manager.set24HourFormat(value === "24");
      if (!result.success) {
        logger.warn(`Failed to reset timeFormat on ${device.deviceId}: ${result.error}`);
      }
      return result.success;
    }
    if (device.platform !== "android") {
      // No unset path on the iOS Simulator; the record is dropped rather than retried forever.
      logger.warn(`Cannot unset the 24-hour override on ${device.deviceId}; leaving it as is`);
      return true;
    }
    try {
      // An unset `time_12_24` follows the locale; deleting it restores that.
      await this.adbFactory
        .create(device)
        .executeCommand("shell settings delete system time_12_24");
      return true;
    } catch (error) {
      logger.warn(
        `Failed to unset timeFormat on ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }
}

/** Restorable displayConfig values keyed as device settings (`theme` is recorded as `nightMode`). */
function displaySettingValues(display: DisplayConfigValues): DeviceSettingValues {
  return {
    ...(display.fontScale !== undefined ? { fontScale: display.fontScale } : {}),
    ...(display.density !== undefined ? { density: display.density } : {}),
    ...(display.theme !== undefined ? { nightMode: display.theme } : {}),
    ...(display.contentSize !== undefined ? { contentSize: display.contentSize } : {}),
  };
}

export function displayInput(values: DeviceSettingValues): {
  input: SetDisplayConfigInput;
  keys: DeviceSettingKey[];
} {
  const input: SetDisplayConfigInput = {};
  const keys: DeviceSettingKey[] = [];
  if (typeof values.fontScale === "number" || values.fontScale === "default") {
    input.fontScale = values.fontScale;
    keys.push("fontScale");
  }
  if (typeof values.density === "number" || values.density === "default") {
    input.density = values.density;
    keys.push("density");
  }
  if (isIosContentSizeCategory(values.contentSize)) {
    input.contentSize = values.contentSize;
    keys.push("contentSize");
  }
  if (typeof values.nightMode === "string") {
    input.theme = values.nightMode as DisplayTheme;
    keys.push("nightMode");
  }
  return { input, keys };
}
