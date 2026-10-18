import { describe, expect, test } from "bun:test";
import { buildAsciiKeyEventPlan } from "../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import {
  buildAndroidInputTextCommand,
  ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS,
  buildAndroidInputTextPlan,
  canJoinAndroidInputText,
} from "../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import { decodeInputTextCommand } from "./SendKeysTestHarness";

describe("buildAsciiKeyEventPlan", () => {
  test("digits map to direct key events", () => {
    expect(buildAsciiKeyEventPlan("4", false)).toEqual({
      commands: ["shell input keyevent KEYCODE_4"],
    });
  });

  test("lowercase letters map to the uppercased key code without shift", () => {
    expect(buildAsciiKeyEventPlan("a", false)).toEqual({
      commands: ["shell input keyevent KEYCODE_A"],
    });
  });

  test("uppercase letters use a shift combination when supported", () => {
    expect(buildAsciiKeyEventPlan("A", true)).toEqual({
      commands: ["shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_A"],
    });
  });

  test("uppercase letters are unmappable when key combination is unsupported", () => {
    expect(buildAsciiKeyEventPlan("A", false)).toBeNull();
  });

  test("direct punctuation maps without shift", () => {
    expect(buildAsciiKeyEventPlan("@", false)).toEqual({
      commands: ["shell input keyevent KEYCODE_AT"],
    });
  });

  test("shifted punctuation needs key combination", () => {
    expect(buildAsciiKeyEventPlan("!", true)).toEqual({
      commands: ["shell input keycombination KEYCODE_SHIFT_LEFT KEYCODE_1"],
    });
    expect(buildAsciiKeyEventPlan("!", false)).toBeNull();
  });

  test("non-ASCII characters are unmappable", () => {
    expect(buildAsciiKeyEventPlan("你", true)).toBeNull();
    expect(buildAsciiKeyEventPlan("😊", true)).toBeNull();
  });
});

// #9888: eventAll sends a printable run in one `input text` process. The decoder models the
// device shell's word splitting and `input text`'s `%s` decoding, so each case checks what the
// device would type, not just the command string.
describe("buildAndroidInputTextCommand", () => {
  for (const { label, text, command } of [
    { label: "space", text: "ab cd ef", command: "shell input text 'ab%scd%sef'" },
    { label: "single quote", text: "it's", command: "shell input text 'it'\\''s'" },
    { label: "double quote", text: 'say "hi"', command: "shell input text 'say%s\"hi\"'" },
    { label: "percent", text: "100%", command: "shell input text '100%'" },
    { label: "percent before a space", text: "5% off", command: "shell input text '5%%soff'" },
    { label: "dollar", text: "$HOME $(id)", command: "shell input text '$HOME%s$(id)'" },
    { label: "backslash", text: "a\\nb\\", command: "shell input text 'a\\nb\\'" },
    { label: "backtick", text: "`id`", command: "shell input text '`id`'" },
    {
      label: "shell operators",
      text: "a;b|c&d>e<f*?",
      command: "shell input text 'a;b|c&d>e<f*?'",
    },
  ]) {
    test(`quotes ${label} as one literal argument`, () => {
      expect(buildAndroidInputTextCommand(text)).toBe(command);
      expect(decodeInputTextCommand(command)).toBe(text);
    });
  }

  test("leaves no whitespace for adb or the device shell to split on", () => {
    const command = buildAndroidInputTextCommand(" a  b ");
    expect(command.slice("shell input text ".length)).not.toMatch(/\s/);
    expect(decodeInputTextCommand(command)).toBe(" a  b ");
  });

  test("refuses a literal %s, which input text would decode to a space", () => {
    expect(() => buildAndroidInputTextCommand("50%sale")).toThrow("%s");
    expect(() => buildAndroidInputTextCommand("")).toThrow();
  });
});

describe("canJoinAndroidInputText", () => {
  test("splits only a literal % followed by s", () => {
    expect(canJoinAndroidInputText("%", "s")).toBe(false);
    expect(canJoinAndroidInputText("%", "S")).toBe(true);
    expect(canJoinAndroidInputText("%", " ")).toBe(true);
    expect(canJoinAndroidInputText("a", "s")).toBe(true);
  });
});

describe("buildAndroidInputTextPlan", () => {
  const text = "it's a long run of text, 1234567890 and more";

  test("emits one command for the whole run on API 30 and older", () => {
    for (const apiLevel of [21, 29, 30]) {
      expect(buildAndroidInputTextPlan(text, apiLevel)).toEqual({
        commands: [buildAndroidInputTextCommand(text)],
        textLength: text.length,
      });
    }
  });

  test("bounds each command below the argv limit on API 30 and older", () => {
    const long = "a".repeat(ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS * 2 + 10);
    const plan = buildAndroidInputTextPlan(long, 30);
    expect(plan.commands).toEqual([
      buildAndroidInputTextCommand("a".repeat(ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS)),
      buildAndroidInputTextCommand("a".repeat(ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS)),
      buildAndroidInputTextCommand("a".repeat(10)),
    ]);
  });

  test("chunks at 32 characters on API 31+ and when the level is unknown", () => {
    for (const apiLevel of [31, 36, null]) {
      expect(buildAndroidInputTextPlan(text, apiLevel)).toEqual({
        commands: [
          buildAndroidInputTextCommand(text.slice(0, 32)),
          buildAndroidInputTextCommand(text.slice(32)),
        ],
        textLength: 32,
      });
    }
  });
});
