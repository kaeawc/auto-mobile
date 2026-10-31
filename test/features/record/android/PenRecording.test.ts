import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readTouchNodeCapture } from "../../../helpers/touchNodeCaptures";
import { parseInputNodes } from "../../../../src/features/record/android/InputNodeDiscovery";
import { DualTrackRecorder } from "../../../../src/features/record/android/DualTrackRecorder";
import { buildScaler } from "../../../../src/features/record/android/AxisRanges";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import { ScreenGeometryTimeline } from "../../../../src/features/record/android/ScreenGeometryTimeline";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import type {
  A11ySource,
  GestureEmitter,
  GestureEvent,
} from "../../../../src/features/record/android/types";
import type { BootedDevice } from "../../../../src/models";
import { defaultAdbClientFactory } from "../../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Test", platform: "android" };

// Real `getevent -p` layout (first axis on the `ABS (0003):` line), touch plus pen node.
const GETEVENT_P = `add device 1: /dev/input/event3
  name:     "touchscreen"
  events:
    KEY (0001): 014a 
    ABS (0003): 002f  : value 0, min 0, max 9, fuzz 0, flat 0, resolution 0
                0035  : value 0, min 0, max 1079, fuzz 0, flat 0, resolution 0
                0036  : value 0, min 0, max 1919, fuzz 0, flat 0, resolution 0
                0039  : value 0, min 0, max 65535, fuzz 0, flat 0, resolution 0
  input props:
    <none>
add device 2: /dev/input/event5
  name:     "pen"
  events:
    KEY (0001): 0140  014a  014b 
    ABS (0003): 0000  : value 0, min 0, max 2159, fuzz 0, flat 0, resolution 0
                0001  : value 0, min 0, max 3839, fuzz 0, flat 0, resolution 0
                0018  : value 0, min 0, max 1000, fuzz 0, flat 0, resolution 0
  input props:
    <none>
`;

const noA11y: A11ySource = {
  ensureConnected: async () => true,
  getSupportedCommands: async () => [],
  onInteraction: () => () => {},
};

class ReaderAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

afterEach(() => mock.restore());

describe("DualTrackRecorder reading a touch and a pen node", () => {
  test("spawns both nodes and a pen tap yields a step", async () => {
    const adb = new ReaderAdb();
    adb.setCommandResponse("getevent -p", { stdout: GETEVENT_P, stderr: "" } as never);
    adb.setCommandResponse("wm size", { stdout: "Physical size: 1080x1920", stderr: "" } as never);
    const touchProc = new FakeAdbProcess();
    const penProc = new FakeAdbProcess();
    adb.spawn.mockImplementation(async (args) =>
      args[args.length - 1] === "/dev/input/event5" ? penProc : touchProc,
    );
    spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
    const timer = new FakeTimer();
    timer.advanceTime(1000);
    const recorder = new DualTrackRecorder(device, undefined, noA11y, { timer });
    await recorder.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(adb.spawn.mock.calls.map(([args]) => args)).toEqual([
      ["shell", "getevent", "-lt", "/dev/input/event3"],
      ["shell", "getevent", "-lt", "/dev/input/event5"],
    ]);
    const feed = (lines: string[]): void => {
      penProc.stdout.emit("data", Buffer.from(lines.join("\n") + "\n"));
    };
    feed([
      "[  1.0] EV_KEY    BTN_TOOL_PEN         DOWN",
      "[  1.0] EV_ABS    ABS_X                00000438",
      "[  1.0] EV_ABS    ABS_Y                000005dc",
      "[  1.0] EV_ABS    ABS_PRESSURE         000001f4",
      "[  1.0] EV_KEY    BTN_TOUCH            DOWN",
      "[  1.0] EV_SYN    SYN_REPORT           00000000",
    ]);
    timer.advanceTime(50);
    feed([
      "[  1.1] EV_KEY    BTN_TOUCH            UP",
      "[  1.1] EV_SYN    SYN_REPORT           00000000",
    ]);
    const result = await recorder.stop({ hostOnly: true });
    expect(result.steps.map((step) => step.tool)).toEqual(["tapAt"]);
    expect(touchProc.killed).toBe(true);
    expect(penProc.killed).toBe(true);
  });
});

