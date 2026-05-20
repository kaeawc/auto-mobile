import type { ProcessExecutor } from "../../../utils/ProcessExecutor";
import type {
  BootedDevice,
  GetCalendarSystemResult,
  LocalizationSettingsResult,
  Set24HourFormatResult,
  SetCalendarSystemResult,
  SetLocaleResult,
  SetTextDirectionResult,
  SetTimeZoneResult,
} from "../../../models";
import type {
  BroadcastOptions,
  SystemConfigurationAdapter,
} from "../../../utils/interfaces/SystemConfigurationAdapter";
import {
  extractCalendarFromLocale,
  normalizeSettingValue,
  normalizeTimeFormat,
} from "./parsing";

const IOS_PHYSICAL_DEVICE_ERROR = "Localization changes are only supported on iOS Simulator.";
const DEFAULT_CALENDAR_SYSTEM = "gregory";
const SIMULATOR_UDID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

/**
 * iOS implementation of {@link SystemConfigurationAdapter}. Routes
 * reads and writes through `xcrun simctl spawn … defaults`, so only
 * simulators are supported — physical devices return an error result.
 */
export class IosSystemConfigurationAdapter implements SystemConfigurationAdapter {
  readonly defaultCalendarSystem = DEFAULT_CALENDAR_SYSTEM;

  constructor(
    private readonly device: BootedDevice,
    private readonly processExecutor: ProcessExecutor
  ) {}

  async setLocale(languageTag: string, _options: BroadcastOptions): Promise<SetLocaleResult> {
    if (!this.isSimulator()) {
      return { success: false, languageTag, error: IOS_PHYSICAL_DEVICE_ERROR };
    }

    try {
      const previousLanguageTag = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
      const appleLocale = this.toAppleLocale(languageTag);
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleLocale", appleLocale);

      const languages = this.buildAppleLanguages(languageTag);
      const arrayArgs = languages.map(l => `"${l}"`).join(" ");
      await this.processExecutor.exec(
        this.iosSpawnCommand(`defaults write .GlobalPreferences AppleLanguages -array ${arrayArgs}`)
      );

      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
      if (!readBack || readBack !== appleLocale) {
        return {
          success: false,
          languageTag,
          previousLanguageTag,
          error: `Read-back verification failed: expected "${appleLocale}" but got "${readBack ?? "null"}"`
        };
      }

      return {
        success: true,
        languageTag,
        previousLanguageTag,
        appliedLanguages: languages,
        method: "defaults write AppleLocale + AppleLanguages"
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        languageTag,
        error: `Failed to set locale: ${errorMessage}`
      };
    }
  }

  async setTimeZone(zoneId: string): Promise<SetTimeZoneResult> {
    if (!this.isSimulator()) {
      return { success: false, zoneId, error: IOS_PHYSICAL_DEVICE_ERROR };
    }

    try {
      const previousZoneId = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");

      // Disable auto-timezone before setting
      await this.iosDefaultsWrite(
        "com.apple.mobiletimerd",
        "AutomaticTimeZoneSetting",
        "-bool NO"
      );

      await this.iosDefaultsWrite(".GlobalPreferences", "AppleTimeZone", zoneId);

      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");
      if (!readBack || readBack !== zoneId) {
        return {
          success: false,
          zoneId,
          previousZoneId,
          error: `Read-back verification failed: expected "${zoneId}" but got "${readBack ?? "null"}"`
        };
      }

      return {
        success: true,
        zoneId,
        previousZoneId
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        zoneId,
        error: `Failed to set time zone: ${errorMessage}`
      };
    }
  }

  async setTextDirection(rtl: boolean, _options: BroadcastOptions): Promise<SetTextDirectionResult> {
    return {
      success: false,
      rtl,
      error: "Text direction is not supported on iOS. RTL is driven by the app's language; set an RTL locale (e.g., ar_SA) instead."
    };
  }

  async set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult> {
    if (!this.isSimulator()) {
      return { success: false, enabled, error: IOS_PHYSICAL_DEVICE_ERROR };
    }

    try {
      const previousRaw = await this.iosDefaultsRead(".GlobalPreferences", "AppleICUForce24HourTime");
      const previousFormat = normalizeTimeFormat(
        previousRaw === "1" ? "24" : previousRaw === "0" ? "12" : previousRaw
      );

      const boolValue = enabled ? "-bool YES" : "-bool NO";
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleICUForce24HourTime", boolValue);

      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleICUForce24HourTime");
      const expectedReadBack = enabled ? "1" : "0";
      if (!readBack || readBack !== expectedReadBack) {
        return {
          success: false,
          enabled,
          previousFormat,
          error: `Read-back verification failed: expected "${expectedReadBack}" but got "${readBack ?? "null"}"`
        };
      }

      return {
        success: true,
        enabled,
        previousFormat
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        enabled,
        error: `Failed to set 24-hour format: ${errorMessage}`
      };
    }
  }

