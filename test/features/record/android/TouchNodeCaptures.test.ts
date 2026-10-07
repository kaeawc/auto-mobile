import { describe, expect, test } from "bun:test";
import { ScreenGeometryTimeline } from "../../../../src/features/record/android/ScreenGeometryTimeline";
import {
  discoverTouchNode,
  parseTouchNodes,
} from "../../../../src/features/record/android/TouchNodeDiscovery";
import { TouchFrameReconstructor } from "../../../../src/features/record/android/TouchFrameReconstructor";
import type { RawTouchFrame, GestureEvent } from "../../../../src/features/record/android/types";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import {
  CAPTURE_AXES,
  CAPTURE_DISPLAY,
  captureFrames,
  readGestures,
  readTouchNodeCapture,
} from "../../../helpers/touchNodeCaptures";

// Real captures from a virtio_input_multi_touch emulator, taken 2026-10-06 (issue #10181
// follow-up; see test/fixtures/android-touch-node/README.md). Events were injected with
// `sendevent`, so the kernel reported only the axes whose value changed since the previous
// contact, and the touch node has no BTN_TOUCH key at all.
const TAP = "getevent-lt-tap-portrait-emulator-5600.txt";
const SWIPE = "getevent-lt-swipe-portrait-emulator-5600.txt";
const TAP_ROT90 = "getevent-lt-tap-landscape-rot90-emulator-5600.txt";
const SWIPE_ROT90 = "getevent-lt-swipe-landscape-rot90-emulator-5600.txt";
const TAP_ALL = "getevent-lt-tap-portrait-all-axes-emulator-5600.txt";
const SWIPE_ALL = "getevent-lt-swipe-portrait-all-axes-emulator-5600.txt";
const TAP_ROT90_ALL = "getevent-lt-tap-landscape-rot90-all-axes-emulator-5600.txt";
const SWIPE_ROT90_ALL = "getevent-lt-swipe-landscape-rot90-all-axes-emulator-5600.txt";

/** Rounding to whole pixels over a 32768-step axis: a mapped point is within 1 px of the injected one. */
const PX = 1;
const near = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThanOrEqual(PX);
};

function reconstruct(capture: string): RawTouchFrame[] {
  const reconstructor = new TouchFrameReconstructor();
  const frames: RawTouchFrame[] = [];
  for (const frame of captureFrames(capture)) {
    for (const line of frame.text.split("\n")) {
      const result = reconstructor.feedLine(line, frame.deviceMs);
      if (result && "activeSlots" in result) {
        frames.push(result);
      }
    }
  }
  return frames;
}

describe("the touch node's axis ranges (getevent -p)", () => {
  const portrait = readTouchNodeCapture("getevent-p-touch-node-emulator-5600.txt");
  const rotated = readTouchNodeCapture("getevent-p-touch-node-landscape-rot90-emulator-5600.txt");
  const node = {
    path: "/dev/input/event1",
    name: "virtio_input_multi_touch_1",
    axisXMin: 0,
    axisXMax: 32767,
    axisYMin: 0,
    axisYMax: 32767,
  };

  test("the repo's parser reads 0..32767 on both axes from the -p and -lp sections", () => {
    // The capture holds `getevent -p` (hex codes) then `getevent -lp` (named codes).
    expect(parseTouchNodes(portrait)).toEqual([node, node]);
  });

  test("the node reports the same range while the display is rotated", () => {
    expect(parseTouchNodes(rotated)).toEqual([node]);
  });

  test("the recorder's assumed range is the captured one", () => {
    expect(CAPTURE_AXES).toEqual({ xMin: 0, xMax: 32767, yMin: 0, yMax: 32767 });
    expect(node.axisXMax).toBe(CAPTURE_AXES.xMax);
    expect(node.axisYMax).toBe(CAPTURE_AXES.yMax);
  });

  test("discovery picks the node from `getevent -p` and keeps the captured range", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell getevent -p", rotated);
    expect(await discoverTouchNode(adb)).toEqual(node);
  });

  test("the node has no BTN_TOUCH key (only BTN_TOOL_RUBBER and BTN_STYLUS)", () => {
    expect(portrait).toContain("KEY (0001): 0141  014b");
    expect(portrait).toContain("BTN_TOOL_RUBBER");
    expect(portrait).toContain("BTN_STYLUS");
    expect(portrait).not.toContain("BTN_TOUCH");
    expect(portrait).not.toContain("014a");
  });
});

