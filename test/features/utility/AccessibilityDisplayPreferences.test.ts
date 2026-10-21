import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  AccessibilityDisplayPreferences,
  animationScalesRemoved,
  decodeColorCorrection,
  parseAndroidNumericSetting,
  type AccessibilityDisplaySnapshot,
  type SettingsAdb,
  type SimctlRunner,
} from "../../../src/features/utility/AccessibilityDisplayPreferences";
import { createExecResult } from "../../../src/utils/execResult";

const android: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };
const simulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
};

/** A stateful Android settings provider: `settings get` reads back what `put` wrote. */
class FakeSettingsAdb implements SettingsAdb {
  readonly settings = new Map<string, string>();
  readonly commands: string[] = [];
  apiLevel = "34";
  /** Accept writes without changing the setting, like an OEM that ignores them. */
  ignoreWrites = false;

  executeCommand: SettingsAdb["executeCommand"] = async (command) => {
    this.commands.push(command);
    if (command === "shell getprop ro.build.version.sdk") {
      return createExecResult(`${this.apiLevel}\n`, "");
    }
    const match = /^shell settings (get|put|delete) (secure|global) (\S+)(?: (\S+))?$/.exec(
      command,
    );
    if (!match) {
      throw new Error(`unexpected command ${command}`);
    }
    const [, verb, namespace, key, value] = match;
    const id = `${namespace}/${key}`;
    if (verb === "get") {
      return createExecResult(`${this.settings.get(id) ?? "null"}\n`, "");
    }
    if (!this.ignoreWrites) {
      if (verb === "delete") {
        this.settings.delete(id);
      } else {
        this.settings.set(id, value!);
      }
    }
    return createExecResult("", "");
  };

  writes(): string[] {
    return this.commands.filter((command) => / settings (put|delete) /.test(command));
  }
}

/** A stateful Simulator: `simctl ui increase_contrast` and `defaults` in com.apple.Accessibility. */
class FakeAccessibilitySimctl implements SimctlRunner {
  contrast = "disabled";
  contrastVerbMissing = false;
  missingDefaultError: "message" | "stderr" | "legacy" = "message";
  readonly defaults = new Map<string, string>();
  readonly calls: string[][] = [];

  executeCommandArgs: SimctlRunner["executeCommandArgs"] = async (args) => {
    this.calls.push(args);
    if (args[0] === "ui" && args[2] === "increase_contrast") {
      if (this.contrastVerbMissing) {
        throw new Error("Unrecognized subcommand: increase_contrast");
      }
      if (args[3] !== undefined) {
        this.contrast = args[3];
      }
      return createExecResult(`${this.contrast}\n`, "");
    }
    const [, , , verb, , key, , value] = args;
    if (verb === "read") {
      const stored = this.defaults.get(key!);
      if (stored === undefined) {
        if (this.missingDefaultError === "legacy") {
          throw new Error(
            `The domain/default pair of (com.apple.Accessibility, ${key}) does not exist`,
          );
        }
        // Captured in cyc-off-ios.log (20261021e) and issue #14736; only the key/domain vary.
        const message = `Error: Could not find key '${key}' in domain 'com.apple.Accessibility'.`;
        throw this.missingDefaultError === "stderr"
          ? Object.assign(new Error(), { stderr: message })
          : new Error(message);
      }
      return createExecResult(`${stored}\n`, "");
    }
    if (verb === "write") {
      this.defaults.set(key!, value === "YES" ? "1" : "0");
    } else if (verb === "delete") {
      this.defaults.delete(key!);
    }
    return createExecResult("", "");
  };
}

function androidPreferences(adb: FakeSettingsAdb, baselines = new Map()) {
  return new AccessibilityDisplayPreferences(android, { adb: () => adb, baselines });
}

function simulatorPreferences(simctl: FakeAccessibilitySimctl, baselines = new Map()) {
  return new AccessibilityDisplayPreferences(simulator, {
    simctl,
    iosSimulator: true,
    baselines,
  });
}

