import type { ProcessExecutor } from "../../../utils/ProcessExecutor";
import { logger } from "../../../utils/logger";
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
import {
  buildAppleLanguages,
  iosSpawnCommand,
  isIosSimulator,
  parseAppleTimeFormatRaw,
} from "./iosHelpers";
import {
  CommandLineLockdownLocaleClient,
  type LockdownLocaleClient,
} from "./IosLockdownLocaleClient";

const IOS_PHYSICAL_TIME_ZONE_ERROR = "Time zone changes are not supported on physical iOS devices because iOS exposes no lockdown key for this setting.";
const IOS_PHYSICAL_24_HOUR_ERROR = "24-hour format changes are not supported on physical iOS devices because iOS exposes no lockdown key for this setting.";
const IOS_PHYSICAL_CALENDAR_ERROR = "Calendar system changes are not supported as an independent setting on physical iOS devices; encode calendar in the locale when supported.";
const DEFAULT_CALENDAR_SYSTEM = "gregory";

/**
 * iOS implementation of {@link SystemConfigurationAdapter}. Simulators use
 * `xcrun simctl spawn … defaults`; physical devices use lockdownd for locale
 * reads/writes and return capability-specific errors for unsupported settings.
 */
export class IosSystemConfigurationAdapter implements SystemConfigurationAdapter {
  readonly defaultCalendarSystem = DEFAULT_CALENDAR_SYSTEM;

  constructor(
    private readonly device: BootedDevice,
    private readonly processExecutor: ProcessExecutor,
    private readonly lockdownLocaleClient: LockdownLocaleClient = new CommandLineLockdownLocaleClient(processExecutor)
  ) {}

