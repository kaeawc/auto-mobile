import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { displayConfigSchema } from "../../src/server/displayConfigTool";
import { ACCESSIBILITY_DISPLAY_FIELDS } from "../../src/features/utility/AccessibilityDisplayPreferences";
import { DEVICE_SETTING_KEYS } from "../../src/models/DeviceSettingDefaults";

/** A sample argument and the journal key it must record, per platform (null: not journaled there). */
const SETTING_FIELDS: Readonly<
  Record<string, { arg: unknown; android: string | null; ios: string | null }>
> = {
  fontScale: { arg: 1.5, android: "fontScale", ios: "contentSize" },
  contentSize: { arg: "large", android: "contentSize", ios: "contentSize" },
  density: { arg: 480, android: "density", ios: null },
  theme: { arg: "dark", android: "nightMode", ios: "nightMode" },
  // Runtime geometry (#14101) is one opaque intent on Android and refused on iOS.
  size: { arg: { width: 720, height: 1600 }, android: "tool:displayConfig", ios: null },
  navigationMode: { arg: "threeButton", android: "tool:displayConfig", ios: null },
  displayCutout: { arg: "hole", android: "tool:displayConfig", ios: null },
  increaseContrast: { arg: true, android: "increaseContrast", ios: "increaseContrast" },
  reduceMotion: { arg: true, android: "reduceMotion", ios: "reduceMotion" },
  boldText: { arg: true, android: "boldText", ios: "boldText" },
  colorInversion: { arg: true, android: "colorInversion", ios: "colorInversion" },
  colorCorrection: { arg: "grayscale", android: "colorCorrection", ios: "colorCorrection" },
  magnification: { arg: true, android: "magnification", ios: "magnification" },
  magnificationScale: { arg: 3, android: "magnificationScale", ios: "magnificationScale" },
  extraDim: { arg: true, android: "extraDim", ios: "extraDim" },
};

/** Schema fields that select a device or modify the call rather than a display setting. */
const NON_SETTING_FIELDS = [
  "reset",
  "platform",
  "sessionUuid",
  "keepScreenAwake",
  "display",
  "device",
  "deviceId",
];

function keysFor(args: Record<string, unknown>, platform: "android" | "ios"): string[] {
  return deviceToolMutations("displayConfig", args, platform).map((entry) => entry.key);
}

describe("displayConfig mutation journaling covers every field (#14790)", () => {
  test("every displayConfig schema field is classified as a setting or a non-setting", () => {
    expect([...Object.keys(displayConfigSchema.shape)].sort()).toEqual(
      [...Object.keys(SETTING_FIELDS), ...NON_SETTING_FIELDS].sort(),
    );
  });

  test("every accessibility display field is a journalable device setting key", () => {
    for (const field of ACCESSIBILITY_DISPLAY_FIELDS) {
      expect(DEVICE_SETTING_KEYS).toContain(field);
      expect(SETTING_FIELDS[field]).toBeDefined();
    }
  });

  test.each(Object.entries(SETTING_FIELDS))(
    "%s records its device setting before the tool acts, per platform",
    (field, expected) => {
      for (const platform of ["android", "ios"] as const) {
        const key = expected[platform];
        expect(keysFor({ [field]: expected.arg }, platform)).toEqual(key === null ? [] : [key]);
        if (key !== null) {
          expect(
            deviceToolMutations("displayConfig", { [field]: expected.arg }, platform)[0],
          ).toEqual({
            kind: "device-setting",
            key,
          });
        }
      }
    },
  );

  test("false values and mixed calls record each changed setting once", () => {
    expect(keysFor({ increaseContrast: false }, "ios")).toEqual(["increaseContrast"]);
    expect(keysFor({ fontScale: 2, contentSize: "large" }, "ios")).toEqual(["contentSize"]);
    expect(keysFor({ theme: "dark", boldText: false, reduceMotion: true }, "ios")).toEqual([
      "nightMode",
      "reduceMotion",
      "boldText",
    ]);
  });

  test("reset records only the display settings the platform has", () => {
    expect(keysFor({ reset: true }, "android")).toEqual([
      "fontScale",
      "contentSize",
      "density",
      "nightMode",
    ]);
    expect(keysFor({ reset: true }, "ios")).toEqual(["contentSize", "nightMode"]);
  });

  test("several geometry fields record the opaque intent once", () => {
    expect(keysFor({ size: "default", displayCutout: "none", theme: "dark" }, "android")).toEqual([
      "nightMode",
      "tool:displayConfig",
    ]);
  });

  test("a call that sets nothing is a read", () => {
    expect(keysFor({}, "ios")).toEqual([]);
    expect(keysFor({ deviceId: "x" }, "android")).toEqual([]);
  });
});

describe("displayConfig recording on an iOS device (#14790)", () => {
  test("increaseContrast is journaled with the prior value read before the tool acts", async () => {
    const scope = { sessionUuid: "session", deviceId: "UDID", incarnation: "boot-1" };
    const device: BootedDevice = { deviceId: "UDID", platform: "ios", name: "iPhone" };
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, scope),
      {
        read: async (_device, mutations) =>
          mutations.map(() => ({ state: "present" as const, value: "disabled" })),
      },
      { appId: async () => "com.example" },
    );
    await recording.beforeToolCall("displayConfig", { increaseContrast: true }, device, "session");
    expect(await journal.list(scope)).toMatchObject([
      {
        kind: "device-setting",
        key: "increaseContrast",
        priorValue: { state: "present", value: "disabled" },
        toolName: "displayConfig",
      },
    ]);
  });
});
