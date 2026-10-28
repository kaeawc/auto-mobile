import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AndroidUserTargetResolver } from "../../../utils/android-cmdline-tools/AndroidUserTargetResolver";
import { readAndroidDeviceApiLevel } from "../../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { shellQuote } from "../../../utils/shellQuote";
import { defaultTimer } from "../../../utils/SystemTimer";
import { normalizeSettingValue, parseAppLocalesReply } from "./parsing";

/** Android 13 added the app-scoped `cmd locale` shell command. */
export const MIN_APP_LOCALE_API_LEVEL = 33;

/** An app's locales as `cmd locale get-app-locales` lists them ("" when it has no override). */
export interface AppLocalePrior {
  userId: number;
  locales: string;
}

/** A raw settings row: `value` is null when the row is unset. */
export type RawSettingRead = { readable: true; value: string | null } | { readable: false };

/** Reads the device state changeLocalization overwrites, exactly as a restore must put it back. */
export interface LocalizationPriorSource {
  /**
   * The app's locales for the user changeLocalization targets, or null when the device has no
   * app-scoped locale command (below Android 13), the user cannot be resolved, or the reply is
   * not a locale list. Throws when the device cannot be reached.
   */
  readAppLocales(appId: string, signal?: AbortSignal): Promise<AppLocalePrior | null>;
  readSettingRow(
    namespace: "global" | "system",
    key: string,
    signal?: AbortSignal,
  ): Promise<RawSettingRead>;
}

export class AdbLocalizationPriorSource implements LocalizationPriorSource {
  constructor(private readonly adb: AdbExecutor) {}

  async readAppLocales(appId: string, signal?: AbortSignal): Promise<AppLocalePrior | null> {
    const apiLevel = await readAndroidDeviceApiLevel(this.adb, undefined, defaultTimer, signal);
    if (apiLevel === null || apiLevel < MIN_APP_LOCALE_API_LEVEL) {
      return null;
    }
    // The same resolution changeLocalization makes before it writes the app's locales.
    const target = await new AndroidUserTargetResolver(this.adb).resolve({
      packageName: appId,
      installedOnly: true,
      signal,
    });
    const result = await this.adb.executeCommand(
      `shell cmd locale get-app-locales ${shellQuote(appId)} --user ${target.userId}`,
      { noRetry: true, signal },
    );
    const reply = parseAppLocalesReply(result.stdout, result.stderr);
    return reply.kind === "list" ? { userId: target.userId, locales: reply.list } : null;
  }

  async readSettingRow(
    namespace: "global" | "system",
    key: string,
    signal?: AbortSignal,
  ): Promise<RawSettingRead> {
    const result = await this.adb.executeCommand(`shell settings get ${namespace} ${key}`, {
      noRetry: true,
      signal,
    });
    return result.error || result.stderr.trim()
      ? { readable: false }
      : { readable: true, value: normalizeSettingValue(result.stdout) };
  }
}