  async setLocale(languageTag: string, _options: BroadcastOptions): Promise<SetLocaleResult> {
    if (!this.isSimulator()) {
      return this.setPhysicalLocale(languageTag);
    }

    try {
      const previousLanguageTag = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
      const appleLocale = this.toAppleLocale(languageTag);
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleLocale", appleLocale);

      const languages = this.buildAppleLanguages(languageTag);
      const arrayArgs = languages.map(l => `"${l}"`).join(" ");
      await this.processExecutor.exec(
        iosSpawnCommand(this.device.deviceId, `defaults write .GlobalPreferences AppleLanguages -array ${arrayArgs}`)
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
      return { success: false, zoneId, error: IOS_PHYSICAL_TIME_ZONE_ERROR };
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
      return { success: false, enabled, error: IOS_PHYSICAL_24_HOUR_ERROR };
    }

    try {
      const previousRaw = await this.iosDefaultsRead(".GlobalPreferences", "AppleICUForce24HourTime");
      const previousFormat = normalizeTimeFormat(parseAppleTimeFormatRaw(previousRaw));

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
      return { success: false, calendarSystem, error: IOS_PHYSICAL_CALENDAR_ERROR };
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
      return this.getPhysicalCalendarSystem();
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
      return this.getPhysicalLocalizationSettings();
    }

    const locale = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
    const languages = await this.iosDefaultsRead(".GlobalPreferences", "AppleLanguages");
    const timeZone = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");
    const timeFormatRaw = await this.iosDefaultsRead(".GlobalPreferences", "AppleICUForce24HourTime");
    const timeFormat = normalizeTimeFormat(parseAppleTimeFormatRaw(timeFormatRaw));
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
    return buildAppleLanguages(languageTag);
  }

  private isSimulator(): boolean {
    return isIosSimulator(this.device.deviceId);
  }

  private async iosDefaultsRead(domain: string, key: string): Promise<string | null> {
    try {
      const result = await this.processExecutor.exec(
        iosSpawnCommand(this.device.deviceId, `defaults read ${domain} ${key}`)
      );
      return normalizeSettingValue(result.stdout);
    } catch (error) {
      // `defaults read` fails when the domain/key has never been set on this
      // simulator; null correctly signals "no value configured" to the caller.
      logger.debug(`src/features/utility/system-configuration/IosSystemConfigurationAdapter.ts defaults read failed: ${error}`, error);
      return null;
    }
  }

  private async iosDefaultsWrite(domain: string, key: string, value: string): Promise<void> {
    await this.processExecutor.exec(
      iosSpawnCommand(this.device.deviceId, `defaults write ${domain} ${key} ${value}`)
    );
  }

  private async setPhysicalLocale(languageTag: string): Promise<SetLocaleResult> {
    try {
      const before = await this.lockdownLocaleClient.getLanguage(this.device.deviceId);
      const appleLocale = this.toAppleLocale(languageTag);
      const language = this.selectAppleLanguage(languageTag, before.supportedLanguages);

      await this.lockdownLocaleClient.setLanguage(this.device.deviceId, language, appleLocale);

      const after = await this.lockdownLocaleClient.getLanguage(this.device.deviceId);
      if (after.language !== language) {
        return {
          success: false,
          languageTag,
          previousLanguageTag: before.locale ?? undefined,
          error: `Read-back verification failed for Language: expected "${language}" but got "${after.language ?? "null"}"`
        };
      }
      if (after.locale !== appleLocale) {
        return {
          success: false,
          languageTag,
          previousLanguageTag: before.locale ?? undefined,
          error: `Read-back verification failed: expected "${appleLocale}" but got "${after.locale ?? "null"}"`
        };
      }

      return {
        success: true,
        languageTag,
        previousLanguageTag: before.locale ?? undefined,
        appliedLanguages: this.buildAppleLanguages(languageTag),
        method: "lockdown com.apple.international Language+Locale"
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        languageTag,
        error: `Failed to set locale on physical iOS device: ${errorMessage}`
      };
    }
  }

  private async getPhysicalCalendarSystem(): Promise<GetCalendarSystemResult> {
    try {
      const config = await this.lockdownLocaleClient.getLanguage(this.device.deviceId);
      if (config.locale) {
        const calendarFromLocale = extractCalendarFromLocale(config.locale);
        if (calendarFromLocale) {
          return {
            success: true,
            calendarSystem: calendarFromLocale,
            locale: config.locale,
            source: "locale"
          };
        }
      }

      return {
        success: true,
        calendarSystem: DEFAULT_CALENDAR_SYSTEM,
        locale: config.locale,
        source: "default"
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        calendarSystem: DEFAULT_CALENDAR_SYSTEM,
        source: "default",
        error: `Failed to read physical iOS calendar system: ${errorMessage}`
      };
    }
  }

  private async getPhysicalLocalizationSettings(): Promise<LocalizationSettingsResult> {
    try {
      const config = await this.lockdownLocaleClient.getLanguage(this.device.deviceId);
      const calendarSystem = config.locale ? extractCalendarFromLocale(config.locale) ?? DEFAULT_CALENDAR_SYSTEM : DEFAULT_CALENDAR_SYSTEM;

      return {
        success: true,
        locale: config.locale,
        languages: config.language,
        timeZone: null,
        textDirection: null,
        timeFormat: null,
        calendarSystem
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to read physical iOS localization settings: ${errorMessage}`
      };
    }
  }

  private toAppleLocale(languageTag: string): string {
    return languageTag.replace(/-/g, "_");
  }

  private selectAppleLanguage(languageTag: string, supportedLanguages?: string[]): string {
    const candidates = this.buildAppleLanguages(languageTag);
    if (!supportedLanguages || supportedLanguages.length === 0) {
      return candidates[0] ?? languageTag;
    }

    const supportedByNormalizedTag = new Map(
      supportedLanguages.map(language => [this.normalizeLanguageTag(language), language])
    );
    for (const candidate of candidates) {
      const supported = supportedByNormalizedTag.get(this.normalizeLanguageTag(candidate));
      if (supported) {
        return supported;
      }
    }
    return candidates[0] ?? languageTag;
  }

  private normalizeLanguageTag(languageTag: string): string {
    return languageTag.replace(/_/g, "-").toLowerCase();
  }
}
