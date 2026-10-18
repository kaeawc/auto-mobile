import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildScaler } from "../../../../src/features/record/android/AxisRanges";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import { splitDeviceLine } from "../../../../src/features/record/android/GetEventLine";
import { parseInputNodes } from "../../../../src/features/record/android/InputNodeDiscovery";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import type { GestureEvent, RawTouchFrame } from "../../../../src/features/record/android/types";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Hand-written `getevent -p` / `-lt` probes in the shape the parsers expect (not device captures).
const PEN_ONLY_P = `
add device 1: /dev/input/event5
  name:     "Wacom Pen"
  events:
    KEY (0001): 0140  0141  0145  014a  014b
    ABS (0003): 0000  0001  0018  001a  001b
  absinfo:
    0000  : value 0, min 0, max 20000, fuzz 0, flat 0, resolution 100
    0001  : value 0, min 0, max 30000, fuzz 0, flat 0, resolution 100
    0018  : value 0, min 0, max 4095, fuzz 0, flat 0, resolution 0
    001a  : value 0, min -90, max 90, fuzz 0, flat 0, resolution 0
    001b  : value 0, min -90, max 90, fuzz 0, flat 0, resolution 0
`;

const TOUCH_AND_PEN_PL = `
add device 1: /dev/input/event0
  name:     "accelerometer"
  events:
    ABS (0003): ABS_X (0000)  ABS_Y (0001)  ABS_Z (0002)
  absinfo:
    ABS_X (0000): value 0, min -100, max 100, fuzz 0, flat 0, resolution 0
    ABS_Y (0001): value 0, min -100, max 100, fuzz 0, flat 0, resolution 0
add device 2: /dev/input/event3
  name:     "touchscreen"
  events:
    ABS (0003): ABS_MT_SLOT (002f)  ABS_MT_POSITION_X (0035)  ABS_MT_POSITION_Y (0036)
  absinfo:
    ABS_MT_POSITION_X (0035): value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
    ABS_MT_POSITION_Y (0036): value 0, min 0, max 1919, fuzz 0, flat 0, resolution 0
    ABS_MT_PRESSURE (003a): value 0, min 0, max 255, fuzz 0, flat 0, resolution 0
add device 3: /dev/input/event5
  name:     "pen"
  events:
    KEY (0001): BTN_TOOL_PEN  BTN_TOUCH  BTN_STYLUS
    ABS (0003): ABS_X (0000)  ABS_Y (0001)  ABS_PRESSURE (0018)
  absinfo:
    ABS_X (0000): value 0, min 0, max 2159, fuzz 0, flat 0, resolution 0
    ABS_Y (0001): value 0, min 0, max 3839, fuzz 0, flat 0, resolution 0
    ABS_PRESSURE (0018): value 0, min 0, max 1000, fuzz 0, flat 0, resolution 0
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
      },
    ]);
  });

  test("separates touch and pen nodes and ignores an accelerometer", () => {
    const { touch, pen } = parseInputNodes(TOUCH_AND_PEN_PL);
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

describe("splitDeviceLine", () => {
  test("strips the device prefix and leaves unprefixed lines alone", () => {
    expect(
      splitDeviceLine("[  77.5] /dev/input/event2: EV_ABS       ABS_X                00000123"),
    ).toEqual({
      path: "/dev/input/event2",
      line: "[  77.5] EV_ABS       ABS_X                00000123",
    });
    const plain = "[  1.0] EV_SYN    SYN_REPORT           00000000";
    expect(splitDeviceLine(plain)).toEqual({ path: null, line: plain });
  });
});

class ReaderAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

afterEach(() => mock.restore());

describe("GetEventReader with touch and pen nodes", () => {
  test("reads both paths in one process and attributes lines per node", async () => {
    const adb = new ReaderAdb();
    const proc = new FakeAdbProcess();
    adb.spawn.mockResolvedValue(proc);
    const timer = new FakeTimer();
    timer.advanceTime(1000);
    const { touch, pen } = parseInputNodes(TOUCH_AND_PEN_PL);
    const scaler = (xMax: number, yMax: number, w: number, h: number) =>
      buildScaler({
        xMin: 0,
        xMax,
        yMin: 0,
        yMax,
        displayWidth: w,
        displayHeight: h,
        rotation: 0,
      });
    const reader = new GetEventReader({
      adb,
      timer,
      density: 1,
      touchNode: touch!,
      scaler: scaler(1079, 1919, 1080, 1920),
      penNodes: [{ node: pen[0], scaler: scaler(2159, 3839, 1080, 1920) }],
    });
    const onGesture = mock<(event: GestureEvent) => void>();
    reader.start(onGesture);
    await Promise.resolve();
    expect(adb.spawn).toHaveBeenCalledWith([
      "shell",
      "getevent",
      "-lt",
      "/dev/input/event3",
      "/dev/input/event5",
    ]);
    const p = "/dev/input/event5: ";
    const lines = [
      `[  1.0] ${p}EV_KEY    BTN_TOOL_PEN         DOWN`,
      `[  1.0] ${p}EV_ABS    ABS_X                00000438`,
      `[  1.0] ${p}EV_ABS    ABS_Y                000005dc`,
      `[  1.0] ${p}EV_ABS    ABS_PRESSURE         000001f4`,
      `[  1.0] ${p}EV_KEY    BTN_TOUCH            DOWN`,
      `[  1.0] ${p}EV_SYN    SYN_REPORT           00000000`,
      `[  1.1] ${p}EV_KEY    BTN_TOUCH            UP`,
      `[  1.1] ${p}EV_SYN    SYN_REPORT           00000000`,
    ];
    proc.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
    expect(onGesture).toHaveBeenCalledTimes(1);
    expect(onGesture.mock.calls[0][0]).toMatchObject({
      type: "tap",
      screenX: 540,
      screenY: 750,
      toolType: "stylus",
      pressure: { min: 0.5, max: 0.5, mean: 0.5, normalized: true },
    });
    reader.stop();
  });
});