describe("contact start and end come from ABS_MT_TRACKING_ID, not BTN_TOUCH", () => {
  test.each([TAP, SWIPE, TAP_ROT90, SWIPE_ROT90, TAP_ALL, SWIPE_ALL])(
    "%s has no EV_KEY events yet yields a down frame and a release frame",
    (name) => {
      const capture = readTouchNodeCapture(name);
      // The `#` header lines mention BTN_TOUCH; only the event lines count.
      const events = capture.split("\n").filter((line) => line.startsWith("["));
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((line) => line.includes("EV_KEY") || line.includes("BTN_TOUCH"))).toBe(
        false,
      );

      const frames = reconstruct(capture);

      expect(frames[0].activeSlots).toHaveLength(1);
      expect(frames[0].releasedSlots).toEqual([]);
      const last = frames[frames.length - 1];
      expect(last.activeSlots).toEqual([]);
      expect(last.releasedSlots).toEqual([0]);
    },
  );

  test("every capture is classified into exactly one gesture without BTN_TOUCH", async () => {
    for (const name of [TAP, SWIPE, TAP_ROT90, SWIPE_ROT90, TAP_ALL, SWIPE_ALL]) {
      const gestures = await readGestures([{ capture: readTouchNodeCapture(name), rotation: 0 }]);
      expect(gestures).toHaveLength(1);
    }
  });
});

describe("axes the kernel did not report (a frame without ABS_MT_POSITION_X)", () => {
  test("a first contact with no POSITION_X keeps X unknown instead of inventing 0", () => {
    const [down] = reconstruct(readTouchNodeCapture(TAP));
    expect(down.activeSlots).toEqual([
      { slotId: 0, trackingId: 0x5b, x: NaN, y: 0x2555, pressure: 0, unknownAxes: ["x"] },
    ]);
  });

  test("a later contact with no POSITION_X reuses the slot's previous X", () => {
    // The all-axes swipe reports X (0x52f5); the dropped-axes tap that follows does not.
    const frames = reconstruct(readTouchNodeCapture(SWIPE_ALL) + readTouchNodeCapture(TAP));
    const swipeDown = frames[0].activeSlots[0];
    const tapDown = frames[frames.length - 2].activeSlots[0];
    expect(swipeDown.x).toBe(0x52f5);
    expect(tapDown).toEqual({ slotId: 0, trackingId: 0x5b, x: 0x52f5, y: 0x2555, pressure: 0x262 });
    expect(tapDown.unknownAxes).toBeUndefined();
  });

  test("a stream that never saw X emits tap and swipe with unknown axes and no coordinates", async () => {
    const gestures = await readGestures([
      { capture: readTouchNodeCapture(TAP), rotation: 0 },
      { capture: readTouchNodeCapture(SWIPE), rotation: 0 },
      { capture: readTouchNodeCapture(TAP_ROT90), rotation: 1 },
      { capture: readTouchNodeCapture(SWIPE_ROT90), rotation: 1 },
    ]);

    expect(gestures.map((gesture) => gesture.type)).toEqual(["tap", "swipe", "tap", "swipe"]);
    for (const gesture of gestures) {
      expect(gesture.unknownAxes).toEqual(["x"]);
      expect(gesture.screenX).toBeUndefined();
      expect(gesture.screenY).toBeUndefined();
      expect(gesture.direction).toBeUndefined();
      expect(gesture.startX).toBeUndefined();
    }
  });

  test("the all-axes portrait tap reports X but no Y, so a fresh stream cannot place it", async () => {
    // Its Y (0x2fff) equalled the previous contact's, so the kernel dropped it.
    const [tap] = await readGestures([{ capture: readTouchNodeCapture(TAP_ALL), rotation: 0 }]);
    expect(tap).toMatchObject({ type: "tap", unknownAxes: ["y"] });
    expect(tap.screenX).toBeUndefined();
  });

  test("a dropped-X tap after a contact that reported X lands at the reused X and the new Y", async () => {
    // tap-all reports X (0x238d) and leaves Y unknown; the dropped-X tap supplies Y (0x2555).
    const gestures = await readGestures([
      { capture: readTouchNodeCapture(TAP_ALL), rotation: 0 },
      { capture: readTouchNodeCapture(TAP), rotation: 0 },
    ]);

    expect(gestures[1]).toMatchObject({ type: "tap" });
    expect(gestures[1].unknownAxes).toBeUndefined();
    near(gestures[1].screenX, 300);
    near(gestures[1].screenY, 700);
  });

  test("a dropped-X swipe after an all-axes swipe keeps the reused X and classifies as up", async () => {
    const gestures = await readGestures([
      { capture: readTouchNodeCapture(SWIPE_ALL), rotation: 0 },
      { capture: readTouchNodeCapture(SWIPE), rotation: 0 },
    ]);

    expect(gestures[1]).toMatchObject({ type: "swipe", direction: "up", speed: "fast" });
    expect(gestures[1].unknownAxes).toBeUndefined();
    near(gestures[1].startX, 700);
    near(gestures[1].startY, 1500);
    near(gestures[1].endX, 700);
    near(gestures[1].endY, 900);
  });

  test("a dropped-X tap after a rotated all-axes swipe maps through the rotated geometry", async () => {
    const gestures = await readGestures([
      { capture: readTouchNodeCapture(SWIPE_ROT90_ALL), rotation: 1 },
      { capture: readTouchNodeCapture(TAP_ROT90), rotation: 1 },
    ]);

    // Reused raw X 0x52f5 -> display y 380; raw Y 0x2555 -> display x 700.
    expect(gestures[1]).toMatchObject({ type: "tap" });
    near(gestures[1].screenX, 700);
    near(gestures[1].screenY, 380);
  });
});