describe("accessibility display parsers", () => {
  test("parseAndroidNumericSetting treats null as unset and rejects non-numeric output", () => {
    expect(parseAndroidNumericSetting("null\n")).toBeNull();
    expect(parseAndroidNumericSetting("1\n")).toBe("1");
    expect(parseAndroidNumericSetting("0.5")).toBe("0.5");
    expect(() => parseAndroidNumericSetting("")).toThrow();
    expect(() => parseAndroidNumericSetting("Exception: bad")).toThrow();
  });

  test("animations count as removed only when every scale is explicitly zero", () => {
    expect(animationScalesRemoved("0,0.0,0")).toBe(true);
    expect(animationScalesRemoved("0,0,1")).toBe(false);
    expect(animationScalesRemoved("0,0,null")).toBe(false);
    expect(animationScalesRemoved(null)).toBe(false);
  });
});

describe("AccessibilityDisplayPreferences on Android", () => {
  test("reads unset settings as off, with every field supported on API 31+", async () => {
    const adb = new FakeSettingsAdb();

    const read = await androidPreferences(adb).read();

    expect(read.values).toEqual({
      increaseContrast: false,
      reduceMotion: false,
      boldText: false,
      colorInversion: false,
      colorCorrection: "off",
      magnification: false,
      magnificationScale: 2,
      extraDim: false,
    });
    expect(Object.values(read.supported).every((level) => level === true)).toBe(true);
    expect(read.notes).toEqual({});
  });

  test("refuses boldText below API 31 without writing it", async () => {
    const adb = new FakeSettingsAdb();
    adb.apiLevel = "30";

    const change = await androidPreferences(adb).set({ boldText: true });

    expect(change.supported.boldText).toBe(false);
    expect(change.notes.boldText).toContain("API 31");
    expect(change.errors).toEqual([
      expect.stringContaining("boldText: Bold text needs Android API 31+"),
    ]);
    expect(adb.writes()).toEqual([]);
  });

  test("increaseContrast round-trips and reset deletes the setting it was absent from", async () => {
    const adb = new FakeSettingsAdb();
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();

    const change = await androidPreferences(adb, baselines).set({ increaseContrast: true });

    expect(change.errors).toEqual([]);
    expect(change.previous.increaseContrast).toBe(false);
    expect(change.applied.increaseContrast).toBe(true);
    expect(adb.writes()).toEqual(["shell settings put secure high_text_contrast_enabled 1"]);
    expect(baselines.get(android.deviceId)).toEqual({ increaseContrast: null });

    const reset = await androidPreferences(adb, baselines).reset();

    expect(reset.errors).toEqual([]);
    expect(reset.restored).toEqual(["increaseContrast"]);
    expect(reset.applied.increaseContrast).toBe(false);
    expect(adb.writes().at(-1)).toBe("shell settings delete secure high_text_contrast_enabled");
    expect(baselines.has(android.deviceId)).toBe(false);
  });

  test("boldText writes the Android 12 bold weight adjustment", async () => {
    const adb = new FakeSettingsAdb();

    const change = await androidPreferences(adb).set({ boldText: true });

    expect(change.errors).toEqual([]);
    expect(change.applied.boldText).toBe(true);
    expect(adb.settings.get("secure/font_weight_adjustment")).toBe("300");
  });

  test("reduceMotion zeroes every animation scale and false restores the scales it replaced", async () => {
    const adb = new FakeSettingsAdb();
    for (const key of [
      "window_animation_scale",
      "transition_animation_scale",
      "animator_duration_scale",
    ]) {
      adb.settings.set(`global/${key}`, "0.5");
    }
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();

    const on = await androidPreferences(adb, baselines).set({ reduceMotion: true });

    expect(on.errors).toEqual([]);
    expect(on.applied.reduceMotion).toBe(true);
    expect(adb.settings.get("global/animator_duration_scale")).toBe("0");

    const off = await androidPreferences(adb, baselines).set({ reduceMotion: false });

    expect(off.errors).toEqual([]);
    expect(off.previous.reduceMotion).toBe(true);
    expect(off.applied.reduceMotion).toBe(false);
    expect(adb.settings.get("global/window_animation_scale")).toBe("0.5");
    expect(adb.settings.get("global/animator_duration_scale")).toBe("0.5");
  });

  test("reduceMotion false with no recorded baseline turns animations back on at scale 1", async () => {
    const adb = new FakeSettingsAdb();
    for (const key of [
      "window_animation_scale",
      "transition_animation_scale",
      "animator_duration_scale",
    ]) {
      adb.settings.set(`global/${key}`, "0");
    }

    const change = await androidPreferences(adb).set({ reduceMotion: false });

    expect(change.errors).toEqual([]);
    expect(adb.settings.get("global/transition_animation_scale")).toBe("1");
  });

  test("reports a write the device did not adopt instead of claiming success", async () => {
    const adb = new FakeSettingsAdb();
    adb.ignoreWrites = true;

    const change = await androidPreferences(adb).set({ increaseContrast: true });

    expect(change.applied.increaseContrast).toBe(false);
    expect(change.errors).toEqual(["increaseContrast remained false after requesting true"]);
  });

  test("reset without a recorded baseline issues no writes", async () => {
    const adb = new FakeSettingsAdb();
    const preferences = androidPreferences(adb);

    expect(preferences.hasBaseline()).toBe(false);
    const reset = await preferences.reset();

    expect(reset.restored).toEqual([]);
    expect(reset.errors).toEqual([]);
    expect(adb.writes()).toEqual([]);
  });

  test("raw snapshots round-trip for acquisition reset without recording a baseline", async () => {
    const adb = new FakeSettingsAdb();
    adb.settings.set("secure/high_text_contrast_enabled", "0");
    adb.settings.set("global/window_animation_scale", "0.5");
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();
    const preferences = androidPreferences(adb, baselines);

    const snapshot = await preferences.readSnapshot([
      "increaseContrast",
      "reduceMotion",
      "boldText",
    ]);

    expect(snapshot).toEqual({
      increaseContrast: "0",
      reduceMotion: "0.5,null,null",
      boldText: null,
    });

    await preferences.set({ increaseContrast: true, reduceMotion: true, boldText: true });
    baselines.clear();
    const written = await preferences.restoreSnapshot(snapshot);

    expect(written).toEqual(["increaseContrast", "reduceMotion", "boldText"]);
    expect(
      await preferences.readSnapshot(["increaseContrast", "reduceMotion", "boldText"]),
    ).toEqual(snapshot);
    expect(baselines.size).toBe(0);
  });
});

