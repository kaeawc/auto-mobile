import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import type { AccessibilityDisplaySnapshot } from "../../../src/features/utility/AccessibilityDisplayPreferences";
import { DisplayConfig } from "../../../src/features/utility/DisplayConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeSimctl } from "../../fakes/FakeSimctl";

const androidEmulator: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  iosVersion: "17.5",
};

const CONTRAST_GET = "shell settings get secure high_text_contrast_enabled";
const ANIMATION_KEYS = [
  "window_animation_scale",
  "transition_animation_scale",
  "animator_duration_scale",
];

/** Seed the display-field reads and the accessibility reads at their unset defaults. */
function seededAndroid(): FakeAdbClientFactory {
  const factory = new FakeAdbClientFactory();
  const client = factory.getFakeClient();
  client.setCommandResult("shell settings get system font_scale", "1.0\n");
  client.setCommandResult("shell wm density", "Physical density: 440\n");
  client.setCommandResult("shell cmd uimode night", "Night mode: no\n");
  client.setCommandResult("shell getprop ro.build.version.sdk", "34\n");
  client.setCommandResult(CONTRAST_GET, "null\n");
  client.setCommandResult("shell settings get secure font_weight_adjustment", "null\n");
  for (const key of [
    "accessibility_display_inversion_enabled",
    "accessibility_display_daltonizer_enabled",
    "accessibility_display_daltonizer",
    "accessibility_display_magnification_enabled",
    "accessibility_display_magnification_scale",
    "reduce_bright_colors_activated",
  ]) {
    client.setCommandResult(`shell settings get secure ${key}`, "null\n");
  }
  for (const key of ANIMATION_KEYS) {
    client.setCommandResult(`shell settings get global ${key}`, "1.0\n");
  }
  return factory;
}

function commands(factory: FakeAdbClientFactory): string[] {
  return factory
    .getFakeClient()
    .getCommandCalls()
    .map((call) => call.command);
}

function displayConfig(
  device: BootedDevice,
  dependencies: ConstructorParameters<typeof DisplayConfig>[1],
): DisplayConfig {
  return new DisplayConfig(device, {
    themeBaselines: new Map(),
    accessibilityBaselines: new Map(),
    ...dependencies,
  });
}

