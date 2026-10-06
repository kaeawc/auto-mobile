import { errorMessage } from "../../../utils/describeUnknownError";
import type { HostCommandExecutor } from "../../../utils/HostCommandExecutor";
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
  parseBooleanSetting,
  timeZoneIdsEquivalent,
} from "./parsing";
import { buildAppleLanguages, isIosSimulator, parseAppleTimeFormatRaw } from "./iosHelpers";

const IOS_PHYSICAL_CONFIGURATION_ERROR =
  "System configuration is not supported on physical iOS devices.";
const DEFAULT_CALENDAR_SYSTEM = "gregory";
const AUTO_TIME_ZONE_DOMAIN = "com.apple.mobiletimerd";
const AUTO_TIME_ZONE_KEY = "AutomaticTimeZoneSetting";
const IOS_TIME_ZONE_STORED_WARNING =
  "AppleTimeZone was stored and read back, which does not confirm that running apps observe the new zone. Automatic time zone is now off so the zone stays pinned.";

/**
 * iOS implementation of {@link SystemConfigurationAdapter}. Simulators use
 * `xcrun simctl spawn … defaults`. Physical-device system configuration is
 * intentionally unsupported until AutoMobile owns the required implementation.
 */
export class IosSystemConfigurationAdapter implements SystemConfigurationAdapter {
  readonly defaultCalendarSystem = DEFAULT_CALENDAR_SYSTEM;

  constructor(
    private readonly device: BootedDevice,
    private readonly processExecutor: HostCommandExecutor,
  ) {}

  async setLocale(languageTag: string, _options: BroadcastOptions): Promise<SetLocaleResult> {
    if (!this.isSimulator()) {
      return { success: false, languageTag, error: IOS_PHYSICAL_CONFIGURATION_ERROR };
    }

    try {
      const previousLanguageTag = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
      const appleLocale = this.toAppleLocale(languageTag);
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleLocale", [appleLocale]);

      const languages = this.buildAppleLanguages(languageTag);
      await this.processExecutor.executeCommand("xcrun", [
        "simctl",
        "spawn",
        this.device.deviceId,
        "defaults",
        "write",
        ".GlobalPreferences",
        "AppleLanguages",
        "-array",
        ...languages,
      ]);

      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
      if (!readBack || readBack !== appleLocale) {
        return {
          success: false,
          languageTag,
          previousLanguageTag,
          error: `Read-back verification failed: expected "${appleLocale}" but got "${readBack ?? "null"}"`,
        };
      }

      return {
        success: true,
        languageTag,
        previousLanguageTag,
        appliedLanguages: languages,
        method: "defaults write AppleLocale + AppleLanguages",
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`Failed to set locale: ${errorMessage(error)}`, error);
      return {
        success: false,
        languageTag,
        error: `Failed to set locale: ${errorMsg}`,
      };
    }
  }

  async setTimeZone(zoneId: string): Promise<SetTimeZoneResult> {
    if (!this.isSimulator()) {
      return { success: false, zoneId, error: IOS_PHYSICAL_CONFIGURATION_ERROR };
    }

    const previous = {
      zoneId: await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone"),
      automatic: await this.iosDefaultsRead(AUTO_TIME_ZONE_DOMAIN, AUTO_TIME_ZONE_KEY),
    };

    try {
      // Automatic time zone is switched off on purpose: it would otherwise
      // overwrite the manual zone, so a successful change leaves it off. It is
      // the one setting changed besides the zone, so every failure after this
      // write puts it back (issue #10190).
      await this.iosDefaultsWrite(AUTO_TIME_ZONE_DOMAIN, AUTO_TIME_ZONE_KEY, ["-bool", "NO"]);
    } catch (error) {
      return this.timeZoneWriteFailure(zoneId, error, "");
    }

    let readBack: string | null;
    try {
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleTimeZone", [zoneId]);
      readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");
    } catch (error) {
      const restoreNote = await this.restoreTimeZoneSettings(previous, null);
      return this.timeZoneWriteFailure(zoneId, error, restoreNote);
    }

    // `defaults read` is the only read of the zone the adapter has on the
    // simulator, so this confirms the value was stored, not that running apps
    // observe it.
    if (readBack === null) {
      // An unreadable read-back proves nothing about the simulator, so nothing is
      // restored on a guess (same contract as the Android path).
      return {
        success: false,
        zoneId,
        previousZoneId: previous.zoneId,
        error: `Time zone change outcome is indeterminate: "${zoneId}" was sent but no result was confirmed (AppleTimeZone could not be read back). The simulator's time zone and its automatic time zone setting were not restored: automatic time zone is off and the zone may have changed${previous.zoneId === null ? "" : ` (previously "${previous.zoneId}")`}. Do not retry automatically. Check the current time zone before retrying.`,
      };
    }
    if (!timeZoneIdsEquivalent(readBack, zoneId)) {
      const restoreNote = await this.restoreTimeZoneSettings(previous, readBack);
      return {
        success: false,
        zoneId,
        previousZoneId: previous.zoneId,
        error: `Read-back verification failed: expected "${zoneId}" but got "${readBack}"${restoreNote}`,
      };
    }

    return {
      success: true,
      zoneId,
      previousZoneId: previous.zoneId,
      warning: IOS_TIME_ZONE_STORED_WARNING,
    };
  }

