import { ensureAndroidRoot } from "../../../utils/android-cmdline-tools/ensureAndroidRoot";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  AndroidUserTargetResolver,
  AndroidUserTargetUnavailableError,
} from "../../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { readAndroidDeviceApiLevel } from "../../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { logger } from "../../../utils/logger";
import { shellQuote } from "../../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
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
  localeTagsEquivalent,
  normalizeSettingValue,
  normalizeTimeFormat,
  parseBooleanSetting,
  parseAppLocalesReply,
  parseLocaleList,
  timeZoneIdsEquivalent,
  validateLocaleTag,
} from "./parsing";

type TextDirectionSettingKey = "debug.force_rtl" | "force_rtl";

/**
 * Result of reading an app's locales with `cmd locale get-app-locales`.
 * `list` is the raw comma-separated list inside the brackets ("" when the app
 * has no override), kept whole so a restore can put back every locale and not
 * just the first one.
 */
type AppLocaleRead =
  | { readable: true; list: string }
  | {
      readable: false;
      /** Android answered `Unknown package ...`: the app is not installed for that user. */
      notInstalled: boolean;
    };

/** The first locale of an app-locale read, or null when unset or unreadable. */
function firstAppLocale(read: AppLocaleRead): string | null {
  return read.readable ? parseLocaleList(read.list) : null;
}

function normalizeLocaleList(list: string): string[] {
  return list
    .split(",")
    .map((tag) => tag.trim().replace(/_/g, "-").toLowerCase())
    .filter(Boolean);
}

function sameLocaleList(a: string, b: string): boolean {
  return normalizeLocaleList(a).join(",") === normalizeLocaleList(b).join(",");
}

function isNotInstalled(read: AppLocaleRead): boolean {
  return !read.readable && read.notInstalled;
}

/**
 * Error for an app-scoped locale change against a package Android reports as not
 * installed for the target user. Unlike an unreadable read-back this is
 * definite: the device refused the package by name, so nothing was changed and
 * there is nothing to restore or to check.
 */
function notInstalledLocaleError(appId: string, userId: number): string {
  return `Cannot change the locale: app ${appId} is not installed for user ${userId}; nothing was changed. Check the appId, or install the app first.`;
}

function describeAppLocales(read: AppLocaleRead): string {
  if (!read.readable) {
    return "unknown (it could not be read)";
  }
  return read.list ? `"${read.list}"` : "unset";
}

/**
 * Error for a locale change that was sent but whose result could not be read
 * back. Nothing is restored: the device may or may not hold the new locale, and
 * writing again on a guess is how a second framework restart or a clobbered
 * locale happens.
 */
function indeterminateLocaleError(languageTag: string, reason: string, subject: string): string {
  return `Locale change outcome is indeterminate: "${languageTag}" was sent but no result was confirmed (${reason}). ${subject} was not restored and may have changed. Do not retry automatically. Check the current locale before retrying.`;
}

const TIME_ZONE_READ = "shell getprop persist.sys.timezone";
const ANDROID_TIME_ZONE_STORED_WARNING =
  "persist.sys.timezone was stored and read back, which does not confirm the zone is in effect: a raw setprop bypasses the system time-zone setter, so already-running apps may keep the previous zone until restarted.";

const MIN_APP_LOCALE_API_LEVEL = 33;

