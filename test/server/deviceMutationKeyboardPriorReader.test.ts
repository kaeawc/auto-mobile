import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BootedDevice, ExecResult } from "../../src/models";
import { KeyboardMutationPriorReader } from "../../src/server/deviceMutationKeyboardPriorReader";
import { createExecResult } from "../../src/utils/execResult";

const SIMULATOR: BootedDevice = {
  name: "iPhone 17 Pro",
  platform: "ios",
  deviceId: "85E99D67-7088-4999-89CB-3C06DBE410BF",
};
const ANDROID: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5560" };
// `simctl spawn <udid> defaults export -g -` on an iOS 27.2 simulator after keyboard changes.
const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../fixtures/ios-simctl", name), "utf8");
const GLOBALS = fixture("defaults-export-global-keyboards-ios27-2.plist");
// The same export on a newly created iOS 27.2 simulator: no AppleKeyboards yet.
const FRESH_GLOBALS = fixture("defaults-export-global-fresh-ios27-2.plist");

function reader(current: string | Error, globals = GLOBALS) {
  const calls: string[][] = [];
  const simctl = {
    executeCommandArgs: async (args: string[]): Promise<ExecResult> => {
      calls.push(args);
      if (args[3] === "export") {
        return createExecResult(globals, "");
      }
      if (current instanceof Error) {
        throw current;
      }
      return createExecResult(`${current}\n`, "");
    },
  };
  return { reader: new KeyboardMutationPriorReader(() => simctl), calls };
}

const HARDWARE = { kind: "keyboard", key: "hardware" };
const LANGUAGE = { kind: "keyboard", key: "language" };

describe("KeyboardMutationPriorReader (#19017)", () => {
  test("the hardware keyboard prior is the boot state, read without any command", async () => {
    const { reader: priors, calls } = reader("unused");
    expect(await priors.read(SIMULATOR, [HARDWARE])).toEqual([
      { state: "present", value: { connected: true, layout: "ansi" } },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("the language prior holds the keyboard and language lists and the selected keyboard", async () => {
    const { reader: priors, calls } = reader("en_US@sw=QWERTY;hw=Automatic");
    expect(await priors.read(SIMULATOR, [LANGUAGE])).toEqual([
      {
        state: "present",
        value: {
          keyboards: [
            "en_US@sw=QWERTY;hw=Automatic",
            "emoji@sw=Emoji",
            "fr_FR@sw=AZERTY-French;hw=Automatic",
            "de_DE@sw=QWERTZ-German;hw=Automatic",
            "ja_JP-Kana@sw=Kana;hw=Automatic",
            "zh_Hans-Pinyin@sw=Pinyin-Simplified;hw=Automatic",
          ],
          languages: ["en-US", "zh-Hans-US"],
          current: "en_US@sw=QWERTY;hw=Automatic",
          locale: "en_US",
        },
      },
    ]);
    expect(calls).toEqual([
      ["spawn", SIMULATOR.deviceId, "defaults", "export", "-g", "-"],
      [
        "spawn",
        SIMULATOR.deviceId,
        "defaults",
        "read",
        "com.apple.keyboard.preferences",
        "KeyboardLastUsed",
      ],
    ]);
  });

  test("a new simulator records its unset keyboards and selection as null", async () => {
    const missing = Object.assign(new Error("Command failed"), {
      stderr:
        "Error: Could not find key 'KeyboardLastUsed' in domain 'com.apple.keyboard.preferences'.",
    });
    const { reader: priors } = reader(missing, FRESH_GLOBALS);
    expect(await priors.read(SIMULATOR, [LANGUAGE])).toEqual([
      {
        state: "present",
        value: { keyboards: null, languages: ["en-US"], current: null, locale: "en_US" },
      },
    ]);
  });

  test("a failed read is unobservable", async () => {
    const { reader: priors } = reader(new Error("CoreSimulator service unavailable"));
    expect(await priors.read(SIMULATOR, [LANGUAGE])).toEqual([{ state: "unobservable" }]);
  });

  test("other devices and intents are unobservable", async () => {
    const { reader: priors, calls } = reader("unused");
    expect(await priors.read(ANDROID, [HARDWARE, LANGUAGE])).toEqual([
      { state: "unobservable" },
      { state: "unobservable" },
    ]);
    expect(
      await priors.read(SIMULATOR, [
        { kind: "keyboard", key: "profile" },
        { kind: "clock", key: "device" },
      ]),
    ).toEqual([{ state: "unobservable" }, { state: "unobservable" }]);
    expect(calls).toHaveLength(0);
  });
});
