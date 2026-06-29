import type { ProcessExecutor } from "../../../utils/ProcessExecutor";
import { normalizeSettingValue } from "./parsing";

const LOCKDOWN_INTERNATIONAL_DOMAIN = "com.apple.international";
const LOCKDOWN_COMMAND_TIMEOUT_MS = 15000;

export interface IosLanguageConfig {
  language: string | null;
  locale: string | null;
  supportedLocales?: string[];
  supportedLanguages?: string[];
}

/** Reads/writes physical-device language and locale through lockdownd. */
export interface LockdownLocaleClient {
  getLanguage(udid: string): Promise<IosLanguageConfig>;
  setLanguage(udid: string, language: string | null, locale: string | null): Promise<void>;
}

/**
 * Command-backed lockdown locale client for physical iOS devices.
 *
 * `ideviceinfo` is available through the repo's existing libimobiledevice setup
 * and can read the `com.apple.international` domain. Generic lockdown writes
 * are exposed by pymobiledevice3, so writes use it when installed while this
 * interface keeps callers decoupled from that transport detail.
 */
export class CommandLineLockdownLocaleClient implements LockdownLocaleClient {
  constructor(private readonly processExecutor: ProcessExecutor) {}

  async getLanguage(udid: string): Promise<IosLanguageConfig> {
    const [language, locale] = await Promise.all([
      this.readInternationalValue(udid, "Language"),
      this.readInternationalValue(udid, "Locale"),
    ]);

    return {
      language,
      locale,
      supportedLanguages: await this.readInternationalList(udid, "SupportedLanguages"),
      supportedLocales: await this.readInternationalList(udid, "SupportedLocales"),
    };
  }

  async setLanguage(udid: string, language: string | null, locale: string | null): Promise<void> {
    if (!language && !locale) {
      throw new Error("language or locale must be provided");
    }

    await this.assertPairedAndTrusted(udid);
    await this.assertPymobiledeviceAvailable();

    if (language) {
      await this.setInternationalValue(udid, "Language", language);
    }
    if (locale) {
      await this.setInternationalValue(udid, "Locale", locale);
    }
  }

  private async readInternationalValue(udid: string, key: string): Promise<string | null> {
    try {
      const result = await this.processExecutor.exec(
        [
          "ideviceinfo",
          "-u", quoteShell(udid),
          "-q", quoteShell(LOCKDOWN_INTERNATIONAL_DOMAIN),
          "-k", quoteShell(key),
        ].join(" "),
        { timeoutMs: LOCKDOWN_COMMAND_TIMEOUT_MS }
      );
      return normalizeSettingValue(result.stdout);
    } catch (error) {
      const detail = normalizeError(error);
      throw new Error(
        `failed to read ${LOCKDOWN_INTERNATIONAL_DOMAIN}.${key} via ideviceinfo; ` +
        `ensure the physical iOS device is connected, unlocked, paired, and trusted` +
        `${detail ? ` (${detail})` : ""}`
      );
    }
  }

  private async readInternationalList(udid: string, key: string): Promise<string[] | undefined> {
    try {
      const raw = await this.readInternationalValue(udid, key);
      if (!raw) {
        return undefined;
      }
      const values = raw
        .split(/\r?\n|,/)
        .map(value => value.trim().replace(/^"|"$/g, "").replace(/^\d+:\s*/, ""))
        .filter(Boolean);
      return values.length > 0 ? values : undefined;
    } catch {
      return undefined;
    }
  }

  private async assertPairedAndTrusted(udid: string): Promise<void> {
    try {
      await this.processExecutor.exec(
        `idevicepair -u ${quoteShell(udid)} validate`,
        { timeoutMs: LOCKDOWN_COMMAND_TIMEOUT_MS }
      );
    } catch (error) {
      const detail = normalizeError(error);
      throw new Error(
        `physical iOS device is not paired or trusted; unlock the device, tap Trust, then run ` +
        `idevicepair -u ${udid} pair${detail ? ` (${detail})` : ""}`
      );
    }
  }

  private async assertPymobiledeviceAvailable(): Promise<void> {
    try {
      const result = await this.processExecutor.exec("command -v pymobiledevice3", {
        timeoutMs: LOCKDOWN_COMMAND_TIMEOUT_MS,
      });
      if (normalizeSettingValue(result.stdout)) {
        return;
      }
    } catch {
      // Fall through to the normalized setup error below.
    }

    throw new Error(
      "physical iOS locale writes require pymobiledevice3 for lockdownd SetValueForDomain; " +
      "install it or inject a native LockdownLocaleClient"
    );
  }

  private async setInternationalValue(udid: string, key: string, value: string): Promise<void> {
    const command = key === "Language" ? "language" : "locale";
    await this.processExecutor.exec(
      [
        "pymobiledevice3",
        "lockdown",
        command,
        "--udid", quoteShell(udid),
        quoteShell(value),
      ].join(" "),
      { timeoutMs: LOCKDOWN_COMMAND_TIMEOUT_MS }
    );
  }
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeError(error: unknown): string | null {
  if (error instanceof Error) {
    return normalizeSettingValue(error.message);
  }
  return normalizeSettingValue(String(error));
}
