import { errorMessage } from "../../../utils/describeUnknownError";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { logger } from "../../../utils/logger";
import { shellQuote } from "../../../utils/shellQuote";
import { AndroidCtrlProxyClient } from "../../observe/android/AndroidCtrlProxyClient";
import type { SettingsNamespace } from "../../observe/android";
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
  parseLocaleList,
} from "./parsing";

type TextDirectionSettingKey = "debug.force_rtl" | "force_rtl";
const MIN_APP_LOCALE_API_LEVEL = 33;

/**
 * Android implementation of {@link SystemConfigurationAdapter}. Uses
 * ADB shell commands (with an accessibility-service fast path for
 * `settings get`/`settings put`) and ADB shell commands to read and
 * write locale, time zone, RTL, 24-hour format, and calendar settings.
 * Android locale changes require an app id. Android 13+ uses the app-scoped
 * non-root LocaleManager shell command; older devices fall back to the
 * root-backed system locale path after verifying `adb root` works.
 */
export class AndroidSystemConfigurationAdapter implements SystemConfigurationAdapter {
  readonly defaultCalendarSystem = "gregory";

  constructor(
    private readonly device: BootedDevice,
    private readonly adb: AdbExecutor
  ) {}

  async setLocale(languageTag: string, options: BroadcastOptions): Promise<SetLocaleResult> {
    if (!options.appId) {
      return {
        success: false,
        languageTag,
        error: "appId is required for Android locale changes. Provide the target app package so AutoMobile can choose the supported Android locale path."
      };
    }

    return this.setTargetAppLocale(languageTag, options.appId, options);
  }

  private async setSystemLocale(languageTag: string, options: BroadcastOptions, method: string): Promise<SetLocaleResult> {
    const previousLanguageTag = await this.getCurrentLocaleTag();

    try {
      await this.runShellCommand(`shell setprop persist.sys.locale ${shellQuote(languageTag)}`);
      await this.runShellCommand("shell stop; start");
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        error: `Failed to set locale: ${errorMsg}`
      };
    }