describe("captured gestures map through the real reader", () => {
  const byType = (gestures: GestureEvent[], type: GestureEvent["type"]) =>
    gestures.filter((gesture) => gesture.type === type);

  test("the all-axes session maps each gesture with the rotation current when it started", async () => {
    // Chronological order of the all-axes captures; the display rotates before the last two.
    const gestures = await readGestures([
      { capture: readTouchNodeCapture(TAP_ALL), rotation: 0 },
      { capture: readTouchNodeCapture(SWIPE_ALL), rotation: 0 },
      { capture: readTouchNodeCapture(TAP_ROT90_ALL), rotation: 1 },
      { capture: readTouchNodeCapture(SWIPE_ROT90_ALL), rotation: 1 },
    ]);

    expect(gestures.map((gesture) => gesture.type)).toEqual(["tap", "swipe", "tap", "swipe"]);
    const [swipeUp, swipeLeft] = byType(gestures, "swipe");
    expect(swipeUp).toMatchObject({ direction: "up", speed: "fast" });
    near(swipeUp.startX, 700);
    near(swipeUp.startY, 1600);
    near(swipeUp.endX, 700);
    near(swipeUp.endY, 1000);
    expect(swipeLeft).toMatchObject({ direction: "left", speed: "fast" });
    near(swipeLeft.startX, 1600);
    near(swipeLeft.startY, 380);
    near(swipeLeft.endX, 1000);
    near(swipeLeft.endY, 380);
    const rotatedTap = byType(gestures, "tap")[1];
    near(rotatedTap.screenX, 900);
    near(rotatedTap.screenY, 780);
  });
});

describe("what the device exported for taps (arithmetic cross-check, not a capture)", () => {
  // The device run exported tapAt (306,1651) for a portrait tap and tapAt (325,378) for the
  // natural point (702,325) after ROTATION_90. The raw values of those two taps were not
  // captured, so the raw points here are derived from the natural points; this only pins
  // that the scaler is consistent with the device's own export.
  const rawFor = (natural: { x: number; y: number }) => ({
    x: Math.round((natural.x / CAPTURE_DISPLAY.width) * 32768),
    y: Math.round((natural.y / CAPTURE_DISPLAY.height) * 32768),
  });
  const mapAt = (rotation: number, natural: { x: number; y: number }) => {
    const raw = rawFor(natural);
    return new ScreenGeometryTimeline(CAPTURE_AXES, { rotation, display: CAPTURE_DISPLAY }, 0)
      .scalerAt(0)
      .toScreenPoint(raw.x, raw.y);
  };

  test("portrait natural (306,1651) maps back to the exported tapAt", () => {
    const point = mapAt(0, { x: 306, y: 1651 });
    near(point.x, 306);
    near(point.y, 1651);
  });

  test("natural (702,325) after ROTATION_90 maps to the exported tapAt (325,378)", () => {
    const point = mapAt(1, { x: 702, y: 325 });
    near(point.x, 325);
    near(point.y, 378);
  });
});

