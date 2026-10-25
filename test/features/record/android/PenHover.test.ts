import { describe, expect, test } from "bun:test";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import type { GestureEvent } from "../../../../src/features/record/android/types";

/** The hover events the reconstructor reports for a stream of `getevent -lt` lines. */
function hoverEvents(lines: string[], options: { singleTouch?: boolean } = {}): GestureEvent[] {
  const events: GestureEvent[] = [];
  const reconstructor = new TouchFrameReconstructor({
    ...options,
    onHover: (event) => events.push(event),
  });
  let t = 1000;
  for (const line of lines) {
    reconstructor.feedLine(line, (t += 10));
  }
  return events;
}

const SYN = "[  1.0] EV_SYN    SYN_REPORT           00000000";

describe("a single-touch pen that hovers without ever touching (#13084)", () => {
  const HOVER_ONLY = [
    "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
    "[  1.0] EV_ABS    ABS_X                00000438",
    "[  1.0] EV_ABS    ABS_Y                000005dc",
    SYN,
    "[  1.1] EV_ABS    ABS_X                00000440",
    SYN,
    "[  1.2] EV_KEY    BTN_TOOL_PEN         UP",
    SYN,
  ];

  test("is reported once, when the pen leaves range", () => {
    const events = hoverEvents(HOVER_ONLY, { singleTouch: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "hover", toolType: "stylus" });
  });

  test("is not reported while the pen is still in range", () => {
    expect(hoverEvents(HOVER_ONLY.slice(0, -2), { singleTouch: true })).toEqual([]);
  });

  test("an eraser that hovers is reported as an eraser", () => {
    const eraser = HOVER_ONLY.map((line) => line.replace("BTN_TOOL_PEN", "BTN_TOOL_RUBBER"));

    expect(hoverEvents(eraser, { singleTouch: true })).toMatchObject([
      { type: "hover", toolType: "eraser" },
    ]);
  });

  test("hovering before a touch is not a lost hover", () => {
    const tap = [
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_ABS    ABS_X                00000438",
      SYN,
      "[  1.1] EV_KEY    BTN_TOUCH            DOWN",
      SYN,
      "[  1.2] EV_KEY    BTN_TOUCH            UP",
      "[  1.2] EV_KEY    BTN_TOOL_PEN         UP",
      SYN,
    ];

    expect(hoverEvents(tap, { singleTouch: true })).toEqual([]);
  });

  test("a touch reported before the tool key in the same frame is still a contact", () => {
    const tap = [
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_ABS    ABS_X                00000438",
      SYN,
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_KEY    BTN_TOOL_PEN         UP",
      SYN,
    ];

    expect(hoverEvents(tap, { singleTouch: true })).toEqual([]);
  });

  test("a tool key that went down before recording started is not guessed at", () => {
    const lines = ["[  1.2] EV_KEY    BTN_TOOL_PEN         UP", SYN];

    expect(hoverEvents(lines, { singleTouch: true })).toEqual([]);
  });

  test("a second in-range stretch after a touch is reported on its own", () => {
    const lines = [
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      SYN,
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_KEY    BTN_TOOL_PEN         UP",
      SYN,
      "[  2.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      SYN,
      "[  2.1] EV_KEY    BTN_TOOL_PEN         UP",
      SYN,
    ];

    expect(hoverEvents(lines, { singleTouch: true })).toHaveLength(1);
  });
});

describe("a multitouch pen that hovers without ever touching (#13084)", () => {
  const HOVER_ONLY = [
    "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
    "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
    "[  1.0] EV_ABS    ABS_MT_DISTANCE      00000005",
    "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
    "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
    SYN,
    "[  1.1] EV_ABS    ABS_MT_POSITION_X    000001b0",
    SYN,
    "[  1.2] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
    SYN,
  ];

  test("is reported once, when the pen's tracking id ends", () => {
    expect(hoverEvents(HOVER_ONLY)).toMatchObject([{ type: "hover", toolType: "stylus" }]);
  });

  test("touching down and lifting back into hover is a contact, not a lost hover", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_DISTANCE      00000005",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      SYN,
      "[  1.1] EV_ABS    ABS_MT_DISTANCE      00000000",
      SYN,
      "[  1.2] EV_ABS    ABS_MT_DISTANCE      00000004",
      SYN,
      "[  1.3] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      SYN,
    ];

    expect(hoverEvents(lines)).toEqual([]);
  });

  test("a finger never reports a hover", () => {
    const finger = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      SYN,
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      SYN,
    ];

    expect(hoverEvents(finger)).toEqual([]);
  });

  test("a tracking id replaced without a release starts a fresh episode", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_DISTANCE      00000000",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      SYN,
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   00000002",
      "[  1.1] EV_ABS    ABS_MT_DISTANCE      00000005",
      SYN,
      "[  1.2] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      SYN,
    ];

    expect(hoverEvents(lines)).toMatchObject([{ type: "hover", toolType: "stylus" }]);
  });

  test("a hover replaced directly by a contact id is still reported", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_DISTANCE      00000005",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      SYN,
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   00000002",
      "[  1.1] EV_ABS    ABS_MT_DISTANCE      00000000",
      SYN,
      "[  1.2] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      SYN,
    ];

    expect(hoverEvents(lines)).toMatchObject([{ type: "hover", toolType: "stylus" }]);
  });

  test("a pen with no distance axis is not mistaken for a hover", () => {
    const lines = HOVER_ONLY.filter((line) => !line.includes("ABS_MT_DISTANCE"));

    expect(hoverEvents(lines)).toEqual([]);
  });

  test("two hovers in a row are each reported", () => {
    const again = HOVER_ONLY.map((line) =>
      line.includes("ABS_MT_TRACKING_ID   00000001") ? line.replace("00000001", "00000002") : line,
    );

    expect(hoverEvents([...HOVER_ONLY, ...again])).toHaveLength(2);
  });
});