describe("pressure in recorded plan steps", () => {
  const FINGER = (pressure: boolean): string[] => [
    "[  1.0] EV_ABS    ABS_MT_TRACKING_ID   00000001",
    "[  1.0] EV_ABS    ABS_MT_POSITION_X    000001a4",
    "[  1.0] EV_ABS    ABS_MT_POSITION_Y    000002b0",
    ...(pressure ? ["[  1.0] EV_ABS    ABS_MT_PRESSURE      00000080"] : []),
    "[  1.0] EV_SYN    SYN_REPORT           00000000",
    "[  1.1] EV_ABS    ABS_MT_TRACKING_ID   ffffffff",
    "[  1.1] EV_SYN    SYN_REPORT           00000000",
  ];

  function classify(lines: string[]): GestureEvent {
    const reconstructor = new TouchFrameReconstructor();
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
      { min: 0, max: 255 },
    );
    let t = 1000;
    let gesture: GestureEvent | null = null;
    for (const line of lines) {
      const frame = reconstructor.feedLine(line, (t += 50));
      if (frame && "activeSlots" in frame) {
        gesture = classifier.feedFrame(frame) ?? gesture;
      }
    }
    return gesture!;
  }

  async function stepsFor(gesture: GestureEvent) {
    let emit: ((event: GestureEvent) => void) | undefined;
    const emitter: GestureEmitter = {
      start: (onGesture) => {
        emit = onGesture;
      },
      stop: () => {},
    };
    const recorder = new DualTrackRecorder(device, emitter, noA11y, { timer: new FakeTimer() });
    await recorder.start();
    emit!(gesture);
    return (await recorder.stop()).steps;
  }

  test("captured node with BTN_STYLUS remains a multitouch node", () => {
    const nodes = parseInputNodes(readTouchNodeCapture("getevent-p-touch-node-emulator-5600.txt"));
    expect(nodes.touch).toMatchObject({
      path: "/dev/input/event1",
      pressureMin: 0,
      pressureMax: 1024,
    });
    expect(nodes.pen).toEqual([]);
  });

  test("captured probe pressure normalizes before stylus plan export", async () => {
    const classifier = new GestureClassifier({ toScreenPoint: (x, y) => ({ x, y }) }, 1, {
      min: 0,
      max: 4095,
    });
    classifier.feedFrame({
      arrivedAt: 0,
      releasedSlots: [],
      activeSlots: [
        {
          slotId: 0,
          trackingId: 1,
          x: 500,
          y: 2050,
          pressure: 4000,
          toolType: "stylus",
          buttons: ["stylusPrimary"],
        },
      ],
    });
    classifier.feedFrame({
      arrivedAt: 20,
      releasedSlots: [],
      activeSlots: [
        {
          slotId: 0,
          trackingId: 1,
          x: 700,
          y: 2050,
          pressure: 4000,
          toolType: "stylus",
          buttons: [],
        },
      ],
    });
    const gesture = classifier.feedFrame({ arrivedAt: 50, releasedSlots: [0], activeSlots: [] });
    expect(gesture?.pressure?.mean).toBe(0.9768);
    expect((await stepsFor(gesture!))[0].params.pointer).toEqual({
      toolType: "stylus",
      pressure: 0.9768,
      buttons: ["primary"],
    });
  });

  test("a pressured finger tap records the same step as an unpressured one", async () => {
    const withPressure = classify(FINGER(true));
    const without = classify(FINGER(false));
    expect(withPressure.pressure).toEqual({
      min: 0.502,
      max: 0.502,
      mean: 0.502,
      normalized: true,
    });
    expect(without.pressure).toBeUndefined();
    const steps = await stepsFor(withPressure);
    expect(steps).toHaveLength(1);
    expect(steps).toEqual(await stepsFor(without));
  });
});

describe("pen timelines follow the primary geometry", () => {
  test("a rotation applied to the primary timeline reaches the follower's scaler", () => {
    const display = { width: 1080, height: 1920 };
    const penAxes = { xMin: 0, xMax: 2159, yMin: 0, yMax: 3839 };
    const primary = new ScreenGeometryTimeline(
      { xMin: 0, xMax: 1079, yMin: 0, yMax: 1919 },
      { rotation: 0, display },
      0,
    );
    const follower = new ScreenGeometryTimeline(penAxes, { rotation: 0, display }, 0);
    primary.follow(follower);
    primary.noteChangeReported(5);
    primary.apply({ rotation: 1, display: { width: 1080, height: 1920 } }, 5);
    const expected = new ScreenGeometryTimeline(penAxes, { rotation: 1, display }, 0)
      .scalerAt(0)
      .toScreenPoint(1000, 2000);
    expect(follower.scalerAt(10).toScreenPoint(1000, 2000)).toEqual(expected);
    expect(follower.scalerAt(0).toScreenPoint(1000, 2000)).not.toEqual(expected);
    expect(follower.warningsFor(0, 10)).toEqual(primary.warningsFor(0, 10));
  });
});
