import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DisplayConfig } from "../../../src/features/utility/DisplayConfig";
import type { SimCtl } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../fakes/FakeTimer";

const simulator: BootedDevice = {
  name: "iPhone 17 Pro",
  platform: "ios",
  deviceId: "994D7AD5-32E6-43AA-BB3E-CE61A8D277A1",
};

/** Appearance, the SpringBoard island default and the blanked-screen state of one Simulator. */
class FakeSimulator implements Pick<SimCtl, "executeCommandArgs"> {
  appearance = "light";
  suppressed = false;
  blanked = false;
  readonly calls: string[][] = [];

  executeCommandArgs: SimCtl["executeCommandArgs"] = async (args) => {
    this.calls.push(args);
    if (args[0] === "ui" && args[2] === "appearance") {
      this.appearance = args[3] ?? this.appearance;
      return createExecResult(`${this.appearance}\n`, "");
    }
    if (args[0] === "ui" && args[2] === "content_size") {
      return createExecResult("large\n", "");
    }
    if (args[2] === "notifyutil") {
      return createExecResult(`com.apple.springboard.hasBlankedScreen ${this.blanked ? 1 : 0}`, "");
    }
    if (args[2] === "defaults" && args[3] === "read" && args[4] === "com.apple.springboard") {
      return createExecResult(this.suppressed ? "1\n" : "0\n", "");
    }
    if (args[2] === "defaults" && args[4] === "com.apple.springboard") {
      this.suppressed = args[3] === "write";
      return createExecResult("", "");
    }
    // The accessibility preference reads have nothing to report here.
    throw new Error(`unexpected simctl ${args.join(" ")}`);
  };
}

function config(device: BootedDevice, simctl: FakeSimulator) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new DisplayConfig(device, {
    simctl,
    adbFactory: new FakeAdbClientFactory(),
    contentSizeBaselines: new Map(),
    accessibilityBaselines: new Map(),
    screenControls: {
      timer,
      backlight: {
        setActive: async (_udid, active) => {
          simctl.blanked = !active;
        },
      },
    },
  });
}

describe("displayConfig Dynamic Island and backlight (#19018)", () => {
  test("reads both on the Simulator and reports them supported", async () => {
    const result = await config(simulator, new FakeSimulator()).getConfig();

    expect(result.current).toMatchObject({ dynamicIsland: "visible", backlight: true });
    expect(result.supported).toMatchObject({ dynamicIsland: true, backlight: true });
  });

  test("applies the island and backlight beside a theme and returns the previous values", async () => {
    const simctl = new FakeSimulator();

    const result = await config(simulator, simctl).setConfig({
      theme: "dark",
      dynamicIsland: "hidden",
      backlight: false,
    });

    expect(result.success).toBe(true);
    expect(result.applied).toMatchObject({
      theme: "dark",
      dynamicIsland: "hidden",
      backlight: false,
    });
    expect(result.previous).toMatchObject({
      theme: "light",
      dynamicIsland: "visible",
      backlight: true,
    });
  });

  test("reset shows the island and relights the display", async () => {
    const simctl = new FakeSimulator();
    simctl.suppressed = true;
    simctl.blanked = true;

    const result = await config(simulator, simctl).setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(result.applied).toMatchObject({ dynamicIsland: "visible", backlight: true });
  });

  test("reset combined with dynamicIsland is contradictory", async () => {
    const result = await config(simulator, new FakeSimulator()).setConfig({
      reset: true,
      dynamicIsland: "hidden",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reset cannot be combined");
  });

  test("Android and physical iOS refuse both before any device command", async () => {
    const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
    const physical: BootedDevice = { ...simulator, deviceId: "00008130-001234567890ABCD" };
    for (const device of [android, physical]) {
      const simctl = new FakeSimulator();
      const result = await config(device, simctl).setConfig({ backlight: false });

      expect(result.success).toBe(false);
      expect(result.error).toContain("iOS Simulator only");
      expect(simctl.calls).toEqual([]);
    }
  });
});