  async setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult> {
    if (!this.isSimulator()) {
      return { success: false, calendarSystem, error: IOS_PHYSICAL_DEVICE_ERROR };
    }

    try {
      const previousCalendarSystem = await this.iosDefaultsRead(".GlobalPreferences", "AppleCalendar");
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleCalendar", calendarSystem);
      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleCalendar");
      if (!readBack || readBack !== calendarSystem) {
        return {
          success: false,
          calendarSystem: readBack ?? calendarSystem,
          previousCalendarSystem,
          error: `Read-back verification failed: expected "${calendarSystem}" but got "${readBack ?? "null"}"`
        };
      }
      return {
        success: true,
        calendarSystem: readBack,
        previousCalendarSystem
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        calendarSystem,
        error: `Failed to set calendar system: ${errorMessage}`
      };
    }
  }

  async getCalendarSystem(): Promise<GetCalendarSystemResult> {
    if (!this.isSimulator()) {
      return {
        success: false,
        calendarSystem: DEFAULT_CALENDAR_SYSTEM,
        source: "default",
        error: IOS_PHYSICAL_DEVICE_ERROR
      };
    }

    const calendar = await this.iosDefaultsRead(".GlobalPreferences", "AppleCalendar");
    if (calendar) {
      return {
        success: true,
        calendarSystem: calendar,
        source: "default"
      };
    }

    const locale = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
    if (locale) {
      const calendarFromLocale = extractCalendarFromLocale(locale);
      if (calendarFromLocale) {
        return {
          success: true,
          calendarSystem: calendarFromLocale,
          locale,
          source: "locale"
        };
      }
    }

    return {
      success: true,
      calendarSystem: DEFAULT_CALENDAR_SYSTEM,
      locale: locale ?? null,
      source: "default"
    };
  }

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    if (!this.isSimulator()) {
      return { success: false, error: IOS_PHYSICAL_DEVICE_ERROR };
    }

    const locale = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
    const languages = await this.iosDefaultsRead(".GlobalPreferences", "AppleLanguages");
    const timeZone = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");
    const timeFormatRaw = await this.iosDefaultsRead(".GlobalPreferences", "AppleICUForce24HourTime");
    const timeFormat = normalizeTimeFormat(
      timeFormatRaw === "1" ? "24" : timeFormatRaw === "0" ? "12" : timeFormatRaw
    );
    const calendarResult = await this.getCalendarSystem();

    return {
      success: true,
      locale,
      languages,
      timeZone,
      textDirection: null,
      timeFormat,
      calendarSystem: calendarResult.calendarSystem ?? null
    };
  }

  async broadcastLocaleChange(): Promise<boolean> {
    // iOS has no equivalent broadcast intent; SpringBoard restart is
    // handled separately via `applyIosLiveChanges`.
    return false;
  }

  buildAppleLanguages(languageTag: string): string[] {
    const languages: string[] = [languageTag];
    const parts = languageTag.split("-");
    for (let i = parts.length - 1; i >= 1; i--) {
      const shorter = parts.slice(0, i).join("-");
      if (!languages.includes(shorter)) {
        languages.push(shorter);
      }
    }
    return languages;
  }

  private isSimulator(): boolean {
    return SIMULATOR_UDID_PATTERN.test(this.device.deviceId);
  }

  private iosSpawnCommand(command: string): string {
    return `xcrun simctl spawn ${this.device.deviceId} ${command}`;
  }

  private async iosDefaultsRead(domain: string, key: string): Promise<string | null> {
    try {
      const result = await this.processExecutor.exec(
        this.iosSpawnCommand(`defaults read ${domain} ${key}`)
      );
      return normalizeSettingValue(result.stdout);
    } catch {
      return null;
    }
  }

  private async iosDefaultsWrite(domain: string, key: string, value: string): Promise<void> {
    await this.processExecutor.exec(
      this.iosSpawnCommand(`defaults write ${domain} ${key} ${value}`)
    );
  }

  private toAppleLocale(languageTag: string): string {
    return languageTag.replace(/-/g, "_");
  }
}
