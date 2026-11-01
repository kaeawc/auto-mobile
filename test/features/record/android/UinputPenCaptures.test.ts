import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputNodes } from "../../../../src/features/record/android/InputNodeDiscovery";
import { captureFrames } from "../../../helpers/touchNodeCaptures";

const DIRECTORY = join(__dirname, "../../../fixtures/android-uinput-pen");
const PEN_PATH = "/dev/input/event12";

function readCapture(stroke: string, mode: "lt" | "lp-during"): string {
  return readFileSync(join(DIRECTORY, `${stroke}-getevent-${mode}-emulator-5610.txt`), "utf8");
}

function penEvents(stroke: string): string[] {
  const capture = readCapture(stroke, "lt");
  expect(capture).toContain(`add device 13: ${PEN_PATH}\n  name:     "automobile-pen"`);
  // Keep exact raw codes/values: the reconstructor consumes node-less streams and
  // does not expose raw key transitions or ABS_DISTANCE samples to these assertions.
  return captureFrames(capture).flatMap((frame) =>
    frame.text.split("\n").flatMap((line) => {
      const event = line.split(`${PEN_PATH}: `)[1];
      return event === undefined ? [] : [event.trim().split(/\s+/).join(" ")];
    }),
  );
}

describe("real uinput pen captures", () => {
  test.each([
    "tap-stylus-pressure-0.2",
    "tap-eraser-pressure-0.5",
    "swipe-stylus-pressure-0.6",
    "hover-stylus",
  ])("%s capabilities identify the direct pen and its ranges", (stroke) => {
    const capture = readCapture(stroke, "lp-during");
    const { pen } = parseInputNodes(capture);
    expect(pen).toHaveLength(1);
    expect(pen[0]).toMatchObject({
      path: PEN_PATH,
      name: "automobile-pen",
      kind: "pen",
      pressureMin: 0,
      pressureMax: 4095,
    });
    // Discovery's typed model does not retain distance or input properties.
    const section = capture
      .split("add device ")
      .find((block) => block.includes('"automobile-pen"'));
    expect(section).toContain("ABS_DISTANCE          : value 0, min 0, max 255,");
    expect(section).toContain("\n    INPUT_PROP_DIRECT\n");
  });

  test("the 0.5 stylus tap reports 00000800 and touch DOWN then UP", () => {
    const events = penEvents("tap-stylus-pressure-0.5");
    expect(events).toContain("EV_ABS ABS_PRESSURE 00000800");
    expect(events.filter((event) => event.startsWith("EV_KEY BTN_TOUCH "))).toEqual([
      "EV_KEY BTN_TOUCH DOWN",
      "EV_KEY BTN_TOUCH UP",
    ]);
  });

  test("the 0.2 stylus tap reports 00000333", () => {
    expect(penEvents("tap-stylus-pressure-0.2")).toContain("EV_ABS ABS_PRESSURE 00000333");
  });

  test("the eraser uses BTN_TOOL_RUBBER without a pen tool event", () => {
    const events = penEvents("tap-eraser-pressure-0.5");
    expect(events).toContain("EV_KEY BTN_TOOL_RUBBER DOWN");
    expect(events.some((event) => event.startsWith("EV_KEY BTN_TOOL_PEN "))).toBe(false);
    // getevent labels BTN_TOOL_PEN's Linux code 0x140 as BTN_DIGI on this emulator.
    expect(events.some((event) => event.startsWith("EV_KEY BTN_DIGI "))).toBe(false);
  });

  test("the swipe changes ABS_Y starting at 00000578", () => {
    const values = penEvents("swipe-stylus-pressure-0.6")
      .filter((event) => event.startsWith("EV_ABS ABS_Y "))
      .map((event) => event.split(" ")[2]);
    expect(values[0]).toBe("00000578");
    expect(new Set(values).size).toBeGreaterThan(1);
  });

  test("hover reports distance 00000080 without touching down", () => {
    const events = penEvents("hover-stylus");
    expect(events).toContain("EV_ABS ABS_DISTANCE 00000080");
    expect(events).not.toContain("EV_KEY BTN_TOUCH DOWN");
  });
});
