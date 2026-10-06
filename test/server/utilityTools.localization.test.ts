import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { SystemConfigurationManager } from "../../src/features/utility/SystemConfigurationManager";
import type { BootedDevice, SetLocaleResult } from "../../src/models";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

describe("changeLocalization handler", () => {
  const calls: unknown[][] = [];
  let success: boolean;
  let error: string | undefined;
  let localeResult: Partial<SetLocaleResult>;
  let restore: () => void;

  beforeEach(() => {
    calls.length = 0;
    success = true;
    error = undefined;
    localeResult = {};
    const manager = SystemConfigurationManager.prototype;
    const spies = [
      spyOn(defaultAdbClientFactory, "create").mockReturnValue(new FakeAdbExecutor()),
      spyOn(manager, "setLocale").mockImplementation(async (languageTag, options) => {
        calls.push(["locale", languageTag, options]);
        return { success, languageTag, error, ...localeResult };
      }),
      spyOn(manager, "setTimeZone").mockImplementation(async (zoneId) => {
        calls.push(["timeZone", zoneId]);
        return { success, zoneId, error };
      }),
      spyOn(manager, "setTextDirection").mockImplementation(async (rtl, options) => {
        calls.push(["direction", rtl, options]);
        return { success, rtl, error };
      }),
      spyOn(manager, "set24HourFormat").mockImplementation(async (enabled) => {
        calls.push(["format", enabled]);
        return { success, enabled, error };
      }),
      spyOn(manager, "setCalendarSystem").mockImplementation(async (calendarSystem) => {
        calls.push(["calendar", calendarSystem]);
        return { success, calendarSystem, error };
      }),
      spyOn(manager, "broadcastLocaleChange").mockImplementation(async () => {
        calls.push(["broadcast"]);
        return true;
      }),
      spyOn(manager, "applyIosLiveChanges").mockImplementation(async (app) => {
        calls.push(["live", app]);
        return { springBoardRestarted: true, notificationPosted: true, appRestarted: true };
      }),
    ];
    restore = () => spies.forEach((spy) => spy.mockRestore());
    registerUtilityTools();
  });
  afterEach(() => restore());

  async function callRaw(platform: "android" | "ios", args: object) {
    const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform };
    return await ToolRegistry.getTool("changeLocalization")!.deviceAwareHandler!(device, args);
  }

  async function call(platform: "android" | "ios", args: object) {
    const response = await callRaw(platform, args);
    return JSON.parse(response.content[0].text!);
  }

  test("applies Android fields in order and broadcasts once", async () => {
    localeResult = { localeScope: "system", method: "cmd locale set-app-locales" };
    expect(
      await call("android", {
        locale: "ar-SA",
        appId: "com.example.app",
        timeZone: "UTC",
        textDirection: "rtl",
        timeFormat: "24",
        calendarSystem: "gregory",
      }),
    ).toEqual({
      success: true,
      changes: {
        locale: "ar-SA",
        timeZone: "UTC",
        textDirection: "rtl",
        timeFormat: "24",
        calendarSystem: "gregory",
      },
      intentBroadcast: true,
      localeScope: "system",
      localeAppId: "com.example.app",
      localeMethod: "cmd locale set-app-locales",
    });
    expect(calls).toEqual([
      ["locale", "ar-SA", { broadcast: false, appId: "com.example.app" }],
      ["timeZone", "UTC"],
      ["direction", true, { broadcast: false }],
      ["format", true],
      ["calendar", "gregory"],
      ["broadcast"],
    ]);
  });

  test("surfaces a locale warning from the adapter on a successful change", async () => {
    localeResult = {
      method: "cmd locale set-app-locales com.example.app --user 0",
      warning: "assumed user 0",
    };
    const result = await call("android", { locale: "en-US", appId: "com.example.app" });
    expect(result.success).toBe(true);
    expect(result.warning).toBe("assumed user 0");
  });

  test("adds no warning field when the adapter reports none", async () => {
    const result = await call("android", { locale: "en-US", appId: "com.example.app" });
    expect("warning" in result).toBe(false);
  });

  test.each([
    undefined,
    "cmd locale set-app-locales com.example.app",
    "settings put system system_locales",
  ])("infers Android locale scope from method %s", async (method) => {
    localeResult = { method };
    const result = await call("android", { locale: "en-US", appId: "com.example.app" });
    expect(result.localeScope).toBe(
      method?.startsWith("cmd locale set-app-locales") ? "app" : "system",
    );
    expect(result.localeAppId).toBe("com.example.app");
    expect(calls).toEqual([
      ["locale", "en-US", { broadcast: false, appId: "com.example.app" }],
      ["broadcast"],
    ]);
  });

  test("applies iOS fields before live changes and threads restartApp", async () => {
    const result = await call("ios", {
      locale: "en-US",
      textDirection: "ltr",
      timeFormat: "12",
      restartApp: "com.example.app",
    });
    expect(result).toEqual({
      success: true,
      changes: { locale: "en-US", textDirection: "ltr", timeFormat: "12" },
      intentBroadcast: false,
      localeScope: "system",
      iosLiveChanges: { springBoardRestarted: true, notificationPosted: true, appRestarted: true },
    });
    expect(calls).toEqual([
      ["locale", "en-US", { broadcast: false }],
      ["direction", false, { broadcast: false }],
      ["format", false],
      ["live", "com.example.app"],
    ]);
  });

  test.each([undefined, "adapter failure"])(
    "aggregates failures without broadcasting (%s)",
    async (message) => {
      success = false;
      error = message;
      const result = await call("android", {
        locale: "en-US",
        appId: "com.example.app",
        timeZone: "UTC",
        textDirection: "ltr",
        timeFormat: "12",
        calendarSystem: "gregory",
      });
      expect(result).toEqual({
        success: false,
        changes: {},
        intentBroadcast: false,
        error: message
          ? Array(5).fill(message).join("; ")
          : "Failed to set locale; Failed to set time zone; Failed to set text direction; Failed to set time format; Failed to set calendar system",
      });
      expect(calls.map(([name]) => name)).toEqual([
        "locale",
        "timeZone",
        "direction",
        "format",
        "calendar",
      ]);
    },
  );

  test("broadcasts successful changes even when another field fails", async () => {
    success = false;
    localeResult = { success: true, languageTag: "en-GB" };
    const result = await call("android", {
      locale: "en-US",
      appId: "com.example.app",
      timeZone: "UTC",
    });
    expect(result).toEqual({
      success: false,
      changes: { locale: "en-GB" },
      intentBroadcast: true,
      localeScope: "system",
      localeAppId: "com.example.app",
      error: "Failed to set time zone",
    });
    expect(calls.map(([name]) => name)).toEqual(["locale", "timeZone", "broadcast"]);
  });

  test("a failed change sets isError and keeps the payload unchanged (issue #10013)", async () => {
    success = false;
    error = "Android API 30 does not support app-scoped locale changes";
    const response = await callRaw("android", { locale: "ja-JP", appId: "com.example.app" });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text!)).toEqual({
      success: false,
      changes: {},
      intentBroadcast: false,
      error: "Android API 30 does not support app-scoped locale changes",
    });
  });

  test("a partial failure sets isError while keeping the applied changes", async () => {
    success = false;
    localeResult = { success: true, languageTag: "en-GB" };
    const response = await callRaw("android", {
      locale: "en-US",
      appId: "com.example.app",
      timeZone: "UTC",
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text!).changes).toEqual({ locale: "en-GB" });
  });

  test("a successful change does not set isError", async () => {
    const response = await callRaw("android", { timeZone: "UTC" });
    expect(response.isError).toBeUndefined();
    expect(JSON.parse(response.content[0].text!).success).toBe(true);
  });

  test("empty input neither mutates settings nor broadcasts", async () => {
    expect(await call("android", {})).toEqual({
      success: true,
      changes: {},
      intentBroadcast: false,
    });
    expect(calls).toEqual([]);
  });

  test("rejects invalid app locale targeting before mutation", async () => {
    await expect(call("ios", { locale: "en-US", appId: "com.example.app" })).rejects.toThrow();
    await expect(call("android", { locale: "en-US" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