describe("Android accessibility display settings (#14076)", () => {
  test("color inversion round-trips and reset deletes the setting it was absent from", async () => {
    const adb = new FakeSettingsAdb();
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();

    const change = await androidPreferences(adb, baselines).set({ colorInversion: true });

    expect(change.errors).toEqual([]);
    expect(change.applied.colorInversion).toBe(true);
    expect(adb.settings.get("secure/accessibility_display_inversion_enabled")).toBe("1");

    await androidPreferences(adb, baselines).reset();

    expect(adb.settings.has("secure/accessibility_display_inversion_enabled")).toBe(false);
  });

  test("color correction writes the mode before enabling the daltonizer", async () => {
    const adb = new FakeSettingsAdb();

    const change = await androidPreferences(adb).set({ colorCorrection: "protanomaly" });

    expect(change.errors).toEqual([]);
    expect(change.applied.colorCorrection).toBe("protanomaly");
    expect(adb.writes()).toEqual([
      "shell settings put secure accessibility_display_daltonizer 11",
      "shell settings put secure accessibility_display_daltonizer_enabled 1",
    ]);
  });

  test("color correction off keeps the user's mode and grayscale is monochromacy", async () => {
    const adb = new FakeSettingsAdb();
    adb.settings.set("secure/accessibility_display_daltonizer_enabled", "0");
    adb.settings.set("secure/accessibility_display_daltonizer", "13");
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();

    await androidPreferences(adb, baselines).set({ colorCorrection: "grayscale" });
    expect(adb.settings.get("secure/accessibility_display_daltonizer")).toBe("0");

    const off = await androidPreferences(adb, baselines).set({ colorCorrection: "off" });

    expect(off.applied.colorCorrection).toBe("off");
    expect(adb.settings.get("secure/accessibility_display_daltonizer_enabled")).toBe("0");
    expect(adb.settings.get("secure/accessibility_display_daltonizer")).toBe("13");
  });

  test("decodeColorCorrection reads an enabled unknown mode as AOSP's default", () => {
    expect(decodeColorCorrection(null)).toBe("off");
    expect(decodeColorCorrection("0,12")).toBe("off");
    expect(decodeColorCorrection("1,12")).toBe("deuteranomaly");
    expect(decodeColorCorrection("1,null")).toBe("deuteranomaly");
  });

  test("magnification gesture and scale are separate settings", async () => {
    const adb = new FakeSettingsAdb();

    const change = await androidPreferences(adb).set({
      magnification: true,
      magnificationScale: 3,
    });

    expect(change.errors).toEqual([]);
    expect(change.previous.magnificationScale).toBe(2);
    expect(change.applied).toMatchObject({ magnification: true, magnificationScale: 3 });
    expect(adb.settings.get("secure/accessibility_display_magnification_scale")).toBe("3");
  });

  test("extra dim needs API 31", async () => {
    const adb = new FakeSettingsAdb();
    adb.apiLevel = "30";

    const change = await androidPreferences(adb).set({ extraDim: true });

    expect(change.supported.extraDim).toBe(false);
    expect(change.errors).toEqual([expect.stringContaining("Extra dim needs Android API 31+")]);
    expect(adb.writes()).toEqual([]);
  });

  test("extra dim round-trips on API 31+", async () => {
    const adb = new FakeSettingsAdb();
    adb.apiLevel = "31";

    const change = await androidPreferences(adb).set({ extraDim: true });

    expect(change.errors).toEqual([]);
    expect(adb.settings.get("secure/reduce_bright_colors_activated")).toBe("1");
  });
});

