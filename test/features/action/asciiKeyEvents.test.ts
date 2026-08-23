import { describe, expect, test } from "bun:test";
import { buildAsciiKeyEventPlan } from "../../../src/features/action/asciiKeyEvents";

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
