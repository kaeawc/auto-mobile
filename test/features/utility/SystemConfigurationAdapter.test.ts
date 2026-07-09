import { describe, it, expect, beforeEach } from "bun:test";
import { FakeSystemConfigurationAdapter } from "../../fakes/FakeSystemConfigurationAdapter";
import { AndroidSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/AndroidSystemConfigurationAdapter";
import { IosSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/IosSystemConfigurationAdapter";
import { createSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/createSystemConfigurationAdapter";
import {
  CommandLineLockdownLocaleClient,
  type IosLanguageConfig,
  type LockdownLocaleClient,
} from "../../../src/features/utility/system-configuration/IosLockdownLocaleClient";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import type { SystemConfigurationAdapter } from "../../../src/utils/interfaces/SystemConfigurationAdapter";

/**
 * Sanity-check the platform-agnostic SystemConfigurationAdapter contract.
 * Tests deliberately type their subjects as the abstract interface so a
 * regression that drops one of the shared members will surface as a
 * compile error here.
 */
describe("SystemConfigurationAdapter", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel 7",
    platform: "android",
  };
  const iosSimulator: BootedDevice = {
    deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    name: "iPhone 15",
    platform: "ios",
  };
  const iosPhysical: BootedDevice = {
    deviceId: "00008130-001234567890abcd",
    name: "iPhone 15 Pro",
    platform: "ios",
  };

  const execResult = (stdout: string, stderr = ""): ExecResult => ({
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });

  class FakeLockdownLocaleClient implements LockdownLocaleClient {
    languageConfig: IosLanguageConfig = {
      language: "en",
      locale: "en_US",
      supportedLanguages: ["en", "ja"],
      supportedLocales: ["en_US", "ja_JP"],
    };

    setLanguageConfigAfterWrite: IosLanguageConfig | null = null;
    getLanguageCalls: string[] = [];
    setLanguageCalls: Array<{ udid: string; language: string | null; locale: string | null }> = [];
    setError: Error | null = null;

    async getLanguage(udid: string): Promise<IosLanguageConfig> {
      this.getLanguageCalls.push(udid);
      if (this.setLanguageCalls.length > 0 && this.setLanguageConfigAfterWrite) {
        return this.setLanguageConfigAfterWrite;
      }
      return this.languageConfig;
    }

    async setLanguage(udid: string, language: string | null, locale: string | null): Promise<void> {
      this.setLanguageCalls.push({ udid, language, locale });
      if (this.setError) {
        throw this.setError;
      }
    }
  }

  describe("FakeSystemConfigurationAdapter", () => {
    let fake: FakeSystemConfigurationAdapter;

    beforeEach(() => {
      fake = new FakeSystemConfigurationAdapter();
    });

    it("records each method invocation", async () => {
      await fake.setLocale("ja-JP", { broadcast: true });
      await fake.setTimeZone("Asia/Tokyo");
      await fake.setTextDirection(true, {});
      await fake.set24HourFormat(true);
      await fake.setCalendarSystem("japanese");
      await fake.getCalendarSystem();
      await fake.getLocalizationSettings();
      await fake.broadcastLocaleChange();

      expect(fake.wasMethodCalled("setLocale")).toBe(true);
      expect(fake.wasMethodCalled("setTimeZone")).toBe(true);
      expect(fake.wasMethodCalled("setTextDirection")).toBe(true);
      expect(fake.wasMethodCalled("set24HourFormat")).toBe(true);
      expect(fake.wasMethodCalled("setCalendarSystem")).toBe(true);
      expect(fake.wasMethodCalled("getCalendarSystem")).toBe(true);
      expect(fake.wasMethodCalled("getLocalizationSettings")).toBe(true);
      expect(fake.wasMethodCalled("broadcastLocaleChange")).toBe(true);
    });

    it("captures call arguments in the recorded operation string", async () => {
      await fake.setLocale("fr-CA", { broadcast: false });
      await fake.setTimeZone("Europe/Paris");

      const ops = fake.getExecutedOperations();
      expect(ops).toContain("setLocale:fr-CA:false");
      expect(ops).toContain("setTimeZone:Europe/Paris");
    });

    it("clears recorded history on demand", async () => {
      await fake.broadcastLocaleChange();
      fake.clearHistory();
      expect(fake.getExecutedOperations()).toEqual([]);
    });

    it("returns the configured stub results", async () => {
      fake.setLocaleResult = { success: false, languageTag: "x-y", error: "stubbed" };
      const result = await fake.setLocale("x-y", {});
      expect(result.success).toBe(false);
      expect(result.error).toBe("stubbed");
    });

    it("counts each invocation independently", async () => {
      await fake.broadcastLocaleChange();
      await fake.broadcastLocaleChange();
      await fake.broadcastLocaleChange();
      expect(fake.getCallCount("broadcastLocaleChange")).toBe(3);
    });
  });

  // Two platform adapters plus the fake all satisfy
  // SystemConfigurationAdapter. Data-driven so each gets the same
  // conformance checks without duplicating describe blocks.
  interface AdapterCase {
    name: string;
    build: () => SystemConfigurationAdapter;
  }

  const cases: ReadonlyArray<AdapterCase> = [
    {
      name: "AndroidSystemConfigurationAdapter",
      build: () => new AndroidSystemConfigurationAdapter(androidDevice, new FakeAdbClient() as any),
    },
    {
      name: "IosSystemConfigurationAdapter",
      build: () => new IosSystemConfigurationAdapter(iosSimulator, new FakeProcessExecutor()),
    },
    {
      name: "FakeSystemConfigurationAdapter",
      build: () => new FakeSystemConfigurationAdapter(),
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("satisfies the SystemConfigurationAdapter interface", () => {
        const adapter: SystemConfigurationAdapter = c.build();
        expect(typeof adapter.setLocale).toBe("function");
        expect(typeof adapter.setTimeZone).toBe("function");
        expect(typeof adapter.setTextDirection).toBe("function");
        expect(typeof adapter.set24HourFormat).toBe("function");
        expect(typeof adapter.setCalendarSystem).toBe("function");
        expect(typeof adapter.getCalendarSystem).toBe("function");
        expect(typeof adapter.getLocalizationSettings).toBe("function");
        expect(typeof adapter.broadcastLocaleChange).toBe("function");
      });
    });
  }

  describe("AndroidSystemConfigurationAdapter behavior", () => {
    it("sets an app-scoped locale with cmd locale when appId is provided", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      const appLocaleResponses = [
        "Locales for com.example.app for user 0 are []\n",
        "Locales for com.example.app for user 0 are [ja-JP]\n",
      ];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === "shell cmd locale get-app-locales 'com.example.app'") {
          const stdout = appLocaleResponses.shift() ?? "Locales for com.example.app for user 0 are [ja-JP]\n";
          return {
            stdout,
            stderr: "",
            toString: () => stdout,
            trim: () => stdout.trim(),
            includes: (s: string) => stdout.includes(s),
          };
        }
        return original(command, ...rest);
      }) as any;

      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { broadcast: false, appId: "com.example.app" });

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-app-locales com.example.app");
      expect(result.previousLanguageTag).toBeNull();
      expect(adb.wasCommandExecuted("cmd locale set-app-locales 'com.example.app' --locales 'ja-JP'")).toBe(true);
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
      expect(adb.wasCommandExecuted("stop; start")).toBe(false);
    });

    it("rejects app-scoped locale changes below Android 13", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Android app-scoped locale changes require API 33+; device is API 32");
      expect(adb.wasCommandExecuted("cmd locale set-app-locales")).toBe(false);
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
    });

    it("returns false when app-scoped locale read-back does not match", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult("shell cmd locale get-app-locales 'com.example.app'", "Locales for com.example.app for user 0 are [en-US]\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read-back verification failed for com.example.app: expected "ja-JP" but got "en-US"');
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("sets system locale with setprop, restarts Android, and verifies am get-config", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell settings get system system_locales", "en-US");
      adb.setCommandResult("shell am get-config", "config: mcc310-mnc260-ja-rJP-sw411dp\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { broadcast: false });

      expect(result.success).toBe(true);
      expect(result.method).toBe("setprop persist.sys.locale + stop/start");
      expect(result.previousLanguageTag).toBe("en-US");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale 'ja-JP'")).toBe(true);
      expect(adb.wasCommandExecuted("stop; start")).toBe(true);
      expect(adb.wasCommandExecuted("cmd locale set-locales ja-JP")).toBe(false);
      expect(adb.wasCommandExecuted("settings put system user_locale ja-JP")).toBe(false);
    });

    it("returns false when Android locale verification reads the old effective locale", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell settings get system system_locales", "en-US");
      adb.setCommandResult("shell am get-config", "config: mcc310-mnc260-en-rUS-sw411dp\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read-back verification failed: expected "ja-JP" but got "en-US"');
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("ignores no-op user_locale when reading Android localization settings", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell settings get system user_locale", "fr-FR");
      adb.setCommandResult("shell am get-config", "config: mcc310-mnc260-en-rUS-sw411dp\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.getLocalizationSettings();

      expect(result.locale).toBe("en-US");
      expect(adb.wasCommandExecuted("settings get system user_locale")).toBe(false);
    });

    it("broadcasts the LOCALE_CHANGED intent via ADB", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.broadcastLocaleChange();
      expect(result).toBe(true);
      const calls = (adb as any).getCommandCalls?.() ?? [];
      // Look for the broadcast command (FakeAdbClient records under commandCalls)
      const recorded = (adb as any).commandCalls ?? calls;
      expect(
        recorded.some((c: { command: string }) =>
          c.command.includes("am broadcast -a android.intent.action.LOCALE_CHANGED")
        )
      ).toBe(true);
    });

    it("returns false from broadcastLocaleChange when ADB fails", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandError(
        "shell am broadcast -a android.intent.action.LOCALE_CHANGED",
        new Error("device offline")
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      expect(await adapter.broadcastLocaleChange()).toBe(false);
    });

    it("sets the system time zone via setprop and verifies the read-back", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop persist.sys.timezone", "Asia/Tokyo");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(true);
      expect(result.zoneId).toBe("Asia/Tokyo");
      expect(result.method).toBe("setprop persist.sys.timezone");
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone 'Asia/Tokyo'")).toBe(true);
    });

    it("returns the previous time zone when read-back confirms the change", async () => {
      const adb = new FakeAdbClient();
      const responses = ["America/New_York", "Asia/Tokyo"];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === "shell getprop persist.sys.timezone") {
          return {
            stdout: responses.shift() ?? "Asia/Tokyo",
            stderr: "",
            toString: () => "",
            trim: () => "",
            includes: () => false,
          };
        }
        return original(command, ...rest);
      }) as any;
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(true);
      expect(result.previousZoneId).toBe("America/New_York");
    });

    it("returns false when the time-zone read-back does not match (silent no-op)", async () => {
      const adb = new FakeAdbClient();
      // setprop is silently ignored (e.g. non-root adbd): getprop still returns the old value.
      adb.setCommandResult("shell getprop persist.sys.timezone", "America/New_York");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.zoneId).toBe("Asia/Tokyo");
      expect(result.error).toBe('Read-back verification failed: expected "Asia/Tokyo" but got "America/New_York"');
    });

    it("returns false when the time-zone read-back is null", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.error).toBe('Read-back verification failed: expected "Asia/Tokyo" but got "null"');
    });

    it("surfaces setprop failures for time-zone changes", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("device offline")
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to set time zone: device offline");
    });

    it("shell-quotes the time-zone id to avoid injection", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop persist.sys.timezone", "Asia/Tokyo");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      await adapter.setTimeZone("Asia/Tokyo");
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone 'Asia/Tokyo'")).toBe(true);
      expect(adb.wasCommandExecuted("setprop persist.sys.timezone Asia/Tokyo;")).toBe(false);
    });
  });

  describe("IosSystemConfigurationAdapter behavior", () => {
    it("sets locale on physical devices through lockdown and verifies read-back", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.setLanguageConfigAfterWrite = { language: "ja", locale: "ja_JP" };
      const exec = new FakeProcessExecutor();
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, exec, lockdown);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(true);
      expect(result.method).toBe("lockdown com.apple.international Language+Locale");
      expect(result.previousLanguageTag).toBe("en_US");
      expect(result.appliedLanguages).toEqual(["ja-JP", "ja"]);
      expect(lockdown.setLanguageCalls).toEqual([
        { udid: iosPhysical.deviceId, language: "ja", locale: "ja_JP" },
      ]);
      expect(lockdown.getLanguageCalls).toEqual([iosPhysical.deviceId, iosPhysical.deviceId]);
      expect(exec.getExecutedCommands()).toHaveLength(0);
    });

    it("preserves the best supported script-specific language for physical locale changes", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.languageConfig = {
        language: "en",
        locale: "en_US",
        supportedLanguages: ["zh-Hans", "zh-Hant", "zh"],
      };
      lockdown.setLanguageConfigAfterWrite = { language: "zh-Hant", locale: "zh_Hant_TW" };
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);

      const result = await adapter.setLocale("zh-Hant-TW", {});

      expect(result.success).toBe(true);
      expect(lockdown.setLanguageCalls).toEqual([
        { udid: iosPhysical.deviceId, language: "zh-Hant", locale: "zh_Hant_TW" },
      ]);
    });

    it("uses the full requested language tag when physical supported languages are unavailable", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.languageConfig = { language: "en", locale: "en_US" };
      lockdown.setLanguageConfigAfterWrite = { language: "pt-BR", locale: "pt_BR" };
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);

      const result = await adapter.setLocale("pt-BR", {});

      expect(result.success).toBe(true);
      expect(lockdown.setLanguageCalls).toEqual([
        { udid: iosPhysical.deviceId, language: "pt-BR", locale: "pt_BR" },
      ]);
    });

    it("returns a verification error when physical locale read-back does not match", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.setLanguageConfigAfterWrite = { language: "ja", locale: "fr_FR" };
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Read-back verification failed");
      expect(result.error).toContain("expected \"ja_JP\"");
    });

    it("returns a verification error when physical language read-back does not match", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.setLanguageConfigAfterWrite = { language: "en", locale: "ja_JP" };
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("Read-back verification failed");
      expect(result.error).toContain("Language");
      expect(result.error).toContain("expected \"ja\"");
    });

    it("surfaces pairing or lockdown write failures for physical locale changes", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.setError = new Error("device is not paired or trusted");
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to set locale on physical iOS device: device is not paired or trusted");
    });

    it("reads localization settings from lockdown on physical devices", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.languageConfig = { language: "fa", locale: "fa_IR@calendar=persian" };
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);
      const result = await adapter.getLocalizationSettings();

      expect(result.success).toBe(true);
      expect(result.locale).toBe("fa_IR@calendar=persian");
      expect(result.languages).toBe("fa");
      expect(result.calendarSystem).toBe("persian");
      expect(result.timeZone).toBeNull();
      expect(result.timeFormat).toBeNull();
      expect(result.textDirection).toBeNull();
    });

    it("derives physical calendar settings from the lockdown locale", async () => {
      const lockdown = new FakeLockdownLocaleClient();
      lockdown.languageConfig = { language: "th", locale: "th_TH-u-ca-buddhist" };
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor(), lockdown);
      const result = await adapter.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("buddhist");
      expect(result.locale).toBe("th_TH-u-ca-buddhist");
      expect(result.source).toBe("locale");
    });

    it("rejects time-zone changes on physical devices", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Time zone changes are not supported on physical iOS devices because iOS exposes no lockdown key for this setting.");
    });

    it("rejects 24-hour format changes on physical devices with a capability-specific error", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.set24HourFormat(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe("24-hour format changes are not supported on physical iOS devices because iOS exposes no lockdown key for this setting.");
    });

    it("rejects calendar changes on physical devices with a capability-specific error", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setCalendarSystem("japanese");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Calendar system changes are not supported as an independent setting on physical iOS devices; encode calendar in the locale when supported.");
    });

    it("setTextDirection returns the iOS-specific error regardless of simulator state", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, new FakeProcessExecutor());
      const result = await adapter.setTextDirection(true, {});
      expect(result.success).toBe(false);
      expect(result.rtl).toBe(true);
      expect(result.error).toContain("Text direction is not supported on iOS");
    });

    it("broadcastLocaleChange is a no-op on iOS (returns false)", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, new FakeProcessExecutor());
      expect(await adapter.broadcastLocaleChange()).toBe(false);
    });

    it("writes AppleLocale via xcrun simctl spawn defaults", async () => {
      const exec = new FakeProcessExecutor();
      exec.setCommandResponse("defaults read .GlobalPreferences AppleLocale", execResult("ja_JP\n"));
      const lockdown = new FakeLockdownLocaleClient();
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, exec, lockdown);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(true);
      expect(
        exec.wasCommandExecuted(
          `xcrun simctl spawn ${iosSimulator.deviceId} defaults write .GlobalPreferences AppleLocale ja_JP`
        )
      ).toBe(true);
      expect(lockdown.getLanguageCalls).toHaveLength(0);
      expect(lockdown.setLanguageCalls).toHaveLength(0);
    });
  });

  describe("CommandLineLockdownLocaleClient", () => {
    it("reads language and locale from the com.apple.international lockdown domain", async () => {
      const exec = new FakeProcessExecutor();
      exec.setCommandResponse("Language", execResult("ja\n"));
      exec.setCommandResponse("Locale", execResult("ja_JP\n"));
      const client = new CommandLineLockdownLocaleClient(exec);

      const result = await client.getLanguage(iosPhysical.deviceId);

      expect(result.language).toBe("ja");
      expect(result.locale).toBe("ja_JP");
      expect(exec.wasCommandExecuted("ideviceinfo")).toBe(true);
      expect(exec.wasCommandExecuted("-q 'com.apple.international'")).toBe(true);
      expect(exec.wasCommandExecuted("-k 'Language'")).toBe(true);
      expect(exec.wasCommandExecuted("-k 'Locale'")).toBe(true);
    });

    it("strips ideviceinfo indexes from supported language lists", async () => {
      const exec = new FakeProcessExecutor();
      exec.setCommandResponse("SupportedLanguages", execResult("0: zh-Hans\n1: zh-Hant\n2: zh\n"));
      exec.setCommandResponse("Language", execResult("en\n"));
      exec.setCommandResponse("Locale", execResult("en_US\n"));
      const client = new CommandLineLockdownLocaleClient(exec);

      const result = await client.getLanguage(iosPhysical.deviceId);

      expect(result.supportedLanguages).toEqual(["zh-Hans", "zh-Hant", "zh"]);
    });

    it("writes language and locale with pymobiledevice3 after pairing validation", async () => {
      const exec = new FakeProcessExecutor();
      exec.setCommandResponse("command -v pymobiledevice3", execResult("/opt/homebrew/bin/pymobiledevice3\n"));
      const client = new CommandLineLockdownLocaleClient(exec);

      await client.setLanguage(iosPhysical.deviceId, "ja", "ja_JP");

      const commands = exec.getExecutedCommands();
      expect(commands[0]).toContain("idevicepair");
      expect(exec.wasCommandExecuted("pymobiledevice3 lockdown language --udid")).toBe(true);
      expect(exec.wasCommandExecuted("pymobiledevice3 lockdown locale --udid")).toBe(true);
      expect(exec.wasCommandExecuted("--udid '00008130-001234567890abcd' 'ja'")).toBe(true);
      expect(exec.wasCommandExecuted("--udid '00008130-001234567890abcd' 'ja_JP'")).toBe(true);
    });

    it("returns an actionable error when no lockdown setter command is installed", async () => {
      const exec = new FakeProcessExecutor();
      const client = new CommandLineLockdownLocaleClient(exec);

      await expect(client.setLanguage(iosPhysical.deviceId, "ja", "ja_JP")).rejects.toThrow(
        "physical iOS locale writes require pymobiledevice3"
      );
    });

    it("normalizes command lookup failures for the lockdown setter", async () => {
      const exec = new FakeProcessExecutor();
      const originalExec = exec.exec.bind(exec);
      exec.exec = async (command, options) => {
        if (command === "command -v pymobiledevice3") {
          throw new Error("pymobiledevice3 not found");
        }
        return originalExec(command, options);
      };
      const client = new CommandLineLockdownLocaleClient(exec);

      await expect(client.setLanguage(iosPhysical.deviceId, "ja", "ja_JP")).rejects.toThrow(
        "physical iOS locale writes require pymobiledevice3"
      );
    });

    it("returns an actionable pairing error when lockdown reads fail", async () => {
      const exec = new FakeProcessExecutor();
      exec.exec = async () => {
        throw new Error("ERROR: Device is not paired");
      };
      const client = new CommandLineLockdownLocaleClient(exec);

      await expect(client.getLanguage(iosPhysical.deviceId)).rejects.toThrow(
        "connected, unlocked, paired, and trusted"
      );
    });
  });

  describe("createSystemConfigurationAdapter factory", () => {
    it("returns an AndroidSystemConfigurationAdapter for Android devices", () => {
      const adapter = createSystemConfigurationAdapter(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeProcessExecutor()
      );
      expect(adapter).toBeInstanceOf(AndroidSystemConfigurationAdapter);
    });

    it("returns an IosSystemConfigurationAdapter for iOS devices", () => {
      const adapter = createSystemConfigurationAdapter(
        iosSimulator,
        new FakeAdbClient() as any,
        new FakeProcessExecutor()
      );
      expect(adapter).toBeInstanceOf(IosSystemConfigurationAdapter);
    });
  });
});