describe("foldable: the same touch nodes in both postures (emulator-5602)", () => {
  const opened = readTouchNodeCapture("getevent-p-all-nodes-opened-emulator-5602.txt");
  const closed = readTouchNodeCapture("getevent-p-all-nodes-closed-emulator-5602.txt");
  const OPENED = { width: 2076, height: 2152 };
  const CLOSED = { width: 1080, height: 2364 };

  /** Touch mapper mode per input device in a `dumpsys input` Input Devices capture. */
  function touchModes(dump: string): Record<string, string> {
    const modes: Record<string, string> = {};
    let device = "";
    for (const line of dump.split("\n")) {
      const name = /^ {2}Device \d+: (\S+)/.exec(line);
      if (name) {
        device = name[1];
      }
      const mode = /Touch Input Mapper \(mode - (\w+)\)/.exec(line);
      if (mode) {
        modes[device] = mode[1];
      }
    }
    return modes;
  }

  test("the captures record the posture and display size they were taken at", () => {
    expect(opened.split("\n")[0]).toContain(
      "posture: opened, device_state=2, Physical size: 2076x2152",
    );
    expect(closed.split("\n")[0]).toContain(
      "posture: closed, device_state=0, Physical size: 1080x2364",
    );
  });

  test("getevent -p lists identical nodes and axis ranges whether opened or closed", () => {
    const nodesOpened = parseTouchNodes(opened);
    expect(nodesOpened).toHaveLength(11);
    expect(parseTouchNodes(closed)).toEqual(nodesOpened);
    expect(nodesOpened.map((node) => node.path)).toEqual(
      Array.from({ length: 11 }, (_, index) => `/dev/input/event${index + 1}`),
    );
    for (const node of nodesOpened) {
      expect([node.axisXMin, node.axisXMax, node.axisYMin, node.axisYMax]).toEqual([
        0, 32767, 0, 32767,
      ]);
    }
  });

  test("discovery chooses the same first node in either posture", async () => {
    for (const capture of [opened, closed]) {
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getevent -p", capture);
      expect((await discoverTouchNode(adb))?.path).toBe("/dev/input/event1");
    }
  });

  test("the raw range is posture-independent, so only the display size changes the pixels", () => {
    const at = (display: { width: number; height: number }) =>
      new ScreenGeometryTimeline(CAPTURE_AXES, { rotation: 0, display }, 0)
        .scalerAt(0)
        .toScreenPoint(16383, 16383);
    expect(at(OPENED)).toEqual({ x: 1038, y: 1076 });
    expect(at(CLOSED)).toEqual({ x: 540, y: 1182 });
  });

  test("a fold during recording rescales to the new size and warns the touches may be a different panel", () => {
    const timeline = new ScreenGeometryTimeline(CAPTURE_AXES, { rotation: 0, display: OPENED }, 0);
    timeline.apply({ display: CLOSED }, 1_000);

    const [warning] = timeline.warningsFor(2_000, 2_100);

    expect(warning).toContain("display size changed from 2076x2152 to 1080x2364 (fold/unfold?)");
    expect(warning).toContain("touch node chosen when recording started");
    expect(timeline.scalerAt(2_000).toScreenPoint(16383, 16383)).toEqual({ x: 540, y: 1182 });
  });

  test("dumpsys input: closing activates a second touch node that opened leaves disabled", () => {
    // Why the fold warning stays: getevent -p cannot tell the panels apart, but the input
    // reader enables virtio_input_multi_touch_7 (port 1, 1080x2364) only when closed, while
    // virtio_input_multi_touch_1, the node discovery picks, stays active in both postures.
    const modesOpened = touchModes(
      readTouchNodeCapture("dumpsys-input-devices-opened-emulator-5602.txt"),
    );
    const modesClosed = touchModes(
      readTouchNodeCapture("dumpsys-input-devices-closed-emulator-5602.txt"),
    );

    expect(modesOpened["virtio_input_multi_touch_1"]).toBe("DIRECT");
    expect(modesClosed["virtio_input_multi_touch_1"]).toBe("DIRECT");
    expect(modesOpened["virtio_input_multi_touch_7"]).toBe("DISABLED");
    expect(modesClosed["virtio_input_multi_touch_7"]).toBe("DIRECT");
  });
});
