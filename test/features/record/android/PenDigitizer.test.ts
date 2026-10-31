import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdirSync } from "node:fs";
import { readTouchNodeCapture } from "../../../helpers/touchNodeCaptures";
import { buildScaler } from "../../../../src/features/record/android/AxisRanges";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import {
  parseInputNodes,
  parseTouchNodes,
} from "../../../../src/features/record/android/InputNodeDiscovery";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import type { TiltAxes } from "../../../../src/features/record/android/TouchNodeDiscovery";
import type { GestureEvent, RawTouchFrame } from "../../../../src/features/record/android/types";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Hand-written fixtures in the exact layout real `getevent -p` / `-lp` print (see
// test/fixtures/android-touch-node/getevent-p-touch-node-emulator-5600.txt): the first axis shares the
// `ABS (0003):` line and the rest are indented continuation lines.
const PEN_ONLY_P = `add device 1: /dev/input/event5
  name:     "Wacom Pen"
  events:
    KEY (0001): 0140  0141  0145  014a  014b 
    ABS (0003): 0000  : value 0, min 0, max 20000, fuzz 0, flat 0, resolution 100
                0001  : value 0, min 0, max 30000, fuzz 0, flat 0, resolution 100
                0018  : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
                001a  : value 0, min -90, max 90, fuzz 0, flat 0, resolution 0
                001b  : value 0, min -90, max 90, fuzz 0, flat 0, resolution 0
  input props:
    <none>
`;

const PEN_ONLY_LP = `add device 1: /dev/input/event5
  name:     "Wacom Pen"
  events:
    KEY (0001): BTN_TOOL_PEN          BTN_TOOL_RUBBER      BTN_TOUCH            BTN_STYLUS           BTN_STYLUS2          
    ABS (0003): ABS_X                 : value 0, min 0, max 20000, fuzz 0, flat 0, resolution 100
                ABS_Y                 : value 0, min 0, max 30000, fuzz 0, flat 0, resolution 100
                ABS_PRESSURE          : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
  input props:
    <none>
`;

const TOUCH_AND_PEN_P = `add device 1: /dev/input/event0
  name:     "accelerometer"
  events:
    ABS (0003): 0000  : value 0, min -100, max 100, fuzz 0, flat 0, resolution 0
                0001  : value 0, min -100, max 100, fuzz 0, flat 0, resolution 0
                0002  : value 0, min -100, max 100, fuzz 0, flat 0, resolution 0
  input props:
    <none>
add device 2: /dev/input/event3
  name:     "touchscreen"
  events:
    KEY (0001): 014a 
    ABS (0003): 002f  : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                0035  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                0036  : value 0, min 0, max 1919, fuzz 0, flat 0, resolution 0
                0039  : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
                003a  : value 0, min 0, max 255, fuzz 0, flat 0, resolution 0
  input props:
    <none>
add device 3: /dev/input/event5
  name:     "pen"
  events:
    KEY (0001): 0140  014a  014b 
    ABS (0003): 0000  : value 0, min 0, max 2159, fuzz 0, flat 0, resolution 0
                0001  : value 0, min 0, max 3839, fuzz 0, flat 0, resolution 0
                0018  : value 0, min 0, max 1000, fuzz 0, flat 0, resolution 0
  input props:
    <none>
`;

const PEN_STROKE = [
  "[  1.000000] EV_KEY    BTN_TOOL_PEN         DOWN",
  "[  1.000001] EV_ABS    ABS_X                00000438",
  "[  1.000002] EV_ABS    ABS_Y                000005dc",
  "[  1.000003] EV_SYN    SYN_REPORT           00000000",
  "[  1.010000] EV_KEY    BTN_TOUCH            DOWN",
  "[  1.010001] EV_ABS    ABS_PRESSURE         00000064",
  "[  1.010002] EV_ABS    ABS_TILT_X           ffffffec",
  "[  1.010003] EV_SYN    SYN_REPORT           00000000",
  "[  1.020000] EV_ABS    ABS_PRESSURE         000000c8",
  "[  1.020001] EV_SYN    SYN_REPORT           00000000",
  "[  1.030000] EV_ABS    ABS_PRESSURE         00000000",
  "[  1.030001] EV_KEY    BTN_TOUCH            UP",
  "[  1.030002] EV_KEY    BTN_TOOL_PEN         UP",
  "[  1.030003] EV_SYN    SYN_REPORT           00000000",
];

function run(
  lines: string[],
  opts: { singleTouch?: boolean; range?: { min: number; max: number } } = {},
): { frames: RawTouchFrame[]; gestures: GestureEvent[] } {
  const reconstructor = new TouchFrameReconstructor({ singleTouch: opts.singleTouch });
  const classifier = new GestureClassifier(
    buildScaler({
      xMin: 0,
      xMax: 1079,
      yMin: 0,
      yMax: 1919,
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: 0,
    }),
    1,
    opts.range,
  );
  const frames: RawTouchFrame[] = [];
  const gestures: GestureEvent[] = [];
  let t = 1000;
  for (const line of lines) {
    const result = reconstructor.feedLine(line, (t += 10));
    if (result && "activeSlots" in result) {
      frames.push(result);
      const gesture = classifier.feedFrame(result);
      if (gesture) {
        gestures.push(gesture);
      }
    }
  }
  return { frames, gestures };
}

describe("InputNodeDiscovery.parseInputNodes", () => {
  test("finds a single-touch pen node with its pressure range", () => {
    const { touch, pen } = parseInputNodes(PEN_ONLY_P);
    expect(touch).toBeNull();
    expect(pen).toEqual([
      {
        path: "/dev/input/event5",
        name: "Wacom Pen",
        axisXMin: 0,
        axisXMax: 20000,
        axisYMin: 0,
        axisYMax: 30000,
        kind: "pen",
        pressureMin: 0,
        pressureMax: 4095,
        tiltAxes: {
          x: { min: -90, max: 90, resolution: 0 },
          y: { min: -90, max: 90, resolution: 0 },
        },
      },
    ]);
  });

  test("preserves tilt resolution and omits tilt metadata with one missing axis", () => {
    const input = PEN_ONLY_P.replaceAll("resolution 0", "resolution 57");
    expect(parseInputNodes(input).pen[0].tiltAxes).toEqual({
      x: { min: -90, max: 90, resolution: 57 },
      y: { min: -90, max: 90, resolution: 57 },
    });
    const missingY = input
      .split("\n")
      .filter((line) => !line.includes("001b"))
      .join("\n");
    expect(parseInputNodes(missingY).pen[0].tiltAxes).toBeUndefined();
  });

  test("separates touch and pen nodes and ignores an accelerometer", () => {
    const { touch, pen } = parseInputNodes(TOUCH_AND_PEN_P);
    expect(touch).toMatchObject({
      path: "/dev/input/event3",
      kind: "touch",
      axisXMax: 1079,
      pressureMax: 255,
    });
    expect(pen.map((node) => node.path)).toEqual(["/dev/input/event5"]);
    expect(pen[0]).toMatchObject({ axisXMax: 2159, axisYMax: 3839, pressureMax: 1000 });
  });
});

describe("pen contacts", () => {
  test("a single-touch pen stroke becomes a stylus tap with normalized pressure", () => {
    const { frames, gestures } = run(PEN_STROKE, {
      singleTouch: true,
      range: { min: 0, max: 400 },
    });
    // Hover frame has no contact; the pen only counts from BTN_TOUCH.
    expect(frames[0].activeSlots).toEqual([]);
    expect(frames[1].activeSlots[0]).toMatchObject({
      x: 1080,
      y: 1500,
      pressure: 100,
      toolType: "stylus",
      tiltX: -20,
    });
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({
      type: "tap",
      toolType: "stylus",
      pressure: { min: 0.25, max: 0.5, mean: 0.375, normalized: true },
    });
  });

  test("pressure stays raw without an axis range", () => {
    const { gestures } = run(PEN_STROKE, { singleTouch: true });
    expect(gestures[0].pressure).toEqual({ min: 100, max: 200, mean: 150, normalized: false });
  });

  test("eraser and stylus buttons are carried", () => {
    const lines = [
      "[  1.0] EV_KEY    BTN_TOOL_RUBBER      DOWN",
      "[  1.0] EV_KEY    BTN_STYLUS           DOWN",
      "[  1.0] EV_KEY    BTN_STYLUS2          DOWN",
      "[  1.0] EV_ABS    ABS_X                00000010",
      "[  1.0] EV_ABS    ABS_Y                00000020",
      "[  1.0] EV_ABS    ABS_PRESSURE         00000010",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { gestures } = run(lines, { singleTouch: true });
    expect(gestures[0]).toMatchObject({
      toolType: "eraser",
      buttons: ["stylusPrimary", "stylusSecondary"],
    });
  });

  test("an MT pen reports toolType from ABS_MT_TOOL_TYPE and pressure from ABS_MT_PRESSURE", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_ABS    ABS_MT_PRESSURE      00000080",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { gestures } = run(lines, { range: { min: 0, max: 255 } });
    expect(gestures[0]).toMatchObject({ toolType: "stylus", pressure: { normalized: true } });
  });

  test("BTN_TOOL_RUBBER turns an MT pen contact into an eraser", () => {
    const lines = [
      "[  1.0] EV_KEY    BTN_TOOL_RUBBER      DOWN",
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_KEY    BTN_TOOL_RUBBER      UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { frames, gestures } = run(lines);
    expect(frames[0].activeSlots[0].toolType).toBe("eraser");
    expect(gestures[0].toolType).toBe("eraser");
  });

  test("an explicit MT finger stays a finger while an eraser is in range", () => {
    const lines = [
      "[  1.0] EV_KEY    BTN_TOOL_RUBBER      DOWN",
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000000",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { frames, gestures } = run(lines);
    expect(frames[0].activeSlots[0].toolType).toBeUndefined();
    expect(gestures[0].toolType).toBeUndefined();
  });

  test("on an MT node a finger in another slot never takes the node-wide eraser or buttons", () => {
    const lines = [
      "[  1.0] EV_KEY    BTN_TOOL_RUBBER      DOWN",
      "[  1.0] EV_KEY    BTN_STYLUS           DOWN",
      "[  1.0] EV_ABS    ABS_MT_SLOT          00000000",
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_ABS    ABS_MT_SLOT          00000001",
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000002",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    00000100",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    00000200",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
    ];
    const [frame] = run(lines).frames;
    const bySlot = new Map(frame.activeSlots.map((slot) => [slot.slotId, slot]));
    expect(bySlot.get(0)?.toolType).toBe("eraser");
    expect(bySlot.get(0)?.buttons).toEqual(["stylusPrimary"]);
    expect(bySlot.get(1)?.toolType).toBeUndefined();
    expect(bySlot.get(1)?.buttons).toBeUndefined();
  });

  test("an MT pen hovering with ABS_MT_DISTANCE > 0 is not a contact", () => {
    const hoverOnly = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_DISTANCE      00000005",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_POSITION_X    000001b0",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
      "[  1.2] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.2] EV_SYN    SYN_REPORT           00000000",
    ];
    const hover = run(hoverOnly);
    expect(hover.frames.every((frame) => frame.activeSlots.length === 0)).toBe(true);
    expect(hover.gestures).toEqual([]);
  });

  test("an MT pen that touches and lifts back into hover records one contact", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_DISTANCE      00000005",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_DISTANCE      00000000",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
      "[  1.2] EV_ABS    ABS_MT_DISTANCE      00000004",
      "[  1.2] EV_SYN    SYN_REPORT           00000000",
      "[  1.3] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.3] EV_SYN    SYN_REPORT           00000000",
    ];
    const { frames, gestures } = run(lines);
    expect(frames[1].activeSlots.map((slot) => slot.slotId)).toEqual([0]);
    expect(frames[2].releasedSlots).toEqual([0]);
    expect(gestures).toHaveLength(1);
    expect(gestures[0].toolType).toBe("stylus");
  });

  test("a single-touch pen keeps the final move sent in its release packet", () => {
    const lines = [
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_ABS    ABS_X                00000064",
      "[  1.0] EV_ABS    ABS_Y                00000064",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_X                00000384",
      "[  1.1] EV_ABS    ABS_Y                00000384",
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { frames, gestures } = run(lines, { singleTouch: true });
    expect(frames[1].releasedFinalSamples?.map((slot) => [slot.x, slot.y])).toEqual([[900, 900]]);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ type: "swipe", toolType: "stylus" });
    expect(gestures[0].endX).toBeGreaterThan(800);
    expect(gestures[0].endY).toBeGreaterThan(800);
  });

  test("an MT pen keeps the move it makes while lifting into hover", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    00000064",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    00000064",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_DISTANCE      00000004",
      "[  1.1] EV_ABS    ABS_MT_POSITION_X    00000384",
      "[  1.1] EV_ABS    ABS_MT_POSITION_Y    00000384",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { gestures } = run(lines);
    expect(gestures).toHaveLength(1);
    expect(gestures[0]).toMatchObject({ type: "swipe", toolType: "stylus" });
    expect(gestures[0].endX).toBeGreaterThan(800);
  });

  test("a release with no move in its packet keeps the plain frame shape", () => {
    const { frames } = run(PEN_STROKE, { singleTouch: true });
    expect(frames.every((frame) => !("releasedFinalSamples" in frame))).toBe(true);
  });

  test("a pen whose tool key predates the recording still ends its contact on tool-up", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_X                00000438",
      "[  1.0] EV_ABS    ABS_Y                000005dc",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_KEY    BTN_TOOL_PEN         UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { gestures } = run(lines, { singleTouch: true });
    expect(gestures.map((gesture) => [gesture.type, gesture.toolType])).toEqual([
      ["tap", "stylus"],
    ]);
  });

  test("a pen-node contact is a stylus even when its tool key predates the recording", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_X                000001a4",
      "[  1.0] EV_ABS    ABS_Y                000002b0",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { gestures } = run(lines, { singleTouch: true });
    expect(gestures).toHaveLength(1);
    expect(gestures[0].toolType).toBe("stylus");
  });

  test("single-touch axes are ignored on a multitouch node", () => {
    const { frames } = run(PEN_STROKE);
    expect(frames.every((frame) => frame.activeSlots.length === 0)).toBe(true);
  });

  test("a finger tap keeps its exact shape", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { frames, gestures } = run(lines);
    expect(Object.keys(frames[0].activeSlots[0]).sort()).toEqual(
      ["pressure", "slotId", "trackingId", "x", "y"].sort(),
    );
    expect(Object.keys(gestures[0]).sort()).toEqual(
      ["arrivedAt", "screenX", "screenY", "type"].sort(),
    );
  });
});

