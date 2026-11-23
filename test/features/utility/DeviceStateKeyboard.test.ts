import { describe, expect, test } from "bun:test";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import { keyboardStateInputSchema } from "../../../src/features/utility/device-state/KeyboardState";
import type { BootedDevice } from "../../../src/models";
import { FakeSimulatorKeyboardBridge } from "../../fakes/FakeSimulatorKeyboardBridge";

const SIMULATOR: BootedDevice = {
  name: "iPhone 17 Pro",
  platform: "ios",
  deviceId: "85E99D67-7088-4999-89CB-3C06DBE410BF",
};
const PHYSICAL: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008140-001A2B3C4D5E6F70",
};
const ANDROID: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5560" };

describe("setDeviceState keyboard (#19017)", () => {
  test("disconnects the hardware keyboard and selects a language on a simulator", async () => {
    const bridge = new FakeSimulatorKeyboardBridge();
    const result = await new DeviceState(SIMULATOR, { simulatorKeyboard: bridge }).setState({
      keyboard: { hardwareKeyboard: false, language: "fr_FR" },
    });
    expect(result.success).toBe(true);
    expect(result.keyboard).toEqual({
      supported: true,
      method: "ios_simulator_coresimulator",
      hardwareKeyboard: false,
      hardwareLayout: "ansi",
      language: "fr_FR",
    });
    expect(bridge.calls).toEqual([
      { call: "hardware", udid: SIMULATOR.deviceId, connected: false, layout: "ansi" },
      { call: "language", udid: SIMULATOR.deviceId, language: "fr_FR" },
    ]);
  });

  test("a requested layout is passed to CoreSimulator", async () => {
    const bridge = new FakeSimulatorKeyboardBridge();
    await new DeviceState(SIMULATOR, { simulatorKeyboard: bridge }).setState({
      keyboard: { hardwareKeyboard: true, hardwareLayout: "jis" },
    });
    expect(bridge.calls).toEqual([
      { call: "hardware", udid: SIMULATOR.deviceId, connected: true, layout: "jis" },
    ]);
  });

  test("a CoreSimulator failure fails the call and keeps what was applied", async () => {
    const bridge = new FakeSimulatorKeyboardBridge();
    const state = new DeviceState(SIMULATOR, { simulatorKeyboard: bridge });
    bridge.failWith = new Error('CoreSimulator has no keyboard for language "zz"');
    const result = await state.setState({ keyboard: { language: "zz" } });
    expect(result.success).toBe(false);
    expect(result.keyboard?.error).toContain("no keyboard for language");
    expect(result.error).toContain("no keyboard for language");
  });

  test.each([
    ["a physical iPhone", PHYSICAL],
    ["Android", ANDROID],
  ])("%s is unsupported and never calls CoreSimulator", async (_label, device) => {
    const bridge = new FakeSimulatorKeyboardBridge();
    const result = await new DeviceState(device, { simulatorKeyboard: bridge }).setState({
      keyboard: { hardwareKeyboard: false },
    });
    expect(result.success).toBe(false);
    expect(result.keyboard?.supported).toBe(false);
    expect(bridge.calls).toHaveLength(0);
  });

  test("the input needs a setting, and a layout only with hardwareKeyboard", () => {
    expect(keyboardStateInputSchema.safeParse({}).success).toBe(false);
    expect(keyboardStateInputSchema.safeParse({ hardwareLayout: "iso" }).success).toBe(false);
    expect(keyboardStateInputSchema.safeParse({ language: "en US" }).success).toBe(false);
    expect(
      keyboardStateInputSchema.safeParse({ hardwareKeyboard: true, hardwareLayout: "iso" }).success,
    ).toBe(true);
    expect(keyboardStateInputSchema.safeParse({ language: "ja_JP-Kana" }).success).toBe(true);
  });
});