  private timeZoneWriteFailure(zoneId: string, error: unknown, restoreNote: string) {
    const errorMsg = errorMessage(error);
    logger.warn(`Failed to set time zone: ${errorMsg}`, error);
    return {
      success: false,
      zoneId,
      error: `Failed to set time zone: ${errorMsg}${restoreNote}`,
    };
  }

  /**
   * Put the simulator's time zone and its automatic-time-zone switch back after
   * a change that did not take. Returns a sentence (with a leading ". ") for the
   * caller's error naming what was restored or what is left behind.
   */
  private async restoreTimeZoneSettings(
    previous: { zoneId: string | null; automatic: string | null },
    current: string | null,
  ): Promise<string> {
    const failures: string[] = [];
    const zoneUnchanged =
      previous.zoneId === null ? current === null : timeZoneIdsEquivalent(current, previous.zoneId);
    if (!zoneUnchanged) {
      await this.restoreDefault(
        ".GlobalPreferences",
        "AppleTimeZone",
        previous.zoneId === null ? null : [previous.zoneId],
        failures,
      );
    }

    const automatic = parseBooleanSetting(previous.automatic);
    if (previous.automatic !== null && automatic === null) {
      failures.push(
        `the earlier automatic time zone value "${previous.automatic}" is not a boolean`,
      );
    } else {
      await this.restoreDefault(
        AUTO_TIME_ZONE_DOMAIN,
        AUTO_TIME_ZONE_KEY,
        automatic === null ? null : ["-bool", automatic ? "YES" : "NO"],
        failures,
      );
    }

    failures.push(...(await this.timeZoneRestoreMismatches(previous)));

    const zoneLabel = previous.zoneId === null ? "unset" : `"${previous.zoneId}"`;
    const automaticLabel = previous.automatic === null ? "unset" : `"${previous.automatic}"`;
    return failures.length === 0
      ? `. Restored automatic time zone (${automaticLabel}) and the previous time zone (${zoneLabel}).`
      : `. Restoring the previous automatic time zone (${automaticLabel}) and time zone (${zoneLabel}) failed: ${failures.join("; ")}.`;
  }

  /** Read both settings back and name each one that is not what it was before. */
  private async timeZoneRestoreMismatches(previous: {
    zoneId: string | null;
    automatic: string | null;
  }): Promise<string[]> {
    const zone = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");
    const automatic = await this.iosDefaultsRead(AUTO_TIME_ZONE_DOMAIN, AUTO_TIME_ZONE_KEY);
    const mismatches: string[] = [];
    const zoneRestored =
      previous.zoneId === null ? zone === null : timeZoneIdsEquivalent(zone, previous.zoneId);
    if (!zoneRestored) {
      mismatches.push(`AppleTimeZone is left as "${zone ?? "null"}"`);
    }
    if (parseBooleanSetting(automatic) !== parseBooleanSetting(previous.automatic)) {
      mismatches.push(`${AUTO_TIME_ZONE_KEY} is left as "${automatic ?? "null"}"`);
    }
    return mismatches;
  }

  /** Write `valueArgs`, or delete the key when there was no earlier value. */
  private async restoreDefault(
    domain: string,
    key: string,
    valueArgs: string[] | null,
    failures: string[],
  ): Promise<void> {
    try {
      if (valueArgs === null) {
        await this.processExecutor.executeCommand("xcrun", [
          "simctl",
          "spawn",
          this.device.deviceId,
          "defaults",
          "delete",
          domain,
          key,
        ]);
      } else {
        await this.iosDefaultsWrite(domain, key, valueArgs);
      }
    } catch (error) {
      logger.warn(`Failed to restore ${domain} ${key}: ${errorMessage(error)}`, error);
      failures.push(`${key}: ${errorMessage(error)}`);
    }
  }

  async setTextDirection(
    rtl: boolean,
    _options: BroadcastOptions,
  ): Promise<SetTextDirectionResult> {
    return {
      success: false,
      rtl,
      error:
        "Text direction is not supported on iOS. RTL is driven by the app's language; set an RTL locale (e.g., ar_SA) instead.",
    };
  }