describe("parser parity and real layouts", () => {
  test("named and hex layouts preserve the same declared pen metadata", () => {
    // This named fixture does not list tilt; compare its declared axes only.
    const { tiltAxes, ...hexPen } = parseInputNodes(PEN_ONLY_P).pen[0];
    expect(parseInputNodes(PEN_ONLY_LP).pen).toEqual([hexPen]);
    const namedTilt = PEN_ONLY_P.replace("001a  :", "ABS_TILT_X :").replace(
      "001b  :",
      "ABS_TILT_Y :",
    );
    expect(parseInputNodes(namedTilt).pen[0].tiltAxes).toEqual(tiltAxes);
  });

  test("parseInputNodes().touch is parseTouchNodes()[0] for every captured getevent -p", () => {
    const captures = readdirSync(`${__dirname}/../../../fixtures/android-touch-node`).filter(
      (name) => name.startsWith("getevent-p-"),
    );
    expect(captures.length).toBeGreaterThan(0);
    for (const name of captures) {
      const text = readTouchNodeCapture(name);
      expect(parseInputNodes(text).touch).toEqual(parseTouchNodes(text)[0] ?? null);
    }
  });

  test("a pen tool key outside the KEY block does not make an accelerometer a pen", () => {
    const text = `add device 1: /dev/input/event0
  name:     "accel 0140"
  events:
    ABS (0003): 0000  : value 0, min 0, max 100, fuzz 0, flat 0, resolution 0
                0001  : value 0, min 0, max 100, fuzz 0, flat 0, resolution 0
`;
    expect(parseInputNodes(text).pen).toEqual([]);
  });
});

