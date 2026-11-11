import { describe, expect, test } from "bun:test";
import {
  createGlassesInputHandler,
  glassesInputSchema,
  glassesInputResultSchema,
  traitsGlassesCheck,
} from "../../src/server/glassesInputTool";
import { AdbGlassesInputInjector } from "../../src/features/xr/GlassesInput";
import { FakeDeviceTraits, androidDeviceTraits } from "../fakes/FakeDeviceTraits";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { DEVICE_TRAITS_TIMEOUT_MS } from "../../src/server/bootedDeviceTraits";
import { ActionableError, type BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { toolJson } from "../helpers/toolResponse";

const android: BootedDevice = { name: "Glasses", deviceId: "emulator-5554", platform: "android" };
function setup(glasses: boolean | undefined = true, output = "") {
  const calls: string[] = [];
  const checks: string[] = [];
  const handler = createGlassesInputHandler(
    () =>
      new AdbGlassesInputInjector({
        executeCommand: async (command) => {
          calls.push(command);
          return createExecResult(output, "");
        },
      }),
    async (device) => {
      checks.push(device.deviceId);
      return glasses;
    },
  );
  return { calls, checks, handler };
}

describe("glassesInput tool", () => {
  test("returns the full structured result with defaults and no warning", async () => {
    const { handler, calls } = setup();
    const json = toolJson(await handler(android, { gesture: "swipeForward" }));
    expect(json).toMatchObject({
      success: true,
      gesture: "swipeForward",
      axis: "vertical",
      count: 1,
      keyCodes: ["KEYCODE_DPAD_DOWN"],
      commands: ["shell input keyevent KEYCODE_DPAD_DOWN"],
    });
    expect(json.message).toContain("No read-back");
    expect(json).not.toHaveProperty("warningCode");
    expect(calls).toHaveLength(1);
    expect(glassesInputResultSchema.safeParse(json).success).toBe(true);
  });
  for (const glasses of [false, undefined]) {
    test(`unconfirmed identity ${glasses} warns but sends input`, async () => {
      // Pass through undefined explicitly; setup's default represents confirmed glasses.
      const { handler, calls } = setup(false);
      const actualHandler =
        glasses === undefined
          ? createGlassesInputHandler(
              () =>
                new AdbGlassesInputInjector({
                  executeCommand: async (command) => {
                    calls.push(command);
                    return createExecResult("", "");
                  },
                }),
              async () => undefined,
            )
          : handler;
      const json = toolJson(
        await actualHandler(android, { gesture: "tap", count: 20, axis: "horizontal" }),
      );
      expect(json.warningCode).toBe(glasses === false ? "not_glasses" : "traits_unavailable");
      expect(json.success).toBe(true);
      expect(calls).toHaveLength(20);
    });
  }
  test("command rejection marks the tool response as an error", async () => {
    const { handler } = setup(true, "Error: denied");
    const response = await handler(android, { gesture: "tap" });
    expect(response.isError).toBe(true);
    expect(glassesInputResultSchema.safeParse(toolJson(response)).success).toBe(true);
  });
  test("rejects iOS before traits or input", async () => {
    const { handler, checks, calls } = setup();
    await expect(
      handler({ ...android, platform: "ios" }, { gesture: "tap" }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(checks).toEqual([]);
    expect(calls).toEqual([]);
  });
  test("validates gestures, axes and bounded integer counts including tap", () => {
    for (const count of [1, 20]) {
      expect(glassesInputSchema.safeParse({ gesture: "tap", count }).success).toBe(true);
    }
    for (const count of [0, 21, 1.5, "2", null]) {
      expect(glassesInputSchema.safeParse({ gesture: "tap", count }).success).toBe(false);
    }
    for (const gesture of ["longPress", "twoFingerTap", "twoFingerSwipe", "other"]) {
      expect(glassesInputSchema.safeParse({ gesture }).success).toBe(false);
    }
    expect(glassesInputSchema.safeParse({ gesture: "tap", axis: "other" }).success).toBe(false);
    expect(
      glassesInputResultSchema.safeParse({
        success: true,
        message: "ok",
        gesture: "tap",
        axis: "vertical",
        count: 1,
        commands: [],
        keyCodes: [],
        warningCode: "other",
      }).success,
    ).toBe(false);
  });
});

describe("traitsGlassesCheck", () => {
  test("reads through the shared traits seam with the existing timeout", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits({ formFactor: "xr-glasses" }));
    expect(await traitsGlassesCheck(traits, new FakeAdbClientFactory())(android)).toBe(true);
    expect(traits.reads).toEqual([
      { deviceId: android.deviceId, options: { timeoutMs: DEVICE_TRAITS_TIMEOUT_MS } },
    ]);
  });
  test("watch traits are disambiguated by existing profile/runtime identity", async () => {
    const check = traitsGlassesCheck(
      new FakeDeviceTraits(androidDeviceTraits({ formFactor: "watch" })),
      new FakeAdbClientFactory(),
    );
    for (const metadata of [
      { deviceType: "ai_glasses_device" },
      { runtimeId: "system-images;android-36;ai-glasses;arm64-v8a" },
      { formFactor: "xr-glasses" as const },
    ]) {
      expect(await check({ ...android, ...metadata })).toBe(true);
    }
    expect(await check({ ...android, deviceType: "wearos_small_round" })).toBe(false);
  });
  test("a watch-trait device whose product device names glasses is glasses", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell getprop ro.product.device", "sdk_glasses_arm64\n");
    const check = traitsGlassesCheck(
      new FakeDeviceTraits(androidDeviceTraits({ formFactor: "watch" })),
      new FakeAdbClientFactory(adb),
    );
    expect(await check(android)).toBe(true);
    adb.setCommandResult("shell getprop ro.product.device", "sdk_gwear_arm64\n");
    expect(await check(android)).toBe(false);
  });
  test("phones are not glasses and failed traits are unavailable", async () => {
    const traits = new FakeDeviceTraits(androidDeviceTraits());
    const check = traitsGlassesCheck(traits, new FakeAdbClientFactory());
    expect(await check(android)).toBe(false);
    traits.setTraits(new Error("getprop timed out"));
    expect(await check(android)).toBeUndefined();
    expect(await check({ ...android, deviceType: "ai_glasses_device" })).toBe(true);
  });
});