  async set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult> {
    if (!this.isSimulator()) {
      return { success: false, enabled, error: IOS_PHYSICAL_CONFIGURATION_ERROR };
    }

    try {
      const previousRaw = await this.iosDefaultsRead(
        ".GlobalPreferences",
        "AppleICUForce24HourTime",
      );
      const previousFormat = normalizeTimeFormat(parseAppleTimeFormatRaw(previousRaw));

      await this.iosDefaultsWrite(".GlobalPreferences", "AppleICUForce24HourTime", [
        "-bool",
        enabled ? "YES" : "NO",
      ]);

      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleICUForce24HourTime");
      const expectedReadBack = enabled ? "1" : "0";
      if (!readBack || readBack !== expectedReadBack) {
        return {
          success: false,
          enabled,
          previousFormat,
          error: `Read-back verification failed: expected "${expectedReadBack}" but got "${readBack ?? "null"}"`,
        };
      }

      return {
        success: true,
        enabled,
        previousFormat,
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`Failed to set 24-hour format: ${errorMessage(error)}`, error);
      return {
        success: false,
        enabled,
        error: `Failed to set 24-hour format: ${errorMsg}`,
      };
    }
  }

  async setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult> {
    if (!this.isSimulator()) {
      return { success: false, calendarSystem, error: IOS_PHYSICAL_CONFIGURATION_ERROR };
    }

    try {
      const previousCalendarSystem = await this.iosDefaultsRead(
        ".GlobalPreferences",
        "AppleCalendar",
      );
      await this.iosDefaultsWrite(".GlobalPreferences", "AppleCalendar", [calendarSystem]);
      const readBack = await this.iosDefaultsRead(".GlobalPreferences", "AppleCalendar");
      if (!readBack || readBack !== calendarSystem) {
        return {
          success: false,
          calendarSystem: readBack ?? calendarSystem,
          previousCalendarSystem,
          error: `Read-back verification failed: expected "${calendarSystem}" but got "${readBack ?? "null"}"`,
        };
      }
      return {
        success: true,
        calendarSystem: readBack,
        previousCalendarSystem,
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`Failed to set calendar system: ${errorMessage(error)}`, error);
      return {
        success: false,
        calendarSystem,
        error: `Failed to set calendar system: ${errorMsg}`,
      };
    }
  }

  async getCalendarSystem(): Promise<GetCalendarSystemResult> {
    if (!this.isSimulator()) {
      return { success: false, error: IOS_PHYSICAL_CONFIGURATION_ERROR };
    }

    const calendar = await this.iosDefaultsRead(".GlobalPreferences", "AppleCalendar");
    if (calendar) {
      return {
        success: true,
        calendarSystem: calendar,
        source: "default",
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
          source: "locale",
        };
      }
    }

    return {
      success: true,
      calendarSystem: DEFAULT_CALENDAR_SYSTEM,
      locale: locale ?? null,
      source: "default",
    };
  }

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    if (!this.isSimulator()) {
      return { success: false, error: IOS_PHYSICAL_CONFIGURATION_ERROR };
    }

    const locale = await this.iosDefaultsRead(".GlobalPreferences", "AppleLocale");
    const languages = await this.iosDefaultsRead(".GlobalPreferences", "AppleLanguages");
    const timeZone = await this.iosDefaultsRead(".GlobalPreferences", "AppleTimeZone");
    const timeFormatRaw = await this.iosDefaultsRead(
      ".GlobalPreferences",
      "AppleICUForce24HourTime",
    );
    const timeFormat = normalizeTimeFormat(parseAppleTimeFormatRaw(timeFormatRaw));
    const calendarResult = await this.getCalendarSystem();

    return {
      success: true,
      locale,
      languages,
      timeZone,
      textDirection: null,
      timeFormat,
      calendarSystem: calendarResult.calendarSystem ?? null,
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
      const result = await this.processExecutor.executeCommand("xcrun", [
        "simctl",
        "spawn",
        this.device.deviceId,
        "defaults",
        "read",
        domain,
        key,
      ]);
      return normalizeSettingValue(result.stdout);
    } catch (error) {
      // `defaults read` fails when the domain/key has never been set on this
      // simulator; null correctly signals "no value configured" to the caller.
      logger.debug(
        `src/features/utility/system-configuration/IosSystemConfigurationAdapter.ts defaults read failed: ${error}`,
        error,
      );
      return null;
    }
  }

  private async iosDefaultsWrite(domain: string, key: string, valueArgs: string[]): Promise<void> {
    await this.processExecutor.executeCommand("xcrun", [
      "simctl",
      "spawn",
      this.device.deviceId,
      "defaults",
      "write",
      domain,
      key,
      ...valueArgs,
    ]);
  }

  private toAppleLocale(languageTag: string): string {
    return languageTag.replace(/-/g, "_");
  }
}