describe("a slot reused by a pen then a finger", () => {
  const tapLines = (trackingId: string, toolType: string): string[] => [
    `[  1.0] EV_ABS    ABS_MT_TRACKING_ID   ${trackingId}`,
    `[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     ${toolType}`,
    "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
    "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
    "[  1.0] EV_SYN    SYN_REPORT           00000000",
    "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
    "[  1.0] EV_SYN    SYN_REPORT           00000000",
  ];

  test("a pen tap and a quick finger tap in the same place stay two taps", () => {
    const { gestures } = run([
      ...tapLines("00000001", "00000001"),
      ...tapLines("00000002", "00000000"),
    ]);
    expect(gestures.map((gesture) => [gesture.type, gesture.toolType])).toEqual([
      ["tap", "stylus"],
      ["tap", undefined],
    ]);
  });

  test("two quick pen taps in the same place still make a double tap", () => {
    const { gestures } = run([
      ...tapLines("00000001", "00000001"),
      ...tapLines("00000002", "00000001"),
    ]);
    expect(gestures.map((gesture) => gesture.type)).toEqual(["tap", "doubleTap"]);
  });

  test("pen state does not leak into the finger contact", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_ABS    ABS_TILT_X           0000000a",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
      "[  2.0] EV_ABS    ABS_MT_TRACKING_ID   00000002",
      "[  2.0] EV_ABS    ABS_MT_TOOL_TYPE     00000000",
      "[  2.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  2.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  2.0] EV_SYN    SYN_REPORT           00000000",
      "[  2.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  2.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { frames, gestures } = run(lines);
    expect(frames[0].activeSlots[0].toolType).toBe("stylus");
    expect(Object.keys(frames[2].activeSlots[0]).sort()).toEqual(
      ["pressure", "slotId", "trackingId", "x", "y"].sort(),
    );
    expect(gestures[0].toolType).toBe("stylus");
    expect(gestures[1].toolType).toBeUndefined();
  });

  test("a second pen contact keeps the stylus tool type the kernel does not re-send", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
      "[  2.0] EV_ABS    ABS_MT_TRACKING_ID   00000002",
      "[  2.0] EV_ABS    ABS_MT_POSITION_X    000001b0",
      "[  2.0] EV_ABS    ABS_MT_POSITION_Y    000002c0",
      "[  2.0] EV_SYN    SYN_REPORT           00000000",
      "[  2.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  2.1] EV_SYN    SYN_REPORT           00000000",
    ];
    const { gestures } = run(lines);
    expect(gestures.map((gesture) => gesture.toolType)).toEqual(["stylus", "stylus"]);
  });

  test("a second pen contact keeps the tilt the kernel does not re-send", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_TILT_X           0000000a",
      "[  1.0] EV_ABS    ABS_TILT_Y           fffffffb",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
      "[  2.0] EV_ABS    ABS_MT_TRACKING_ID   00000002",
      "[  2.0] EV_ABS    ABS_MT_POSITION_X    000001b0",
      "[  2.0] EV_ABS    ABS_MT_POSITION_Y    000002c0",
      "[  2.0] EV_SYN    SYN_REPORT           00000000",
    ];
    const contacts = run(lines).frames.filter((frame) => frame.activeSlots.length > 0);
    expect(
      contacts.map((frame) => [frame.activeSlots[0].tiltX, frame.activeSlots[0].tiltY]),
    ).toEqual([
      [10, -5],
      [10, -5],
    ]);
  });

  test("an explicit finger tool type clears a pen tool type", () => {
    const lines = [
      "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000001",
      "[  1.0] EV_ABS    ABS_MT_TOOL_TYPE     00000000",
      "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
    ];
    expect(run(lines).frames[0].activeSlots[0].toolType).toBeUndefined();
  });

  test("a pen leaving range ends a single-touch contact without BTN_TOUCH UP", () => {
    const lines = PEN_STROKE.filter((line) => !line.includes("BTN_TOUCH            UP"));
    expect(run(lines, { singleTouch: true }).gestures).toHaveLength(1);
  });
});

class ReaderAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

afterEach(() => mock.restore());

function penReader(tiltAxes?: TiltAxes) {
  const adb = new ReaderAdb();
  const procs = new Map<string, FakeAdbProcess>([
    ["/dev/input/event3", new FakeAdbProcess()],
    ["/dev/input/event5", new FakeAdbProcess()],
  ]);
  adb.spawn.mockImplementation(async (args) => procs.get(args[args.length - 1])!);
  const timer = new FakeTimer();
  timer.advanceTime(1000);
  const { touch, pen } = parseInputNodes(TOUCH_AND_PEN_P);
  const scaler = (xMax: number, yMax: number) =>
    buildScaler({
      xMin: 0,
      xMax,
      yMin: 0,
      yMax,
      displayWidth: 1080,
      displayHeight: 1920,
      rotation: 0,
    });
  const reader = new GetEventReader({
    adb,
    timer,
    density: 1,
    touchNode: touch!,
    scaler: scaler(1079, 1919),
    penNodes: [{ node: { ...pen[0], tiltAxes }, scaler: scaler(2159, 3839) }],
  });
  const onGesture = mock<(event: GestureEvent) => void>();
  const onError = mock<(error: Error) => void>();
  return {
    adb,
    touchProc: procs.get("/dev/input/event3")!,
    penProc: procs.get("/dev/input/event5")!,
    reader,
    onGesture,
    onError,
  };
}