// Bounds for waiting on the framework to come back after the legacy (<33)
// `stop; start` restart. We poll `sys.boot_completed` rather than racing the
// read-back against an in-progress restart (issue #6346). Values are generous
// enough for a real cold framework restart but injected via the Timer seam so
// unit tests drive them deterministically without real sleeps.
const FRAMEWORK_RESTART_READY_TIMEOUT_MS = 60_000;
const FRAMEWORK_RESTART_POLL_INTERVAL_MS = 2_000;

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
    private readonly adb: AdbExecutor,
    private readonly timer: Timer = defaultTimer,
  ) {}

  async setLocale(languageTag: string, options: BroadcastOptions): Promise<SetLocaleResult> {
    if (!options.appId) {
      return {
        success: false,
        languageTag,
        error:
          "appId is required for Android locale changes. Provide the target app package so AutoMobile can choose the supported Android locale path.",
      };
    }

    // Reject a tag Android cannot resolve to a real locale before sending anything:
    // the device would otherwise keep the `und`/truncated value it makes of it.
    const invalidTagError = validateLocaleTag(languageTag);
    if (invalidTagError) {
      return { success: false, languageTag, error: invalidTagError };
    }

    return this.setTargetAppLocale(languageTag, options.appId, options);
  }

  private async setSystemLocale(
    languageTag: string,
    options: BroadcastOptions,
    method: string,
  ): Promise<SetLocaleResult> {
    // The legacy path can only change the whole device, so the previous value we
    // record for restore is the persisted system prop we are about to overwrite —
    // not `getCurrentLocaleTag()`, which can resolve to a per-app override.
    const previousLanguageTag = await this.readSetting("shell getprop persist.sys.locale");

    try {
      await this.runShellCommand(`shell setprop persist.sys.locale ${shellQuote(languageTag)}`);
      await this.runShellCommand("shell stop; start");
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to set device-wide locale: ${errorMessage(error)}`,
        error,
      );
      const errorMsg = errorMessage(error);
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        localeScope: "system",
        error: `Failed to set device-wide locale: ${errorMsg}`,
      };
    }

    // Wait (bounded, via the injected Timer) for the framework to finish
    // restarting before reading anything back. Racing the read-back against an
    // in-progress `stop; start` is what made this path report success:false for a
    // change it had actually applied, and wedged concurrent tools (issue #6346).
    const frameworkReady = await this.waitForFrameworkReady();

    // Read back the exact prop we wrote. `persist.sys.locale` is a plain system
    // property, readable even while the framework is still coming up, so this
    // never races the restart the way the old `am get-config` read-back did.
    const persistedLanguageTag = await this.readSetting("shell getprop persist.sys.locale");
    if (persistedLanguageTag === null) {
      // An unreadable read-back proves nothing about the device. Restoring on it
      // would issue a second `stop; start` against a framework that may still be
      // coming up, so leave the device alone and say the outcome is unknown.
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        localeScope: "system",
        error: indeterminateLocaleError(
          languageTag,
          `persist.sys.locale could not be read back${frameworkReady ? "" : ` and the framework did not report boot_completed within ${FRAMEWORK_RESTART_READY_TIMEOUT_MS}ms after stop; start`}`,
          "the device-wide locale",
        ),
      };
    }
    if (!localeTagsEquivalent(persistedLanguageTag, languageTag)) {
      // The call is failing, so do not leave the device on a locale the caller
      // was told did not apply (issue #10155).
      const restoreNote = await this.restoreSystemLocale(previousLanguageTag, persistedLanguageTag);
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        localeScope: "system",
        error: `Read-back verification failed: expected persist.sys.locale "${languageTag}" but got "${persistedLanguageTag ?? "null"}"${restoreNote}`,
      };
    }

    if (!frameworkReady) {
      logger.warn(
        `[SystemConfigurationManager] Device-wide locale ${languageTag} was applied and persisted, ` +
          `but the framework did not report boot_completed within ${FRAMEWORK_RESTART_READY_TIMEOUT_MS}ms after stop; start. ` +
          "Subsequent tools may briefly see the device as not fully booted.",
      );
    }

    const broadcasted = options.broadcast === false ? false : await this.broadcastLocaleChange();

    return {
      success: true,
      languageTag,
      previousLanguageTag,
      method,
      localeScope: "system",
      broadcasted,
    };
  }

  /**
   * Put `persist.sys.locale` back after a device-wide change that did not read
   * back as asked. Returns a sentence (with a leading ". ") to append to the
   * caller's error, or "" when the device still holds the earlier value so
   * nothing needed restoring. When the restore does not take, the sentence names
   * the value the device is left with.
   */
  private async restoreSystemLocale(
    previous: string | null,
    persisted: string | null,
  ): Promise<string> {
    const sameAsPrevious = (value: string | null): boolean =>
      previous === null ? value === null : localeTagsEquivalent(value, previous);
    if (sameAsPrevious(persisted)) {
      return "";
    }

    const previousLabel = previous === null ? "unset" : `"${previous}"`;
    let restoreFailure = "";
    try {
      // An empty value clears the prop, which is how an unset locale is restored.
      await this.runShellCommand(`shell setprop persist.sys.locale ${shellQuote(previous ?? "")}`);
      await this.runShellCommand("shell stop; start");
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to restore device-wide locale: ${errorMessage(error)}`,
        error,
      );
      restoreFailure = ` (${errorMessage(error)})`;
    }

    await this.waitForFrameworkReady();
    const afterRestore = await this.readSetting("shell getprop persist.sys.locale");
    if (sameAsPrevious(afterRestore)) {
      return `. Restored the previous device-wide locale (${previousLabel}).`;
    }
    return `. Restoring the previous device-wide locale (${previousLabel}) failed${restoreFailure}; persist.sys.locale is left as "${afterRestore ?? "null"}".`;
  }

  /**
   * Poll `sys.boot_completed` until the framework reports it is back up after a
   * `stop; start`, or the bounded timeout elapses. Uses the injected {@link Timer}
   * so tests drive the restart timing deterministically instead of sleeping.
   * Returns `true` if the framework became ready, `false` on timeout.
   */
  private async waitForFrameworkReady(): Promise<boolean> {
    const deadline = this.timer.now() + FRAMEWORK_RESTART_READY_TIMEOUT_MS;
    for (;;) {
      let bootCompleted: string | null = null;
      try {
        const result = await this.adb.executeCommand(
          "shell getprop sys.boot_completed",
          undefined,
          undefined,
          true,
        );
        bootCompleted = normalizeSettingValue(result.stdout);
      } catch (error) {
        // Expected while the framework is mid-restart: the shell may briefly
        // reject commands. Swallow and keep polling until the deadline.
        logger.debug(`[SystemConfigurationManager] boot_completed probe failed: ${error}`);
      }
      if (bootCompleted === "1") {
        return true;
      }
      if (this.timer.now() >= deadline) {
        return false;
      }
      await this.timer.sleep(FRAMEWORK_RESTART_POLL_INTERVAL_MS);
    }
  }

  /** Below Android 13 there is no app-scoped command: use the root-backed device-wide path. */
  private async setLegacyAppLocale(
    languageTag: string,
    options: BroadcastOptions,
    apiLevel: number,
  ): Promise<SetLocaleResult> {
    const rootResult = await this.ensureRootForLegacyLocale(apiLevel);
    if (!rootResult.success) {
      return { success: false, languageTag, error: rootResult.error };
    }
    return this.setSystemLocale(
      languageTag,
      options,
      "setprop persist.sys.locale + stop/start after adb root",
    );
  }

  private async setTargetAppLocale(
    languageTag: string,
    appId: string,
    options: BroadcastOptions,
  ): Promise<SetLocaleResult> {
    const apiLevel = await readAndroidDeviceApiLevel(this.adb);
    if (apiLevel !== null && apiLevel < MIN_APP_LOCALE_API_LEVEL) {
      return this.setLegacyAppLocale(languageTag, options, apiLevel);
    }

    const target = await this.resolveTargetUserId(appId);
    if ("error" in target) {
      return { success: false, languageTag, error: target.error };
    }
    const targetUserId = target.userId;
    // One read of the app's locales before the change: it supplies both
    // `previousLanguageTag` and the value to restore if the change does not stick.
    const previousLocales = await this.readAppLocales(appId, targetUserId);
    const previousLanguageTag = firstAppLocale(previousLocales);
    const notInstalledResult: SetLocaleResult = {
      success: false,
      languageTag,
      previousLanguageTag,
      error: notInstalledLocaleError(appId, targetUserId),
    };
    const sent = await this.sendAppLocale(appId, targetUserId, languageTag, previousLocales);
    if (sent === "notInstalled") {
      return notInstalledResult;
    }
    if (sent !== "sent") {
      return { success: false, languageTag, previousLanguageTag, error: sent.error };
    }

    const effectiveLocales = await this.readAppLocales(appId, targetUserId);
    if (isNotInstalled(effectiveLocales)) {
      // The app went away between the write and the read-back: nothing to restore.
      return notInstalledResult;
    }
    if (!effectiveLocales.readable) {
      // Same as the device-wide path: an unreadable read-back is not evidence the
      // change failed, so do not write the app's locale again on a guess.
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        error: indeterminateLocaleError(
          languageTag,
          `the app's locale could not be read back for ${appId}`,
          `the app's locale (previously ${describeAppLocales(previousLocales)})`,
        ),
      };
    }
    const effectiveLanguageTag = firstAppLocale(effectiveLocales);
    if (!localeTagsEquivalent(effectiveLanguageTag, languageTag)) {
      // The call is failing, so do not leave the app on whatever the device made
      // of the rejected tag (issue #10155): put the earlier locales back.
      const restoreNote = await this.restoreAppLocales(
        appId,
        targetUserId,
        previousLocales,
        effectiveLocales,
      );
      return {
        success: false,
        languageTag,
        previousLanguageTag,
        error: `Read-back verification failed for ${appId}: expected "${languageTag}" but got "${effectiveLanguageTag ?? "null"}"${restoreNote}`,
      };
    }

    const broadcasted = options.broadcast === false ? false : await this.broadcastLocaleChange();

    return {
      success: true,
      languageTag,
      previousLanguageTag,
      method: `cmd locale set-app-locales ${appId} --user ${targetUserId}`,
      localeScope: "app",
      broadcasted,
      ...(target.warning ? { warning: target.warning } : {}),
    };
  }

  /**
   * Send `set-app-locales`, unless the read before it already said the package is
   * unknown. `cmd` exits 0 for an unknown package, so the reply text is the only
   * signal that nothing was changed (#10211).
   */
  private async sendAppLocale(
    appId: string,
    userId: number,
    languageTag: string,
    previousLocales: AppLocaleRead,
  ): Promise<"sent" | "notInstalled" | { error: string }> {
    if (isNotInstalled(previousLocales)) {
      return "notInstalled";
    }
    try {
      const reply = await this.adb.executeCommand(
        `shell cmd locale set-app-locales ${shellQuote(appId)} --user ${userId} --locales ${shellQuote(languageTag)}`,
      );
      return parseAppLocalesReply(reply.stdout, reply.stderr).kind === "notInstalled"
        ? "notInstalled"
        : "sent";
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to set app locale: ${errorMessage(error)}`,
        error,
      );
      return { error: `Failed to set app locale for ${appId}: ${errorMessage(error)}` };
    }
  }

  /**
   * Resolve the user for an app-scoped locale change with the shared resolver
   * (foreground instance, then the running user where the package is
   * installed). Ambiguous device state is a typed failure rather than a silent
   * fallback to a user the app may not be installed in. The one exception is a
   * device whose user list could not be read and shows no sign of a second
   * user: see {@link singleUserFallback}.
   */
  private async resolveTargetUserId(
    appId: string,
  ): Promise<{ userId: number; warning?: string } | { error: string }> {
    try {
      const target = await new AndroidUserTargetResolver(this.adb).resolve({
        packageName: appId,
        installedOnly: true,
      });
      return { userId: target.userId };
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to resolve Android user for ${appId}: ${errorMessage(error)}`,
        error,
      );
      const fallback = await this.singleUserFallback(appId, error);
      if (fallback) {
        return fallback;
      }
      return {
        error:
          error instanceof AndroidUserTargetUnavailableError
            ? error.message
            : `Failed to resolve Android user for ${appId}: ${errorMessage(error)}`,
      };
    }
  }

  /**
   * Keep a single-user device working when its user list cannot be trusted.
   * `listUsers` returns [] on an adb timeout or unparseable output, and marks
   * user 0 not running when its `State:` line is missing or far from its
   * `UserInfo` line; the resolver then finds no running primary and refuses.
   * That refusal is right when another user exists, but on a device with only
   * user 0 it turned a working call into a failure. Fall back to user 0, with a
   * warning, only when the failure is that missing target (not an ambiguous
   * one), no user other than 0 was listed, and `am get-current-user` positively
   * reports user 0. An unreadable current user (probe failed or printed
   * something unparseable) is no evidence at all, and the failure stands. A known
   * managed profile keeps the failure.
   */
  private async singleUserFallback(
    appId: string,
    error: unknown,
  ): Promise<{ userId: 0; warning: string } | null> {
    if (
      !(error instanceof AndroidUserTargetUnavailableError) ||
      error.details.kind !== "unavailable" ||
      error.details.users.some((user) => user.userId !== 0) ||
      !(await this.currentUserIsPrimary())
    ) {
      return null;
    }
    return {
      userId: 0,
      warning: `Could not read the device's Android user list and found no sign of a second user, so ${appId}'s locale was set for user 0. If the device has a work profile or secondary user, verify the locale on the intended one.`,
    };
  }

  /** True only when the device itself says the current user is user 0. */
  private async currentUserIsPrimary(): Promise<boolean> {
    try {
      const result = await this.adb.executeCommand(
        "shell am get-current-user",
        undefined,
        undefined,
        true,
      );
      const currentUserId = Number.parseInt(result.stdout.trim(), 10);
      return currentUserId === 0;
    } catch (error) {
      // No evidence either way: the caller keeps its failure rather than guess user 0.
      logger.warn(
        `[SystemConfigurationManager] Could not read the current Android user: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  private async ensureRootForLegacyLocale(
    apiLevel: number,
  ): Promise<{ success: true } | { success: false; error: string }> {
    const result = await ensureAndroidRoot(this.adb);
    return result.success
      ? result
      : {
          success: false,
          error: `Android API ${apiLevel} does not support app-scoped locale changes, so AutoMobile must use the root-backed system locale path. ${result.error}`,
        };
  }

  async setTimeZone(zoneId: string): Promise<SetTimeZoneResult> {
    const previousZoneId = await this.readSetting(TIME_ZONE_READ);

    try {
      await this.adb.executeCommand(`shell setprop persist.sys.timezone ${shellQuote(zoneId)}`);
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to set time zone: ${errorMessage(error)}`,
        error,
      );
      const errorMsg = errorMessage(error);
      return {
        success: false,
        zoneId,
        previousZoneId,
        error: `Failed to set time zone: ${errorMsg}`,
      };
    }

    // The persisted property is the only zone the adapter can read on Android: a
    // raw `setprop` does not go through the system's time-zone setter and there is
    // no captured read of the zone the framework is actually using. So this
    // confirms the value was stored, not that running apps observe it.
    const persistedZoneId = await this.readSetting(TIME_ZONE_READ);
    if (persistedZoneId === null) {
      // An unreadable read-back proves nothing about the device, so do not write
      // again on a guess (same contract as the locale path, issue #10155).
      return {
        success: false,
        zoneId,
        previousZoneId,
        error: `Time zone change outcome is indeterminate: "${zoneId}" was sent but no result was confirmed (persist.sys.timezone could not be read back). The device-wide time zone was not restored and may have changed${previousZoneId === null ? "" : ` (previously "${previousZoneId}")`}. Do not retry automatically. Check the current time zone before retrying.`,
      };
    }
    if (!timeZoneIdsEquivalent(persistedZoneId, zoneId)) {
      const restoreNote = await this.restoreSystemTimeZone(previousZoneId, persistedZoneId);
      return {
        success: false,
        zoneId,
        previousZoneId,
        error: `Read-back verification failed: expected "${zoneId}" but got "${persistedZoneId}"${restoreNote}`,
      };
    }
    return {
      success: true,
      zoneId,
      previousZoneId,
      method: "setprop persist.sys.timezone",
      warning: ANDROID_TIME_ZONE_STORED_WARNING,
    };
  }

  /**
   * Put `persist.sys.timezone` back after a change that did not read back as
   * asked. Returns a sentence (with a leading ". ") to append to the caller's
   * error, or "" when the device still holds the earlier value so nothing needed
   * restoring. When the restore does not take, the sentence names the value the
   * device is left with.
   */
  private async restoreSystemTimeZone(
    previous: string | null,
    persisted: string | null,
  ): Promise<string> {
    const sameAsPrevious = (value: string | null): boolean =>
      previous === null ? value === null : timeZoneIdsEquivalent(value, previous);
    if (sameAsPrevious(persisted)) {
      return "";
    }

    const previousLabel = previous === null ? "unset" : `"${previous}"`;
    let restoreFailure = "";
    try {
      // An empty value clears the prop, which is how an unset zone is restored.
      await this.adb.executeCommand(
        `shell setprop persist.sys.timezone ${shellQuote(previous ?? "")}`,
      );
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to restore time zone: ${errorMessage(error)}`,
        error,
      );
      restoreFailure = ` (${errorMessage(error)})`;
    }

    const afterRestore = await this.readSetting(TIME_ZONE_READ);
    if (sameAsPrevious(afterRestore)) {
      return `. Restored the previous time zone (${previousLabel}).`;
    }
    return `. Restoring the previous time zone (${previousLabel}) failed${restoreFailure}; persist.sys.timezone is left as "${afterRestore ?? "null"}".`;
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
        // Both keys and the numeric value come from fixed literals above.
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
        error: "Failed to update RTL settings",
      };
    }

    const broadcasted = options.broadcast === false ? false : await this.broadcastLocaleChange();

    return {
      success: true,
      rtl,
      previousRtl,
      settings: appliedSettings,
      broadcasted,
    };
  }

  async set24HourFormat(enabled: boolean): Promise<Set24HourFormatResult> {
    const previousFormat = await this.readSetting("shell settings get system time_12_24");
    const value = enabled ? "24" : "12";

    try {
      // The value is selected only from the fixed "12" and "24" literals.
      await this.runShellCommand(`shell settings put system time_12_24 ${value}`);
      return {
        success: true,
        enabled,
        previousFormat: normalizeTimeFormat(previousFormat),
      };
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to set 24-hour format: ${errorMessage(error)}`,
        error,
      );
      const errorMsg = errorMessage(error);
      return {
        success: false,
        enabled,
        previousFormat: normalizeTimeFormat(previousFormat),
        error: `Failed to set 24-hour format: ${errorMsg}`,
      };
    }
  }

  async setCalendarSystem(calendarSystem: string): Promise<SetCalendarSystemResult> {
    const previous = await this.getCalendarSystem();
    const previousCalendarSystem = previous.calendarSystem ?? null;

    try {
      await this.runShellCommand(
        `shell settings put system calendar_type ${shellQuote(calendarSystem)}`,
      );
      const readBack = await this.readSetting("shell settings get system calendar_type");
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
      logger.warn(
        `[SystemConfigurationManager] Failed to set calendar system: ${errorMessage(error)}`,
        error,
      );
      const errorMsg = errorMessage(error);
      return {
        success: false,
        calendarSystem,
        previousCalendarSystem,
        error: `Failed to set calendar system: ${errorMsg}`,
      };
    }
  }

  async getCalendarSystem(): Promise<GetCalendarSystemResult> {
    const calendarType = await this.readSetting("shell settings get system calendar_type");
    if (calendarType) {
      return {
        success: true,
        calendarSystem: calendarType,
        source: "settings.calendar_type",
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
          source: "locale",
        };
      }
    }

    return {
      success: true,
      calendarSystem: this.defaultCalendarSystem,
      locale: locale ?? null,
      source: "default",
    };
  }

  async getLocalizationSettings(): Promise<LocalizationSettingsResult> {
    const locale = await this.getCurrentLocaleTag();
    const timeZone = await this.readSetting("shell getprop persist.sys.timezone");
    const timeFormat = normalizeTimeFormat(
      await this.readSetting("shell settings get system time_12_24"),
    );
    const debugForceRtl = await this.readSetting("shell settings get global debug.force_rtl");
    const forceRtl = await this.readSetting("shell settings get global force_rtl");
    const rtlSetting = parseBooleanSetting(debugForceRtl) ?? parseBooleanSetting(forceRtl);
    const textDirection = rtlSetting === null ? null : rtlSetting ? "rtl" : "ltr";
    const calendarResult = await this.getCalendarSystem();

    return {
      success: calendarResult.success,
      locale,
      timeZone,
      textDirection,
      timeFormat,
      calendarSystem: calendarResult.calendarSystem ?? null,
      error: calendarResult.error,
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
        logger.debug(
          `[SystemConfigurationManager] a11y settings get failed for ${namespace}/${key}: ${error}`,
        );
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
    const putMatch = command.match(
      /^shell\s+settings\s+put\s+(system|secure|global)\s+(\S+)\s+(.+)$/,
    );
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
        logger.debug(
          `[SystemConfigurationManager] a11y settings put failed for ${namespace}/${key}: ${error}`,
        );
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

  private async readAppLocales(appId: string, userId: number): Promise<AppLocaleRead> {
    try {
      const result = await this.adb.executeCommand(
        `shell cmd locale get-app-locales ${shellQuote(appId)} --user ${userId}`,
        undefined,
        undefined,
        true,
      );
      const reply = parseAppLocalesReply(result.stdout, result.stderr);
      if (reply.kind === "list") {
        return { readable: true, list: reply.list };
      }
      return { readable: false, notInstalled: reply.kind === "notInstalled" };
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to read Android app locale for ${appId}: ${error}`,
      );
      return { readable: false, notInstalled: false };
    }
  }

  /**
   * Put an app's locales back after a change that did not read back as asked.
   * Returns a sentence (with a leading ". ") to append to the caller's error,
   * stating what was done and, when the restore did not take, the state the app
   * is left in. Returns "" when nothing needed restoring because the device
   * still reports the earlier locales.
   */
  private async restoreAppLocales(
    appId: string,
    userId: number,
    previous: AppLocaleRead,
    current: AppLocaleRead,
  ): Promise<string> {
    if (!previous.readable) {
      return `. The app's previous locale could not be read before the change, so it was not restored; the app's locale is now ${describeAppLocales(current)}.`;
    }
    if (current.readable && sameLocaleList(current.list, previous.list)) {
      return "";
    }

    // An empty `--locales` clears the app's override, which is how an app that
    // had none goes back to following the system. This is the form
    // scripts/local-dev/probe-android-locale.sh uses to reset; the quotes keep
    // the empty argument alive through the device shell.
    let restoreFailure = "";
    try {
      await this.adb.executeCommand(
        `shell cmd locale set-app-locales ${shellQuote(appId)} --user ${userId} --locales ${shellQuote(previous.list)}`,
      );
    } catch (error) {
      logger.warn(
        `[SystemConfigurationManager] Failed to restore app locale for ${appId}: ${errorMessage(error)}`,
        error,
      );
      restoreFailure = ` (${errorMessage(error)})`;
    }

    const afterRestore = await this.readAppLocales(appId, userId);
    if (afterRestore.readable && sameLocaleList(afterRestore.list, previous.list)) {
      return `. Restored the app's previous locale (${describeAppLocales(previous)}).`;
    }
    return `. Restoring the app's previous locale (${describeAppLocales(previous)}) failed${restoreFailure}; the app's locale is left as ${describeAppLocales(afterRestore)}.`;
  }

  private async getEffectiveLocaleTag(): Promise<string | null> {
    try {
      const result = await this.adb.executeCommand(
        "shell am get-config",
        undefined,
        undefined,
        true,
      );
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

    const bcp47Match = normalized.match(
      /(?:^|[-\s])b\+([a-z]{2,3})(?:\+([A-Za-z]{4}))?(?:\+([A-Z]{2}|\d{3}))?(?=[-\s]|$)/,
    );
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
}
