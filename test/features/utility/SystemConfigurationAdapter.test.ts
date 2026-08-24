import { describe, it, expect } from "bun:test";
import { FakeSystemConfigurationAdapter } from "../../fakes/FakeSystemConfigurationAdapter";
import { AndroidSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/AndroidSystemConfigurationAdapter";
import { IosSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/IosSystemConfigurationAdapter";
import { createSystemConfigurationAdapter } from "../../../src/features/utility/system-configuration/createSystemConfigurationAdapter";
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

  // (FakeSystemConfigurationAdapter self-tests moved to
  // test/fakes/FakeSystemConfigurationAdapter.test.ts — they exercise only the
  // fake, not production code.)

  // Two platform adapters plus the fake all satisfy SystemConfigurationAdapter.
  // The conformance guard is the compile-time `SystemConfigurationAdapter`
  // annotation on the constructed adapter: if a shared member is dropped from an
  // implementation, `c.build()` no longer assigns to the interface-typed local
  // and this file fails to type-check. The former runtime `typeof x === "function"`
  // assertions restated what the type system already enforces, so they are gone.
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
      it("constructs as a SystemConfigurationAdapter", () => {
        const adapter: SystemConfigurationAdapter = c.build();
        expect(adapter).toBeDefined();
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
        if (command === "shell cmd locale get-app-locales 'com.example.app' --user 0") {
          const stdout =
            appLocaleResponses.shift() ?? "Locales for com.example.app for user 0 are [ja-JP]\n";
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
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 0");
      expect(result.previousLanguageTag).toBeNull();
      expect(
        adb.wasCommandExecuted(
          "cmd locale set-app-locales 'com.example.app' --user 0 --locales 'ja-JP'",
        ),
      ).toBe(true);
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
      expect(adb.wasCommandExecuted("stop; start")).toBe(false);
    });

    it("targets the foreground Android work-profile user for app-scoped locale commands", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setForegroundApp({ packageName: "com.example.app", userId: 10 });
      const appLocaleResponses = [
        "Locales for com.example.app for user 10 are []\n",
        "Locales for com.example.app for user 10 are [ja-JP]\n",
      ];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === "shell cmd locale get-app-locales 'com.example.app' --user 10") {
          await original(command, ...rest);
          const stdout =
            appLocaleResponses.shift() ?? "Locales for com.example.app for user 10 are [ja-JP]\n";
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
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 10");
      expect(
        adb.wasCommandExecuted(
          "cmd locale set-app-locales 'com.example.app' --user 10 --locales 'ja-JP'",
        ),
      ).toBe(true);
      expect(adb.wasCommandExecuted("cmd locale get-app-locales 'com.example.app' --user 10")).toBe(
        true,
      );
      expect(adb.wasCommandExecuted("cmd locale get-app-locales 'com.example.app' --user 0")).toBe(
        false,
      );
    });

    it("falls back to a running Android work-profile user for app-scoped locale commands", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setForegroundApp({ packageName: "com.other.app", userId: 0 });
      adb.setUsers([
        { userId: 0, name: "Owner", running: true },
        { userId: 10, name: "Work", running: true },
      ]);
      const appLocaleResponses = [
        "Locales for com.example.app for user 10 are []\n",
        "Locales for com.example.app for user 10 are [ja-JP]\n",
      ];
      const original = adb.executeCommand.bind(adb);
      adb.executeCommand = (async (command: string, ...rest: any[]) => {
        if (command === "shell cmd locale get-app-locales 'com.example.app' --user 10") {
          await original(command, ...rest);
          const stdout =
            appLocaleResponses.shift() ?? "Locales for com.example.app for user 10 are [ja-JP]\n";
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
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-app-locales com.example.app --user 10");
      expect(
        adb.wasCommandExecuted(
          "cmd locale set-app-locales 'com.example.app' --user 10 --locales 'ja-JP'",
        ),
      ).toBe(true);
    });

    it("uses root-backed system locale after adb root below Android 13", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandResult("root", "restarting adbd as root\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=0(root) gid=0(root)\n");
      adb.setCommandResult("shell settings get system system_locales", "en-US");
      adb.setCommandResult("shell am get-config", "config: mcc310-mnc260-ja-rJP-sw411dp\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.method).toBe("setprop persist.sys.locale + stop/start after adb root");
      expect(adb.wasCommandExecuted("root")).toBe(true);
      expect(adb.wasCommandExecuted("shell id")).toBe(true);
      expect(adb.wasCommandExecuted("cmd locale set-app-locales")).toBe(false);
      expect(adb.wasCommandExecuted("setprop persist.sys.locale 'ja-JP'")).toBe(true);
    });

    it("returns a root-capability error below Android 13 when adb root fails", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandError("root", new Error("adbd cannot run as root in production builds"));
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Android API 32 does not support app-scoped locale changes");
      expect(result.error).toContain("target emulator is not root-capable");
      expect(result.error).toContain("adbd cannot run as root in production builds");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
    });

    it("returns a root-capability error below Android 13 when shell remains non-root", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandResult("root", "adbd cannot run as root in production builds\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=2000(shell) gid=2000(shell)\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("ADB shell is still not root");
      expect(result.error).toContain("uid=2000(shell)");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
    });

    it("returns false when app-scoped locale read-back does not match", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult(
        "shell cmd locale get-app-locales 'com.example.app' --user 0",
        "Locales for com.example.app for user 0 are [en-US]\n",
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Read-back verification failed for com.example.app: expected "ja-JP" but got "en-US"',
      );
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("returns false when app-scoped locale read-back has no locale list", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult(
        "shell cmd locale get-app-locales 'com.example.app' --user 0",
        "Unknown package com.example.app for userId 0\n",
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Read-back verification failed for com.example.app: expected "ja-JP" but got "null"',
      );
      expect(adb.wasCommandExecuted("am broadcast")).toBe(false);
    });

    it("uses the first locale when app-scoped read-back returns multiple locales", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "36");
      adb.setCommandResult(
        "shell cmd locale get-app-locales 'com.example.app' --user 0",
        "Locales for com.example.app for user 0 are [ja-JP,en-US]\n",
      );
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", {
        broadcast: false,
        appId: "com.example.app",
      });

      expect(result.success).toBe(true);
      expect(result.previousLanguageTag).toBe("ja-JP");
    });

    it("requires appId for Android locale changes", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { broadcast: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("appId is required for Android locale changes");
      expect(adb.wasCommandExecuted("setprop persist.sys.locale")).toBe(false);
      expect(adb.wasCommandExecuted("cmd locale set-app-locales")).toBe(false);
    });

    it("returns false when legacy root-backed verification reads the old effective locale", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.build.version.sdk", "32");
      adb.setCommandResult("root", "restarting adbd as root\n");
      adb.setCommandResult("wait-for-device", "");
      adb.setCommandResult("shell id", "uid=0(root) gid=0(root)\n");
      adb.setCommandResult("shell settings get system system_locales", "en-US");
      adb.setCommandResult("shell am get-config", "config: mcc310-mnc260-en-rUS-sw411dp\n");
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setLocale("ja-JP", { appId: "com.example.app" });

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
          c.command.includes("am broadcast -a android.intent.action.LOCALE_CHANGED"),
        ),
      ).toBe(true);
    });

    it("returns false from broadcastLocaleChange when ADB fails", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandError(
        "shell am broadcast -a android.intent.action.LOCALE_CHANGED",
        new Error("device offline"),
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
      expect(result.error).toBe(
        'Read-back verification failed: expected "Asia/Tokyo" but got "America/New_York"',
      );
    });

    it("returns false when the time-zone read-back is null", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Read-back verification failed: expected "Asia/Tokyo" but got "null"',
      );
    });

    it("surfaces setprop failures for time-zone changes", async () => {
      const adb = new FakeAdbClient();
      adb.setCommandError(
        "shell setprop persist.sys.timezone 'Asia/Tokyo'",
        new Error("device offline"),
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
    it("rejects physical iOS system configuration without executing commands", async () => {
      const exec = new FakeProcessExecutor();
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, exec);

      await expect(adapter.setLocale("ja-JP", {})).resolves.toMatchObject({
        success: false,
        error: "System configuration is not supported on physical iOS devices.",
      });
      await expect(adapter.getLocalizationSettings()).resolves.toMatchObject({
        success: false,
        error: "System configuration is not supported on physical iOS devices.",
      });
      await expect(adapter.getCalendarSystem()).resolves.toMatchObject({
        success: false,
        error: "System configuration is not supported on physical iOS devices.",
      });
      expect(exec.getExecutedCommands()).toHaveLength(0);
    });

    it("rejects time-zone changes on physical devices", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(false);
      expect(result.error).toBe("System configuration is not supported on physical iOS devices.");
    });

    it("rejects 24-hour format changes on physical devices with a capability-specific error", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.set24HourFormat(true);
      expect(result.success).toBe(false);
      expect(result.error).toBe("System configuration is not supported on physical iOS devices.");
    });

    it("rejects calendar changes on physical devices with a capability-specific error", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setCalendarSystem("japanese");
      expect(result.success).toBe(false);
      expect(result.error).toBe("System configuration is not supported on physical iOS devices.");
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
      exec.setCommandResponse(
        "defaults read .GlobalPreferences AppleLocale",
        execResult("ja_JP\n"),
      );
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, exec);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(true);
      expect(
        exec.wasCommandExecuted(
          `xcrun simctl spawn ${iosSimulator.deviceId} defaults write .GlobalPreferences AppleLocale ja_JP`,
        ),
      ).toBe(true);
    });
  });

  describe("createSystemConfigurationAdapter factory", () => {
    it("returns an AndroidSystemConfigurationAdapter for Android devices", () => {
      const adapter = createSystemConfigurationAdapter(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeProcessExecutor(),
      );
      expect(adapter).toBeInstanceOf(AndroidSystemConfigurationAdapter);
    });

    it("returns an IosSystemConfigurationAdapter for iOS devices", () => {
      const adapter = createSystemConfigurationAdapter(
        iosSimulator,
        new FakeAdbClient() as any,
        new FakeProcessExecutor(),
      );
      expect(adapter).toBeInstanceOf(IosSystemConfigurationAdapter);
    });
  });
});