describe("displayConfig accessibility display preferences (#14088)", () => {
  test("a read reports the preferences beside the display fields, each with its support", async () => {
    const adbFactory = seededAndroid();
    adbFactory.getFakeClient().setCommandResult(CONTRAST_GET, "1\n");

    const result = await displayConfig(androidEmulator, { adbFactory }).getConfig();

    expect(result.success).toBe(true);
    expect(result.current).toEqual({
      fontScale: 1,
      density: 440,
      theme: "light",
      increaseContrast: true,
      reduceMotion: false,
      boldText: false,
      colorInversion: false,
      colorCorrection: "off",
      magnification: false,
      magnificationScale: 2,
      extraDim: false,
    });
    expect(result.supported).toEqual({
      fontScale: true,
      density: true,
      theme: true,
      increaseContrast: true,
      reduceMotion: true,
      boldText: true,
      colorInversion: true,
      colorCorrection: true,
      magnification: true,
      magnificationScale: true,
      extraDim: true,
      size: true,
      navigationMode: true,
      displayCutout: true,
    });
    expect(result.supportNotes).toBeUndefined();
  });

  test("a preference-only set leaves the display fields alone and returns previous", async () => {
    const adbFactory = seededAndroid();
    adbFactory.getFakeClient().setCommandResultSequence(CONTRAST_GET, ["null\n", "1\n"]);

    const result = await displayConfig(androidEmulator, { adbFactory }).setConfig({
      increaseContrast: true,
    });

    expect(result.success).toBe(true);
    expect(result.previous).toEqual({
      increaseContrast: false,
      reduceMotion: false,
      boldText: false,
      colorInversion: false,
      colorCorrection: "off",
      magnification: false,
      magnificationScale: 2,
      extraDim: false,
    });
    expect(result.applied).toEqual({
      increaseContrast: true,
      reduceMotion: false,
      boldText: false,
      colorInversion: false,
      colorCorrection: "off",
      magnification: false,
      magnificationScale: 2,
      extraDim: false,
    });
    expect(commands(adbFactory)).toContain(
      "shell settings put secure high_text_contrast_enabled 1",
    );
    expect(commands(adbFactory)).not.toContain("shell wm density");
  });

  test("reset restores a preference changed earlier and says so", async () => {
    const adbFactory = seededAndroid();
    adbFactory
      .getFakeClient()
      .setCommandResultSequence(CONTRAST_GET, ["null\n", "1\n", "1\n", "null\n"]);
    const accessibilityBaselines = new Map<string, AccessibilityDisplaySnapshot>();

    await displayConfig(androidEmulator, { adbFactory, accessibilityBaselines }).setConfig({
      increaseContrast: true,
    });
    const result = await displayConfig(androidEmulator, {
      adbFactory,
      accessibilityBaselines,
    }).setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(commands(adbFactory)).toContain(
      "shell settings delete secure high_text_contrast_enabled",
    );
    expect(result.message).toContain("Restored increaseContrast");
    expect(result.previous?.increaseContrast).toBe(true);
    expect(result.applied?.increaseContrast).toBe(false);
    expect(accessibilityBaselines.size).toBe(0);
  });

  test("reset without a recorded preference baseline touches no preference", async () => {
    const adbFactory = seededAndroid();

    const result = await displayConfig(androidEmulator, { adbFactory }).setConfig({ reset: true });

    expect(result.success).toBe(true);
    expect(
      commands(adbFactory).filter((command) => command.includes("high_text_contrast")),
    ).toEqual([]);
  });

  test("factory reset forces defaults with no recorded baselines, as after a daemon restart (#15337)", async () => {
    const adbFactory = seededAndroid();
    const client = adbFactory.getFakeClient();
    // Dark before the reset; the forced `night no` takes effect on the last read.
    client.setCommandResultSequence("shell cmd uimode night", [
      "Night mode: yes\n",
      "Night mode: yes\n",
      "Night mode: yes\n",
      "Night mode: no\n",
    ]);
    client.setCommandResultSequence(CONTRAST_GET, ["1\n", "1\n", "null\n"]);
    const themeBaselines = new Map<string, "light" | "dark">();
    const accessibilityBaselines = new Map<string, AccessibilityDisplaySnapshot>();

    const result = await displayConfig(androidEmulator, {
      adbFactory,
      themeBaselines,
      accessibilityBaselines,
    }).setConfig({ reset: true, factory: true });

    const issued = commands(adbFactory);
    expect(issued).toContain("shell cmd uimode night no");
    expect(issued.some((command) => command.includes("high_text_contrast_enabled"))).toBe(true);
    expect(result.message).toContain("Factory reset");
    expect(result.previous?.theme).toBe("dark");
    expect(themeBaselines.size).toBe(0);
    expect(accessibilityBaselines.size).toBe(0);
  });

  test("a plain reset with no recorded baselines leaves night mode alone", async () => {
    const adbFactory = seededAndroid();
    adbFactory.getFakeClient().setCommandResult("shell cmd uimode night", "Night mode: yes\n");

    await displayConfig(androidEmulator, { adbFactory }).setConfig({ reset: true });

    expect(commands(adbFactory)).not.toContain("shell cmd uimode night no");
  });

  test("rejects reset combined with a preference before touching the device", async () => {
    const adbFactory = seededAndroid();

    const result = await displayConfig(androidEmulator, { adbFactory }).setConfig({
      reset: true,
      boldText: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("reset cannot be combined");
    expect(commands(adbFactory)).toEqual([]);
  });

  test("an iOS Simulator preference-only set is not refused for lacking a theme", async () => {
    const simctl = new FakeSimctl();
    const read = [
      "spawn",
      iosSimulator.deviceId,
      "defaults",
      "read",
      "com.apple.Accessibility",
      "ReduceMotionEnabled",
    ];
    simctl.setCommandArgsResultSequence(read, [{ stdout: "0\n" }, { stdout: "1\n" }]);
    simctl.setCommandArgsResult(["ui", iosSimulator.deviceId, "increase_contrast"], "disabled\n");

    const result = await displayConfig(iosSimulator, { simctl }).setConfig({ reduceMotion: true });

    expect(result.success).toBe(true);
    expect(result.supported.reduceMotion).toBe("partial");
    expect(result.supportNotes?.reduceMotion).toContain("relaunch");
    expect(result.applied?.reduceMotion).toBe(true);
    expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args)).toContainEqual([
      "spawn",
      iosSimulator.deviceId,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "ReduceMotionEnabled",
      "-bool",
      "YES",
    ]);
  });
});