describe("AccessibilityDisplayPreferences on the iOS Simulator", () => {
  for (const missingDefaultError of ["message", "stderr", "legacy"] as const) {
    test(`absent defaults read as null and off (${missingDefaultError})`, async () => {
      const simctl = new FakeAccessibilitySimctl();
      simctl.missingDefaultError = missingDefaultError;
      const preferences = simulatorPreferences(simctl);

      expect(await preferences.readSnapshot(["boldText", "reduceMotion"])).toEqual({
        boldText: null,
        reduceMotion: null,
      });
      const read = await preferences.read();
      expect(read.values).toMatchObject({ boldText: false, reduceMotion: false });
      expect(read.supported).toMatchObject({ boldText: "partial", reduceMotion: "partial" });
    });

    for (const [field, key] of [
      ["boldText", "EnhancedTextLegibilityEnabled"],
      ["reduceMotion", "ReduceMotionEnabled"],
    ] as const) {
      test(`${field} round-trips an absent default (${missingDefaultError})`, async () => {
        const simctl = new FakeAccessibilitySimctl();
        simctl.missingDefaultError = missingDefaultError;
        const baselines = new Map<string, AccessibilityDisplaySnapshot>();
        const preferences = simulatorPreferences(simctl, baselines);

        const change = await preferences.set({ [field]: true });

        expect(change.errors).toEqual([]);
        expect(change.previous[field]).toBe(false);
        expect(change.applied[field]).toBe(true);
        expect(simctl.defaults.get(key)).toBe("1");
        expect(baselines.get(simulator.deviceId)).toEqual({ [field]: null });

        const reset = await preferences.reset();

        expect(reset.errors).toEqual([]);
        expect(reset.restored).toEqual([field]);
        expect(reset.values[field]).toBe(false);
        expect(simctl.defaults.has(key)).toBe(false);
        expect(simctl.calls).toContainEqual([
          "spawn",
          simulator.deviceId,
          "defaults",
          "delete",
          "com.apple.Accessibility",
          key,
        ]);
        expect(baselines.size).toBe(0);
      });
    }
  }

  test("reads increase_contrast via simctl and the defaults-backed fields as partial", async () => {
    const simctl = new FakeAccessibilitySimctl();
    simctl.contrast = "enabled";
    simctl.defaults.set("EnhancedTextLegibilityEnabled", "1");

    const read = await simulatorPreferences(simctl).read();

    expect(read.values).toEqual({ increaseContrast: true, reduceMotion: false, boldText: true });
    expect(read.supported).toEqual({
      increaseContrast: true,
      reduceMotion: "partial",
      boldText: "partial",
      colorInversion: false,
      colorCorrection: false,
      magnification: false,
      magnificationScale: false,
      extraDim: false,
    });
    expect(read.notes.colorInversion).toContain("Android only");
    expect(read.notes.reduceMotion).toContain("relaunch");
    expect(read.notes.increaseContrast).toBeUndefined();
  });

  test("increaseContrast round-trips through simctl ui and reset restores it", async () => {
    const simctl = new FakeAccessibilitySimctl();
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();

    const change = await simulatorPreferences(simctl, baselines).set({ increaseContrast: true });

    expect(change.errors).toEqual([]);
    expect(change.previous.increaseContrast).toBe(false);
    expect(change.applied.increaseContrast).toBe(true);
    expect(simctl.calls).toContainEqual(["ui", simulator.deviceId, "increase_contrast", "enabled"]);

    const reset = await simulatorPreferences(simctl, baselines).reset();

    expect(reset.restored).toEqual(["increaseContrast"]);
    expect(simctl.contrast).toBe("disabled");
  });

  test("reduceMotion writes the com.apple.Accessibility default and reset deletes it again", async () => {
    const simctl = new FakeAccessibilitySimctl();
    const baselines = new Map<string, AccessibilityDisplaySnapshot>();

    const change = await simulatorPreferences(simctl, baselines).set({ reduceMotion: true });

    expect(change.errors).toEqual([]);
    expect(change.applied.reduceMotion).toBe(true);
    expect(change.supported.reduceMotion).toBe("partial");
    expect(simctl.calls).toContainEqual([
      "spawn",
      simulator.deviceId,
      "defaults",
      "write",
      "com.apple.Accessibility",
      "ReduceMotionEnabled",
      "-bool",
      "YES",
    ]);

    const reset = await simulatorPreferences(simctl, baselines).reset();

    expect(reset.restored).toEqual(["reduceMotion"]);
    expect(simctl.calls).toContainEqual([
      "spawn",
      simulator.deviceId,
      "defaults",
      "delete",
      "com.apple.Accessibility",
      "ReduceMotionEnabled",
    ]);
    expect(simctl.defaults.has("ReduceMotionEnabled")).toBe(false);
  });

  test("an Xcode without increase_contrast reports it unsupported and never writes it", async () => {
    const simctl = new FakeAccessibilitySimctl();
    simctl.contrastVerbMissing = true;

    const change = await simulatorPreferences(simctl).set({ increaseContrast: true });

    expect(change.supported.increaseContrast).toBe(false);
    expect(change.notes.increaseContrast).toContain("increase_contrast");
    expect(change.errors).toEqual([expect.stringContaining("increaseContrast:")]);
    expect(simctl.calls.filter((args) => args.length > 3 && args[0] === "ui")).toEqual([]);
  });
});

describe("AccessibilityDisplayPreferences on physical iOS", () => {
  test("reports every field unsupported and issues no commands", async () => {
    const simctl = new FakeAccessibilitySimctl();
    const preferences = new AccessibilityDisplayPreferences(
      { ...simulator, deviceId: "00008130-001234567890ABCD" },
      { simctl, iosSimulator: false },
    );

    const read = await preferences.read();
    const change = await preferences.set({ boldText: true });

    expect(Object.values(read.supported).every((level) => level === false)).toBe(true);
    expect(change.errors).toEqual([expect.stringContaining("boldText: No automatable")]);
    expect(simctl.calls).toEqual([]);
  });
});
