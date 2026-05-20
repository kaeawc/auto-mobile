import { describe, it, expect, beforeEach } from "bun:test";
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

    it("sets the system time zone via setprop", async () => {
      const adb = new FakeAdbClient();
      const adapter = new AndroidSystemConfigurationAdapter(androidDevice, adb as any);
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(true);
      expect(result.zoneId).toBe("Asia/Tokyo");
      const recorded = (adb as any).commandCalls;
      expect(
        recorded.some((c: { command: string }) =>
          c.command.includes("setprop persist.sys.timezone Asia/Tokyo")
        )
      ).toBe(true);
    });
  });

  describe("IosSystemConfigurationAdapter behavior", () => {
    it("rejects locale changes on physical devices", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setLocale("ja-JP", {});
      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
    });

    it("rejects time-zone changes on physical devices", async () => {
      const adapter = new IosSystemConfigurationAdapter(iosPhysical, new FakeProcessExecutor());
      const result = await adapter.setTimeZone("Asia/Tokyo");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Localization changes are only supported on iOS Simulator.");
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
      const adapter = new IosSystemConfigurationAdapter(iosSimulator, exec);
      const result = await adapter.setLocale("ja-JP", {});

      expect(result.success).toBe(true);
      expect(
        exec.wasCommandExecuted(
          `xcrun simctl spawn ${iosSimulator.deviceId} defaults write .GlobalPreferences AppleLocale ja_JP`
        )
      ).toBe(true);
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