const emitLines = (proc: FakeAdbProcess, lines: string[]): void => {
  proc.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
};

describe("GetEventReader with touch and pen nodes", () => {
  test("spawns one single-path process per node and attributes events per process", async () => {
    const { adb, penProc, touchProc, reader, onGesture } = penReader();
    reader.start(onGesture);
    await Promise.resolve();
    await Promise.resolve();
    expect(adb.spawn.mock.calls.map(([args]) => args)).toEqual([
      ["shell", "getevent", "-lt", "/dev/input/event3"],
      ["shell", "getevent", "-lt", "/dev/input/event5"],
    ]);
    emitLines(penProc, [
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_ABS    ABS_X                00000438",
      "[  1.0] EV_ABS    ABS_Y                000005dc",
      "[  1.0] EV_ABS    ABS_PRESSURE         000001f4",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ]);
    expect(onGesture).toHaveBeenCalledTimes(1);
    expect(onGesture.mock.calls[0][0]).toMatchObject({
      type: "tap",
      screenX: 540,
      screenY: 750,
      toolType: "stylus",
      pressure: { min: 0.5, max: 0.5, mean: 0.5, normalized: true },
    });
    emitLines(touchProc, [
      "[  2.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  2.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  2.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  2.0] EV_SYN    SYN_REPORT           00000000",
      "[  2.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  2.1] EV_SYN    SYN_REPORT           00000000",
    ]);
    expect(onGesture).toHaveBeenCalledTimes(2);
    expect(onGesture.mock.calls[1][0].toolType).toBeUndefined();
    reader.stop();
  });

  test.each([true, false])(
    "reader uses discovered tilt metadata when available (%s)",
    async (known) => {
      const axes = parseInputNodes(PEN_ONLY_P).pen[0].tiltAxes;
      expect(axes).toBeDefined();
      const { penProc, reader, onGesture } = penReader(known ? axes : undefined);
      reader.start(onGesture);
      await Promise.resolve();
      await Promise.resolve();
      // Supply the second axis absent from the existing stroke input.
      const lines = PEN_STROKE.flatMap((line) =>
        line.includes("ABS_TILT_X") ? [line, line.replace("ABS_TILT_X", "ABS_TILT_Y")] : [line],
      );
      emitLines(penProc, lines);
      const contact = onGesture.mock.calls
        .map(([event]) => event)
        .find((event) => event.type === "tap");
      expect(contact).toBeDefined();
      if (known) {
        expect(contact?.tilt).toBeCloseTo(0.4885, 4);
      } else {
        expect(contact?.tilt).toBeUndefined();
      }
      reader.stop();
    },
  );

  test("a pen that only hovers reaches the recorder as a hover event", async () => {
    const { penProc, reader, onGesture } = penReader();
    reader.start(onGesture);
    await Promise.resolve();
    await Promise.resolve();
    emitLines(penProc, [
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_ABS    ABS_X                00000438",
      "[  1.0] EV_ABS    ABS_Y                000005dc",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
      "[  1.1] EV_KEY    BTN_TOOL_PEN         UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ]);

    expect(onGesture).toHaveBeenCalledTimes(1);
    expect(onGesture.mock.calls[0][0]).toMatchObject({ type: "hover", toolType: "stylus" });
    reader.stop();
  });

  test("a pen process failure is logged and the touch process keeps recording", async () => {
    const { touchProc, penProc, reader, onGesture, onError } = penReader();
    reader.start(onGesture, onError);
    await Promise.resolve();
    await Promise.resolve();
    penProc.emit("error", new Error("pen node vanished"));
    expect(onError).not.toHaveBeenCalled();
    expect(touchProc.killed).toBe(false);
    emitLines(touchProc, [
      "[  2.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
      "[  2.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
      "[  2.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
      "[  2.0] EV_SYN    SYN_REPORT           00000000",
      "[  2.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
      "[  2.1] EV_SYN    SYN_REPORT           00000000",
    ]);
    expect(onGesture).toHaveBeenCalledTimes(1);
    reader.stop();
  });

  test("a touch process failure is reported", async () => {
    const { touchProc, reader, onGesture, onError } = penReader();
    reader.start(onGesture, onError);
    await Promise.resolve();
    await Promise.resolve();
    touchProc.emit("error", new Error("touch gone"));
    expect(onError).toHaveBeenCalledTimes(1);
    reader.stop();
  });

  test("stop() kills every child", async () => {
    const { touchProc, penProc, reader, onGesture } = penReader();
    reader.start(onGesture);
    await Promise.resolve();
    await Promise.resolve();
    reader.stop();
    expect(touchProc.killed).toBe(true);
    expect(penProc.killed).toBe(true);
    expect(touchProc.stdout.listenerCount("data")).toBe(0);
    expect(penProc.stdout.listenerCount("data")).toBe(0);
  });
});
