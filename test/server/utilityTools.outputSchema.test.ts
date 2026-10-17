import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerUtilityTools } from "../../src/server/utilityTools";
import {
  changeLocalizationResultSchema,
  displayConfigResultSchema,
  setActiveDeviceResultSchema,
} from "../../src/server/utilityToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DisplayConfig, type DisplayConfigResult } from "../../src/features/utility/DisplayConfig";
import { SystemConfigurationManager } from "../../src/features/utility/SystemConfigurationManager";
import type { BootedDevice } from "../../src/models";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { installFakeDeviceToolProviders } from "../helpers/hermeticDeviceTools";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };

describe("utility tool output schemas (#11830)", () => {
  let restore: () => void;
  let timeZoneSucceeds: boolean;
  let displayResult: DisplayConfigResult;

  beforeEach(() => {
    timeZoneSucceeds = true;
    displayResult = {
      success: true,
      deviceId: device.deviceId,
      platform: "android",
      supported: { fontScale: true, density: "partial", theme: true },
      current: { fontScale: "default", density: "default", theme: "light" },
    };
    const restoreProviders = installFakeDeviceToolProviders();
    const spies = [
      spyOn(defaultAdbClientFactory, "create").mockReturnValue(new FakeAdbExecutor()),
      spyOn(SystemConfigurationManager.prototype, "setTimeZone").mockImplementation(
        async (zoneId) =>
          timeZoneSucceeds ? { success: true, zoneId } : { success: false, zoneId, error: "nope" },
      ),
      spyOn(SystemConfigurationManager.prototype, "broadcastLocaleChange").mockResolvedValue(true),
      spyOn(DisplayConfig.prototype, "getConfig").mockImplementation(async () => displayResult),
    ];
    restore = () => {
      spies.forEach((spy) => spy.mockRestore());
      restoreProviders();
    };
    registerUtilityTools();
  });
  afterEach(() => restore());

  test.each([
    ["changeLocalization", changeLocalizationResultSchema],
    ["displayConfig", displayConfigResultSchema],
    ["setActiveDevice", setActiveDeviceResultSchema],
  ])("%s declares its outputSchema", (name, schema) => {
    expect(ToolRegistry.getTool(name)?.outputSchema).toBe(schema);
  });

  test("changeLocalization success keeps the text payload and validates", async () => {
    const response = await ToolRegistry.getTool("changeLocalization")!.deviceAwareHandler!(device, {
      timeZone: "UTC",
    });
    const expected = { success: true, changes: { timeZone: "UTC" }, intentBroadcast: true };
    expect(response.content[0].text).toBe(JSON.stringify(expected));
    expect(response.isError).toBeUndefined();
    expect(changeLocalizationResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("changeLocalization failure keeps isError and the payload and validates", async () => {
    timeZoneSucceeds = false;
    const response = await ToolRegistry.getTool("changeLocalization")!.deviceAwareHandler!(device, {
      timeZone: "UTC",
    });
    expect(response.content[0].text).toBe(
      JSON.stringify({ success: false, changes: {}, intentBroadcast: false, error: "nope" }),
    );
    expect(response.isError).toBe(true);
    expect(changeLocalizationResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("changeLocalization accepts iOS live changes and locale metadata", () => {
    expect(
      changeLocalizationResultSchema.safeParse({
        success: true,
        changes: { locale: "ja-JP", textDirection: "rtl", timeFormat: "24" },
        intentBroadcast: false,
        localeScope: "app",
        localeAppId: "com.example.app",
        iosLiveChanges: { springBoardRestarted: true, notificationPosted: true },
      }).success,
    ).toBe(true);
    expect(changeLocalizationResultSchema.safeParse({ success: true }).success).toBe(false);
  });

  test("displayConfig read keeps the text payload and validates", async () => {
    const response = await ToolRegistry.getTool("displayConfig")!.deviceAwareHandler!(device, {});
    expect(response.content[0].text).toBe(
      JSON.stringify({ message: "Read display configuration", ...displayResult }),
    );
    expect(response.isError).toBeUndefined();
    expect(displayConfigResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("displayConfig failure keeps isError and validates", async () => {
    displayResult = {
      success: false,
      deviceId: device.deviceId,
      platform: "ios",
      supported: { fontScale: false, density: false, theme: false },
      error: "unsupported",
    };
    const response = await ToolRegistry.getTool("displayConfig")!.deviceAwareHandler!(device, {});
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text!).message).toBe("unsupported");
    expect(displayConfigResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("setActiveDevice accepts a pinned, cleared and absent displayPin", () => {
    const base = { message: "Active device set to 'emulator-5554'", deviceId: "emulator-5554" };
    expect(setActiveDeviceResultSchema.safeParse(base).success).toBe(true);
    expect(
      setActiveDeviceResultSchema.safeParse({ ...base, sessionUuid: "s", displayPin: "inner" })
        .success,
    ).toBe(true);
    expect(setActiveDeviceResultSchema.safeParse({ ...base, displayPin: null }).success).toBe(true);
    expect(setActiveDeviceResultSchema.safeParse({ deviceId: "x" }).success).toBe(false);
  });
});
