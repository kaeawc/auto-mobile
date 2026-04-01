import { describe, expect, test, beforeEach } from "bun:test";
import { SystemConfigurationManager } from "../../../src/features/utility/SystemConfigurationManager";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";

const IOS_SIMULATOR: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  name: "iPhone 15 Pro",
  platform: "ios"
};

const IOS_PHYSICAL: BootedDevice = {
  deviceId: "00008130-001234567890abcd",
  name: "iPhone 15 Pro",
  platform: "ios"
};

const ANDROID_DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 7",
  platform: "android"
};

function execResult(stdout: string, stderr = ""): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s)
  };
}

describe("SystemConfigurationManager", () => {
  let fakeAdbClient: FakeAdbClient;
  let fakeAdbFactory: FakeAdbClientFactory;
  let fakeExec: FakeProcessExecutor;

  beforeEach(() => {
    fakeAdbClient = new FakeAdbClient();
    fakeAdbFactory = new FakeAdbClientFactory(fakeAdbClient);
    fakeExec = new FakeProcessExecutor();
  });

  // --- iOS Simulator: setLocale ---

  describe("iOS simulator setLocale", () => {
    test("writes AppleLocale via defaults write", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.languageTag).toBe("ja-JP");
      expect(result.method).toBe("defaults write AppleLocale");
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${IOS_SIMULATOR.deviceId} defaults write .GlobalPreferences AppleLocale ja_JP`
        )
      ).toBe(true);
    });

    test("converts BCP-47 hyphens to underscores for Apple format", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      await mgr.setLocale("en-US");

      expect(
        fakeExec.wasCommandExecuted("AppleLocale en_US")
      ).toBe(true);
    });

    test("reads previous locale before writing", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleLocale", execResult("en_US\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.previousLanguageTag).toBe("en_US");
    });

    test("returns error for empty languageTag", async () => {
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("languageTag must be a non-empty string");
    });

    test("returns error for physical iOS device", async () => {
      const mgr = new SystemConfigurationManager(IOS_PHYSICAL, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
    });

    test("returns error when defaults write fails", async () => {
      fakeExec.setCommandResponse("defaults read", execResult(""));
      fakeExec.setCommandResponse("defaults write", execResult("", "error"));
      // Override to throw
      const originalExec = fakeExec.exec.bind(fakeExec);
      fakeExec.exec = async (command, options) => {
        if (command.includes("defaults write .GlobalPreferences AppleLocale")) {
          throw new Error("simctl failed");
        }
        return originalExec(command, options);
      };

      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to set locale");
    });
  });

  // --- iOS Simulator: setTimeZone ---

  describe("iOS simulator setTimeZone", () => {
    test("disables auto-timezone then writes AppleTimeZone", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(true);
      expect(result.zoneId).toBe("Asia/Tokyo");

      const commands = fakeExec.getExecutedCommands();
      const autoTzIndex = commands.findIndex(c => c.includes("AutomaticTimeZoneSetting"));
      const writeIndex = commands.findIndex(c => c.includes("AppleTimeZone") && c.includes("defaults write"));
      expect(autoTzIndex).toBeGreaterThanOrEqual(0);
      expect(writeIndex).toBeGreaterThan(autoTzIndex);
    });

    test("disables auto-timezone with correct command", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      await mgr.setTimeZone("America/New_York");

      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${IOS_SIMULATOR.deviceId} defaults write com.apple.mobiletimerd AutomaticTimeZoneSetting -bool NO`
        )
      ).toBe(true);
    });

    test("reads previous timezone before writing", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleTimeZone", execResult("America/Los_Angeles\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(true);
      expect(result.previousZoneId).toBe("America/Los_Angeles");
    });

    test("returns error for empty zoneId", async () => {
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("zoneId must be a non-empty string");
    });

    test("returns error for physical iOS device", async () => {
      const mgr = new SystemConfigurationManager(IOS_PHYSICAL, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
    });
  });

  // --- iOS Simulator: set24HourFormat ---

  describe("iOS simulator set24HourFormat", () => {
    test("writes AppleICUForce24HourTime YES for 24h", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(true);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${IOS_SIMULATOR.deviceId} defaults write .GlobalPreferences AppleICUForce24HourTime -bool YES`
        )
      ).toBe(true);
    });

    test("writes AppleICUForce24HourTime NO for 12h", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(false);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(false);
      expect(
        fakeExec.wasCommandExecuted("AppleICUForce24HourTime -bool NO")
      ).toBe(true);
    });

    test("reads previous format before writing", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleICUForce24HourTime", execResult("1\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(false);

      expect(result.success).toBe(true);
      expect(result.previousFormat).toBe("24");
    });

    test("returns error for physical iOS device", async () => {
      const mgr = new SystemConfigurationManager(IOS_PHYSICAL, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(true);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
    });
  });

  // --- iOS Simulator: setTextDirection ---

  describe("iOS simulator setTextDirection", () => {
    test("returns unsupported error for iOS", async () => {
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Text direction is not supported on iOS");
      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
    });
  });

  // --- iOS Simulator: getLocalizationSettings ---

  describe("iOS simulator getLocalizationSettings", () => {
    test("reads all settings via defaults read", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleLocale", execResult("ja_JP\n"));
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleTimeZone", execResult("Asia/Tokyo\n"));
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleICUForce24HourTime", execResult("1\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.success).toBe(true);
      expect(result.locale).toBe("ja_JP");
      expect(result.timeZone).toBe("Asia/Tokyo");
      expect(result.timeFormat).toBe("24");
      expect(result.textDirection).toBeNull();
    });

    test("returns error for physical iOS device", async () => {
      const mgr = new SystemConfigurationManager(IOS_PHYSICAL, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
    });

    test("handles missing values gracefully", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.success).toBe(true);
      expect(result.locale).toBeNull();
      expect(result.timeZone).toBeNull();
      expect(result.timeFormat).toBeNull();
    });
  });

  // --- iOS Simulator: setCalendarSystem ---

  describe("iOS simulator setCalendarSystem", () => {
    test("writes AppleCalendar via defaults write and reads back", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleCalendar", execResult("japanese\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("japanese");

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("japanese");
      expect(
        fakeExec.wasCommandExecuted(
          `xcrun simctl spawn ${IOS_SIMULATOR.deviceId} defaults write .GlobalPreferences AppleCalendar japanese`
        )
      ).toBe(true);
    });

    test("reads previous calendar system before writing", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleCalendar", execResult("buddhist\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("buddhist");

      expect(result.success).toBe(true);
      expect(result.previousCalendarSystem).toBe("buddhist");
    });

    test("returns error when read-back does not match requested value", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleCalendar", execResult("gregory\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("buddhist");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Read-back verification failed");
      expect(result.calendarSystem).toBe("gregory");
    });

    test("returns error for empty calendarSystem", async () => {
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("calendarSystem must be a non-empty string");
    });

    test("returns error for physical iOS device", async () => {
      const mgr = new SystemConfigurationManager(IOS_PHYSICAL, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("japanese");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
    });

    test("returns error when defaults write fails", async () => {
      const originalExec = fakeExec.exec.bind(fakeExec);
      fakeExec.exec = async (command, options) => {
        if (command.includes("defaults write .GlobalPreferences AppleCalendar")) {
          throw new Error("simctl failed");
        }
        return originalExec(command, options);
      };

      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("japanese");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to set calendar system");
    });
  });

  // --- iOS Simulator: getCalendarSystem ---

  describe("iOS simulator getCalendarSystem", () => {
    test("reads AppleCalendar when available", async () => {
      fakeExec.setCommandResponse("defaults read .GlobalPreferences AppleCalendar", execResult("japanese\n"));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("japanese");
    });

    test("falls back to default calendar system", async () => {
      fakeExec.setDefaultResponse(execResult(""));
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("gregory");
      expect(result.source).toBe("default");
    });

    test("returns error for physical iOS device", async () => {
      const mgr = new SystemConfigurationManager(IOS_PHYSICAL, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
    });
  });

  // --- Android: existing behavior unchanged ---

  describe("Android setLocale still works", () => {
    test("uses adb commands for Android", async () => {
      fakeAdbClient.setCommandResult("shell getprop ro.build.version.sdk", "33");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("en-US");

      expect(result.success).toBe(true);
      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
      expect(fakeAdbClient.wasCommandExecuted("cmd locale set-locales en-US")).toBe(true);
    });
  });

  describe("Android setCalendarSystem", () => {
    test("writes calendar_type via adb and reads back", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "japanese");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("japanese");

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("japanese");
      expect(fakeAdbClient.wasCommandExecuted("settings put system calendar_type japanese")).toBe(true);
    });

    test("reads previous calendar system before writing", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "buddhist");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("buddhist");

      expect(result.success).toBe(true);
      expect(result.previousCalendarSystem).toBe("buddhist");
    });

    test("returns error when read-back does not match requested value", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "gregory");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("buddhist");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Read-back verification failed");
      expect(result.calendarSystem).toBe("gregory");
    });

    test("returns error for empty calendarSystem", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("calendarSystem must be a non-empty string");
    });
  });

  describe("Android setTimeZone still works", () => {
    test("uses adb commands for Android", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("America/New_York");

      expect(result.success).toBe(true);
      expect(fakeExec.getExecutedCommands()).toHaveLength(0);
      expect(fakeAdbClient.wasCommandExecuted("setprop persist.sys.timezone America/New_York")).toBe(true);
    });

    test("reads previous timezone before setting", async () => {
      fakeAdbClient.setCommandResult("shell getprop persist.sys.timezone", "America/Los_Angeles");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("Asia/Tokyo");

      expect(result.success).toBe(true);
      expect(result.previousZoneId).toBe("America/Los_Angeles");
    });

    test("returns error for empty zoneId", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("zoneId must be a non-empty string");
    });

    test("returns error when adb command fails", async () => {
      fakeAdbClient.setCommandError("shell setprop persist.sys.timezone Bad/Zone", new Error("setprop failed"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTimeZone("Bad/Zone");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to set time zone");
    });
  });

  // --- Android: set24HourFormat ---

  describe("Android set24HourFormat", () => {
    test("sets 24-hour mode", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(true);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(true);
      expect(fakeAdbClient.wasCommandExecuted("settings put system time_12_24 24")).toBe(true);
    });

    test("sets 12-hour mode", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(false);

      expect(result.success).toBe(true);
      expect(result.enabled).toBe(false);
      expect(fakeAdbClient.wasCommandExecuted("settings put system time_12_24 12")).toBe(true);
    });

    test("reads previous format before writing", async () => {
      fakeAdbClient.setCommandResult("shell settings get system time_12_24", "24");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(false);

      expect(result.success).toBe(true);
      expect(result.previousFormat).toBe("24");
    });

    test("normalizes invalid previous format to null", async () => {
      fakeAdbClient.setCommandResult("shell settings get system time_12_24", "null");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(true);

      expect(result.success).toBe(true);
      expect(result.previousFormat).toBeNull();
    });

    test("returns error when adb command fails", async () => {
      fakeAdbClient.setCommandError("shell settings put system time_12_24 24", new Error("permission denied"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.set24HourFormat(true);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to set 24-hour format");
    });
  });

  // --- Android: setTextDirection ---

  describe("Android setTextDirection", () => {
    test("sets RTL on via debug.force_rtl when no previous setting exists", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true);

      expect(result.success).toBe(true);
      expect(result.rtl).toBe(true);
      expect(result.settings).toContain("debug.force_rtl");
      expect(fakeAdbClient.wasCommandExecuted("settings put global debug.force_rtl 1")).toBe(true);
    });

    test("sets LTR (RTL off) via debug.force_rtl", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(false);

      expect(result.success).toBe(true);
      expect(result.rtl).toBe(false);
      expect(fakeAdbClient.wasCommandExecuted("settings put global debug.force_rtl 0")).toBe(true);
    });

    test("sets both debug.force_rtl and force_rtl when both exist", async () => {
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "0");
      fakeAdbClient.setCommandResult("shell settings get global force_rtl", "0");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true);

      expect(result.success).toBe(true);
      expect(result.settings).toContain("debug.force_rtl");
      expect(result.settings).toContain("force_rtl");
      expect(fakeAdbClient.wasCommandExecuted("settings put global debug.force_rtl 1")).toBe(true);
      expect(fakeAdbClient.wasCommandExecuted("settings put global force_rtl 1")).toBe(true);
    });

    test("sets only force_rtl when debug.force_rtl is absent", async () => {
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "null");
      fakeAdbClient.setCommandResult("shell settings get global force_rtl", "1");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(false);

      expect(result.success).toBe(true);
      expect(result.settings).toEqual(["force_rtl"]);
      expect(fakeAdbClient.wasCommandExecuted("settings put global force_rtl 0")).toBe(true);
    });

    test("reads previous RTL state from debug.force_rtl", async () => {
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "1");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(false);

      expect(result.success).toBe(true);
      expect(result.previousRtl).toBe(true);
    });

    test("falls back to force_rtl for previous state when debug.force_rtl is null", async () => {
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "null");
      fakeAdbClient.setCommandResult("shell settings get global force_rtl", "0");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true);

      expect(result.success).toBe(true);
      expect(result.previousRtl).toBe(false);
    });

    test("broadcasts locale change by default", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true);

      expect(result.success).toBe(true);
      expect(result.broadcasted).toBe(true);
      expect(fakeAdbClient.wasCommandExecuted("am broadcast -a android.intent.action.LOCALE_CHANGED")).toBe(true);
    });

    test("skips broadcast when broadcast option is false", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true, { broadcast: false });

      expect(result.success).toBe(true);
      expect(result.broadcasted).toBe(false);
      expect(fakeAdbClient.wasCommandExecuted("am broadcast")).toBe(false);
    });

    test("returns error when all settings put commands fail", async () => {
      fakeAdbClient.setCommandError("shell settings put global debug.force_rtl 1", new Error("fail"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setTextDirection(true);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to update RTL settings");
    });
  });

  // --- Android: broadcastLocaleChange ---

  describe("Android broadcastLocaleChange", () => {
    test("sends locale changed broadcast", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.broadcastLocaleChange();

      expect(result).toBe(true);
      expect(fakeAdbClient.wasCommandExecuted("am broadcast -a android.intent.action.LOCALE_CHANGED")).toBe(true);
    });

    test("returns false when broadcast fails", async () => {
      fakeAdbClient.setCommandError("shell am broadcast -a android.intent.action.LOCALE_CHANGED", new Error("broadcast failed"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.broadcastLocaleChange();

      expect(result).toBe(false);
    });

    test("returns false for non-android device", async () => {
      const mgr = new SystemConfigurationManager(IOS_SIMULATOR, fakeAdbFactory, fakeExec);
      const result = await mgr.broadcastLocaleChange();

      expect(result).toBe(false);
    });
  });

  // --- Android: setLocale fallback paths ---

  describe("Android setLocale fallback", () => {
    test("tries cmd locale first on API 31+", async () => {
      fakeAdbClient.setCommandResult("shell getprop ro.build.version.sdk", "33");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-locales");
      expect(fakeAdbClient.wasCommandExecuted("cmd locale set-locales ja-JP")).toBe(true);
    });

    test("falls back to settings put when cmd locale fails on API 31+", async () => {
      fakeAdbClient.setCommandResult("shell getprop ro.build.version.sdk", "33");
      fakeAdbClient.setCommandError("shell cmd locale set-locales ja-JP", new Error("cmd not found"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.method).toBe("settings put system user_locale");
      expect(fakeAdbClient.wasCommandExecuted("settings put system user_locale ja-JP")).toBe(true);
    });

    test("tries settings put first on API < 31", async () => {
      fakeAdbClient.setCommandResult("shell getprop ro.build.version.sdk", "28");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.method).toBe("settings put system user_locale");
    });

    test("falls back to cmd locale when settings put fails on API < 31", async () => {
      fakeAdbClient.setCommandResult("shell getprop ro.build.version.sdk", "28");
      fakeAdbClient.setCommandError("shell settings put system user_locale ja-JP", new Error("settings fail"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.method).toBe("cmd locale set-locales");
    });

    test("returns error when both commands fail", async () => {
      fakeAdbClient.setCommandResult("shell getprop ro.build.version.sdk", "33");
      fakeAdbClient.setCommandError("shell cmd locale set-locales ja-JP", new Error("cmd fail"));
      fakeAdbClient.setCommandError("shell settings put system user_locale ja-JP", new Error("settings fail"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to set locale");
      expect(result.error).toContain("settings fail");
    });

    test("reads previous locale from system_locales", async () => {
      fakeAdbClient.setCommandResult("shell settings get system system_locales", "en-US,fr-FR");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP");

      expect(result.success).toBe(true);
      expect(result.previousLanguageTag).toBe("en-US");
    });

    test("broadcasts locale change by default", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      await mgr.setLocale("ja-JP");

      expect(fakeAdbClient.wasCommandExecuted("am broadcast -a android.intent.action.LOCALE_CHANGED")).toBe(true);
    });

    test("skips broadcast when option is false", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("ja-JP", { broadcast: false });

      expect(result.success).toBe(true);
      expect(result.broadcasted).toBe(false);
      expect(fakeAdbClient.wasCommandExecuted("am broadcast")).toBe(false);
    });

    test("returns error for empty languageTag", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setLocale("  ");

      expect(result.success).toBe(false);
      expect(result.error).toBe("languageTag must be a non-empty string");
    });
  });

  // --- Android: getLocalizationSettings ---

  describe("Android getLocalizationSettings", () => {
    test("reads all localization settings", async () => {
      fakeAdbClient.setCommandResult("shell settings get system system_locales", "en-US");
      fakeAdbClient.setCommandResult("shell getprop persist.sys.timezone", "America/New_York");
      fakeAdbClient.setCommandResult("shell settings get system time_12_24", "24");
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "1");
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "gregory");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.success).toBe(true);
      expect(result.locale).toBe("en-US");
      expect(result.timeZone).toBe("America/New_York");
      expect(result.timeFormat).toBe("24");
      expect(result.textDirection).toBe("rtl");
      expect(result.calendarSystem).toBe("gregory");
    });

    test("detects LTR from debug.force_rtl=0", async () => {
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "0");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.textDirection).toBe("ltr");
    });

    test("falls back to force_rtl when debug.force_rtl is null", async () => {
      fakeAdbClient.setCommandResult("shell settings get global debug.force_rtl", "null");
      fakeAdbClient.setCommandResult("shell settings get global force_rtl", "1");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.textDirection).toBe("rtl");
    });

    test("returns null textDirection when neither RTL setting exists", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.textDirection).toBeNull();
    });

    test("reads locale from user_locale when system_locales is absent", async () => {
      fakeAdbClient.setCommandResult("shell settings get system user_locale", "fr-FR");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.locale).toBe("fr-FR");
    });

    test("reads locale from persist.sys.locale as last resort", async () => {
      fakeAdbClient.setCommandResult("shell getprop persist.sys.locale", "de-DE");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.locale).toBe("de-DE");
    });

    test("constructs locale from language+country props", async () => {
      fakeAdbClient.setCommandResult("shell getprop persist.sys.language", "pt");
      fakeAdbClient.setCommandResult("shell getprop persist.sys.country", "BR");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.locale).toBe("pt-BR");
    });

    test("returns language alone when country is absent", async () => {
      fakeAdbClient.setCommandResult("shell getprop persist.sys.language", "pt");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.locale).toBe("pt");
    });

    test("handles all missing values gracefully", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getLocalizationSettings();

      expect(result.success).toBe(true);
      expect(result.locale).toBeNull();
      expect(result.timeZone).toBeNull();
      expect(result.timeFormat).toBeNull();
      expect(result.textDirection).toBeNull();
    });
  });

  // --- Android: getCalendarSystem ---

  describe("Android getCalendarSystem", () => {
    test("returns calendar from settings when available", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "japanese");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("japanese");
      expect(result.source).toBe("settings.calendar_type");
    });

    test("falls back to locale @calendar keyword", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "null");
      fakeAdbClient.setCommandResult("shell settings get system system_locales", "fa-IR@calendar=persian");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("persian");
      expect(result.source).toBe("locale");
    });

    test("falls back to BCP-47 -u-ca- extension", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "null");
      fakeAdbClient.setCommandResult("shell settings get system system_locales", "th-TH-u-ca-buddhist");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("buddhist");
      expect(result.source).toBe("locale");
    });

    test("falls back to default gregory when no calendar info found", async () => {
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("gregory");
      expect(result.source).toBe("default");
    });

    test("falls back to default when locale has no calendar extension", async () => {
      fakeAdbClient.setCommandResult("shell settings get system calendar_type", "null");
      fakeAdbClient.setCommandResult("shell settings get system system_locales", "en-US");
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.getCalendarSystem();

      expect(result.success).toBe(true);
      expect(result.calendarSystem).toBe("gregory");
      expect(result.source).toBe("default");
      expect(result.locale).toBe("en-US");
    });

    test("returns error when adb put command fails", async () => {
      fakeAdbClient.setCommandError("shell settings put system calendar_type islamic", new Error("write denied"));
      const mgr = new SystemConfigurationManager(ANDROID_DEVICE, fakeAdbFactory, fakeExec);
      const result = await mgr.setCalendarSystem("islamic");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to set calendar system");
    });
  });
});