    const effectiveLanguageTag = await this.getEffectiveLocaleTag();
    if (!this.localeTagsMatch(effectiveLanguageTag, languageTag)) {
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        error: `Read-back verification failed: expected "${languageTag}" but got "${effectiveLanguageTag ?? "null"}"`
      };
    }

    const broadcasted = options.broadcast === false
      ? false
      : await this.broadcastLocaleChange();

    return {
      success: true,
      languageTag,
      previousLanguageTag,
      method,
      broadcasted
    };
  }

  private async setTargetAppLocale(
    languageTag: string,
    appId: string,
    options: BroadcastOptions
  ): Promise<SetLocaleResult> {
    const apiLevel = await readAndroidDeviceApiLevel(this.adb);
    if (apiLevel !== null && apiLevel < MIN_APP_LOCALE_API_LEVEL) {
      const rootResult = await this.ensureRootForLegacyLocale(apiLevel);
      if (!rootResult.success) {
        return {
          success: false,
          languageTag,
          error: rootResult.error,
        };
      }
      return this.setSystemLocale(languageTag, options, "setprop persist.sys.locale + stop/start after adb root");
    }

    const targetUserId = await this.resolveTargetUserId(appId);
    const previousLanguageTag = await this.getAppLocaleTag(appId, targetUserId);

    try {
      await this.adb.executeCommand(
        `shell cmd locale set-app-locales ${shellQuote(appId)} --user ${targetUserId} --locales ${shellQuote(languageTag)}`
      );
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        error: `Failed to set app locale for ${appId}: ${errorMsg}`
      };
    }

    const effectiveLanguageTag = await this.getAppLocaleTag(appId, targetUserId);
    if (!this.localeTagsMatch(effectiveLanguageTag, languageTag)) {
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        error: `Read-back verification failed for ${appId}: expected "${languageTag}" but got "${effectiveLanguageTag ?? "null"}"`
      };
    }

    const broadcasted = options.broadcast === false
      ? false
      : await this.broadcastLocaleChange();

    return {
      success: true,
      languageTag,
      previousLanguageTag,
      method: `cmd locale set-app-locales ${appId} --user ${targetUserId}`,
      broadcasted
    };
  }

  private async resolveTargetUserId(appId: string): Promise<number> {
    try {
      const foregroundApp = await this.adb.getForegroundApp();
      if (foregroundApp?.packageName === appId) {
        return foregroundApp.userId;
      }
    } catch (error) {
      logger.debug(`[SystemConfigurationManager] Failed to resolve foreground Android app user for ${appId}: ${error}`);
    }

    try {
      const workProfile = (await this.adb.listUsers()).find(user => user.userId > 0 && user.running);
      return workProfile?.userId ?? 0;
    } catch (error) {
      logger.debug(`[SystemConfigurationManager] Failed to list Android users for ${appId}: ${error}`);
      return 0;
    }
  }

  private async ensureRootForLegacyLocale(apiLevel: number): Promise<{ success: true } | { success: false; error: string }> {
    try {
      await this.adb.executeCommand("root", undefined, undefined, true);
      await this.adb.executeCommand("wait-for-device", undefined, undefined, true);
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        error: `Android API ${apiLevel} does not support app-scoped locale changes, so AutoMobile must use the root-backed system locale path. Failed to run adb root; the target emulator is not root-capable or does not allow root ADB. adb root error: ${errorMsg}`
      };
    }

    try {
      const idResult = await this.adb.executeCommand("shell id", undefined, undefined, true);
      if (!idResult.stdout.includes("uid=0(root)")) {
        return {
          success: false,
          error: `Android API ${apiLevel} does not support app-scoped locale changes, so AutoMobile must use the root-backed system locale path. adb root completed, but ADB shell is still not root; the target emulator is not root-capable. shell id: ${idResult.stdout.trim() || "unknown"}`
        };
      }
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        error: `Android API ${apiLevel} does not support app-scoped locale changes, so AutoMobile must verify root before changing the system locale. Failed to verify root shell after adb root: ${errorMsg}`
      };
    }

    return { success: true };
  }

  async setTimeZone(zoneId: string): Promise<SetTimeZoneResult> {
    const previousZoneId = await this.readSetting("shell getprop persist.sys.timezone");

    try {
      await this.adb.executeCommand(`shell setprop persist.sys.timezone ${shellQuote(zoneId)}`);
      const effectiveZoneId = await this.readSetting("shell getprop persist.sys.timezone");
      if (effectiveZoneId !== zoneId) {
        return {
          success: false,
          zoneId,
          previousZoneId,
          error: `Read-back verification failed: expected "${zoneId}" but got "${effectiveZoneId ?? "null"}"`
        };
      }
      return {
        success: true,
        zoneId,
        previousZoneId,
        method: "setprop persist.sys.timezone"
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        zoneId,
        previousZoneId,
        error: `Failed to set time zone: ${errorMsg}`
      };
    }
  }

  async setTextDirection(rtl: boolean, options: BroadcastOptions): Promise<SetTextDirectionResult> {
    const debugForceRtl = await this.readSetting("shell settings get global debug.force_rtl");
    const forceRtl = await this.readSetting("shell settings get global force_rtl");
    const previousRtl = parseBooleanSetting(debugForceRtl ?? forceRtl);

    const targetKeys: TextDirectionSettingKey[] = [];
    const shouldSetDebug = debugForceRtl !== null || forceRtl === null;
    const shouldSetForce = forceRtl !== null;

    if (shouldSetDebug) {
      targetKeys.push("debug.force_rtl");
    }
    if (shouldSetForce) {
      targetKeys.push("force_rtl");
    }
    if (targetKeys.length === 0) {
      targetKeys.push("debug.force_rtl");
    }

    const appliedSettings: TextDirectionSettingKey[] = [];
    const value = rtl ? 1 : 0;

    for (const key of targetKeys) {
      try {
        await this.runShellCommand(`shell settings put global ${key} ${value}`);
        appliedSettings.push(key);
      } catch (error) {
        logger.warn(`[SystemConfigurationManager] Failed to set ${key}: ${error}`);
      }
    }

    if (appliedSettings.length === 0) {
      return {
        success: false,
        rtl,
        previousRtl,
        error: "Failed to update RTL settings"
      };
    }

    const broadcasted = options.broadcast === false
      ? false
      : await this.broadcastLocaleChange();

    return {
      success: true,
      rtl,
      previousRtl,
      settings: appliedSettings,
      broadcasted
    };
  }

  async set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult> {
    const previousFormat = await this.readSetting("shell settings get system time_12_24");
    const value = enabled ? "24" : "12";

    try {
      await this.runShellCommand(`shell settings put system time_12_24 ${value}`);
      return {
        success: true,
        enabled,
        previousFormat: normalizeTimeFormat(previousFormat)
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      return {
        success: false,
        enabled,
        previousFormat: normalizeTimeFormat(previousFormat),
        error: `Failed to set 24-hour format: ${errorMsg}`
      };
    }
  }

  async setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult> {
    const previous = await this.getCalendarSystem();
    const previousCalendarSystem = previous.calendarSystem ?? null;

    try {
      await this.runShellCommand(`shell settings put system calendar_type ${calendarSystem}`);
      const readBack = await this.readSetting("shell settings get system calendar_type");
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
      const errorMsg = errorMessage(error);
      return {
        success: false,
        calendarSystem,
        previousCalendarSystem,
        error: `Failed to set calendar system: ${errorMsg}`
      };
    }
  }

  async getCalendarSystem(): Promise<GetCalendarSystemResult> {
    const calendarType = await this.readSetting("shell settings get system calendar_type");
    if (calendarType) {
      return {
        success: true,
        calendarSystem: calendarType,
        source: "settings.calendar_type"
      };
    }

    const locale = await this.getCurrentLocaleTag();
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
      calendarSystem: this.defaultCalendarSystem,
      locale: locale ?? null,
      source: "default"
    };
  }

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    const locale = await this.getCurrentLocaleTag();
    const timeZone = await this.readSetting("shell getprop persist.sys.timezone");
    const timeFormat = normalizeTimeFormat(
      await this.readSetting("shell settings get system time_12_24")
    );
    const debugForceRtl = await this.readSetting("shell settings get global debug.force_rtl");
    const forceRtl = await this.readSetting("shell settings get global force_rtl");
    const rtlSetting = parseBooleanSetting(debugForceRtl) ?? parseBooleanSetting(forceRtl);
    const textDirection = rtlSetting === null ? null : (rtlSetting ? "rtl" : "ltr");
    const calendarResult = await this.getCalendarSystem();

    return {
      success: calendarResult.success,
      locale,
      timeZone,
      textDirection,
      timeFormat,
      calendarSystem: calendarResult.calendarSystem ?? null,
      error: calendarResult.error
    };
  }

  async broadcastLocaleChange(): Promise<boolean> {
    try {
      await this.adb.executeCommand("shell am broadcast -a android.intent.action.LOCALE_CHANGED");
      return true;
    } catch (error) {
      logger.warn(`[SystemConfigurationManager] Failed to broadcast localization change: ${error}`);
      return false;
    }
  }

  // Tries the accessibility-service fast path for `settings get …`
  // first, then falls back to ADB. Any other shell command is passed
  // straight through to `adb.executeCommand`.
  private async readSetting(command: string): Promise<string | null> {
    const match = command.match(/^shell\s+settings\s+get\s+(system|secure|global)\s+(\S+)\s*$/);
    if (match) {
      const namespace = match[1] as SettingsNamespace;
      const key = match[2];
      try {
        const a11y = AndroidCtrlProxyClient.getInstance(this.device);
        const a11yResult = await a11y.requestSettingsGet(namespace, key);
        if (a11yResult.success) {
          return normalizeSettingValue(a11yResult.found ? (a11yResult.value ?? null) : null);
        }
      } catch (error) {
        logger.debug(`[SystemConfigurationManager] a11y settings get failed for ${namespace}/${key}: ${error}`);
      }
    }
    try {
      const result = await this.adb.executeCommand(command, undefined, undefined, true);
      return normalizeSettingValue(result.stdout);
    } catch (error) {
      logger.warn(`[SystemConfigurationManager] Failed to read setting (${command}): ${error}`);
      return null;
    }
  }

  // Intercepts `shell settings put <ns> <key> <value>` and routes
  // through the accessibility service first, falling back to ADB. Any
  // other shell command is passed through to `adb.executeCommand`.
  private async runShellCommand(command: string): Promise<void> {
    const putMatch = command.match(/^shell\s+settings\s+put\s+(system|secure|global)\s+(\S+)\s+(.+)$/);
    if (putMatch) {
      const namespace = putMatch[1] as SettingsNamespace;
      const key = putMatch[2];
      const value = putMatch[3].trim();
      try {
        const a11y = AndroidCtrlProxyClient.getInstance(this.device);
        const a11yResult = await a11y.requestSettingsPut(namespace, key, value, "string");
        if (a11yResult.success) {
          return;
        }
      } catch (error) {
        logger.debug(`[SystemConfigurationManager] a11y settings put failed for ${namespace}/${key}: ${error}`);
      }
    }
    await this.adb.executeCommand(command);
  }

  private async getCurrentLocaleTag(): Promise<string | null> {
    const systemLocales = await this.readSetting("shell settings get system system_locales");
    const parsedSystemLocale = parseLocaleList(systemLocales);
    if (parsedSystemLocale) {
      return parsedSystemLocale;
    }

    const effectiveLocale = await this.getEffectiveLocaleTag();
    if (effectiveLocale) {
      return effectiveLocale;
    }

    const persistedLocale = await this.readSetting("shell getprop persist.sys.locale");
    if (persistedLocale) {
      return persistedLocale;
    }

    const language = await this.readSetting("shell getprop persist.sys.language");
    if (!language) {
      return null;
    }

    const country = await this.readSetting("shell getprop persist.sys.country");
    if (country) {
      return `${language}-${country}`;
    }

    return language;
  }

  private async getAppLocaleTag(appId: string, userId: number): Promise<string | null> {
    try {
      const result = await this.adb.executeCommand(
        `shell cmd locale get-app-locales ${shellQuote(appId)} --user ${userId}`,
        undefined,
        undefined,
        true
      );
      return this.parseAppLocalesOutput(result.stdout);
    } catch (error) {
      logger.warn(`[SystemConfigurationManager] Failed to read Android app locale for ${appId}: ${error}`);
      return null;
    }
  }

  private parseAppLocalesOutput(output: string): string | null {
    const normalized = normalizeSettingValue(output);
    if (!normalized) {
      return null;
    }
    const bracketedLocales = normalized.match(/\bare\s+\[([^\]]*)\]\s*$/)?.[1];
    if (bracketedLocales === undefined) {
      return null;
    }
    return parseLocaleList(bracketedLocales);
  }

  private async getEffectiveLocaleTag(): Promise<string | null> {
    try {
      const result = await this.adb.executeCommand("shell am get-config", undefined, undefined, true);
      return this.parseLocaleFromAmConfig(result.stdout);
    } catch (error) {
      logger.warn(`[SystemConfigurationManager] Failed to read effective Android locale: ${error}`);
      return null;
    }
  }

  private parseLocaleFromAmConfig(output: string): string | null {
    const normalized = normalizeSettingValue(output);
    if (!normalized) {
      return null;
    }

    const bcp47Match = normalized.match(/(?:^|[-\s])b\+([a-z]{2,3})(?:\+([A-Za-z]{4}))?(?:\+([A-Z]{2}|\d{3}))?(?=[-\s]|$)/);
    if (bcp47Match?.[1]) {
      return [bcp47Match[1], bcp47Match[2], bcp47Match[3]].filter(Boolean).join("-");
    }

    const languageRegionMatch = normalized.match(/(?:^|[-\s])([a-z]{2,3})-r([A-Z]{2})(?=[-\s]|$)/);
    if (languageRegionMatch?.[1] && languageRegionMatch[2]) {
      return `${languageRegionMatch[1]}-${languageRegionMatch[2]}`;
    }

    const languageOnlyMatch = normalized.match(/(?:^|[-\s])([a-z]{2,3})(?=[-\s]|$)/);
    return languageOnlyMatch?.[1] ?? null;
  }

  private localeTagsMatch(actual: string | null, expected: string): boolean {
    if (!actual) {
      return false;
    }
    return actual.replace(/_/g, "-").toLowerCase() === expected.replace(/_/g, "-").toLowerCase();
  }
}
