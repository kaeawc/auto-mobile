import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DualTrackRecorder,
  GEOMETRY_FINALIZE_BUDGET_MS,
  GEOMETRY_UNCONFIRMED_WARNING,
} from "../../../../src/features/record/android/DualTrackRecorder";
import {
  createAdbGeometryProbe,
  DisplayGeometryTracker,
  GEOMETRY_READ_TIMEOUT_MS,
  type DisplayGeometryProbe,
} from "../../../../src/features/record/android/DisplayGeometryTracker";
import { GetEventReader } from "../../../../src/features/record/android/GetEventReader";
import {
  GEOMETRY_SETTLE_MS,
  ROTATION_UNKNOWN_CAVEAT,
  ScreenGeometryTimeline,
  SIZE_UNKNOWN_CAVEAT,
  type DisplaySize,
  type TouchAxes,
} from "../../../../src/features/record/android/ScreenGeometryTimeline";
import type {
  A11ySource,
  DisplayChange,
  DisplayChangeSource,
} from "../../../../src/features/record/android/types";
import type { BootedDevice } from "../../../../src/models";
import type { AdbProcess } from "../../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../../../fakes/FakeAdbProcess";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { readTouchNodeCapture, replayCapture } from "../../../helpers/touchNodeCaptures";

// Real capture (issue #9143): one tap, raw (0x6ccc, 0x3f25) = (27852, 16165), on a
// virtio_input_multi_touch emulator node. This capture carries no axis range; the
// range below (0..32767) is the one `getevent -p` reports for that node, captured in
// test/fixtures/android-touch-node/getevent-p-touch-node-emulator-5600.txt and
// parsed in TouchNodeCaptures.test.ts.
// The first six lines are the DOWN frame (4 lines) and the UP frame (2 lines).
const CAPTURE = readFileSync(
  join(__dirname, "../../../fixtures/android-getevent/same-coordinate-taps-api36.txt"),
  "utf8",
).split("\n");
const TAP_DOWN = CAPTURE.slice(0, 4).join("\n") + "\n";
const TAP_UP = CAPTURE.slice(4, 6).join("\n") + "\n";
const RAW = { x: 27852, y: 16165 };

const AXES: TouchAxes = { xMin: 0, xMax: 32767, yMin: 0, yMax: 32767 };
const PHYSICAL: DisplaySize = { width: 1080, height: 2400 };
// rotation 0: (918, 1184); rotation 1 (90 degrees): raw Y -> screen x, inverted raw X -> screen y.
const PORTRAIT_TAP = { x: 918, y: 1184 };
const LANDSCAPE_TAP = { x: 1184, y: 162 };

const device: BootedDevice = { deviceId: "emulator-5554", name: "Test", platform: "android" };

class FakeProbe implements DisplayGeometryProbe {
  rotation: number | null | Error = 0;
  size: DisplaySize | Error = PHYSICAL;
  /** Runs at the start of every rotation read, e.g. to deliver a push mid-stop. */
  onRotationRead?: () => void;
  /** When set, `wm size` reads never resolve (a stalled adb). */
  sizeStalls = false;
  rotationStalls = false;
  async readRotation(): Promise<number | null> {
    this.onRotationRead?.();
    if (this.rotationStalls) {
      return new Promise<number | null>(() => {});
    }
    if (this.rotation instanceof Error) {
      throw this.rotation;
    }
    return this.rotation;
  }
  async readPhysicalSize(): Promise<DisplaySize> {
    if (this.sizeStalls) {
      return new Promise<DisplaySize>(() => {});
    }
    if (this.size instanceof Error) {
      throw this.size;
    }
    return this.size;
  }
}

class FakeDisplaySource implements DisplayChangeSource {
  unsubscribed = 0;
  private listener?: (change: DisplayChange) => void;
  onDisplayChange(listener: (change: DisplayChange) => void): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribed++;
      this.listener = undefined;
    };
  }
  emit(change: DisplayChange): void {
    this.listener?.(change);
  }
}

class FakeA11y implements A11ySource {
  async ensureConnected(): Promise<boolean> {
    return true;
  }
  async getSupportedCommands(): Promise<string[] | null> {
    return [];
  }
  onInteraction(): () => void {
    return () => {};
  }
}

class ReaderAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

function rotationChange(rotation: number | undefined, displayId = 0): DisplayChange {
  return {
    change: "changed",
    displayId,
    ...(rotation === undefined ? {} : { rotation }),
    width: rotation === 1 || rotation === 3 ? PHYSICAL.height : PHYSICAL.width,
    height: rotation === 1 || rotation === 3 ? PHYSICAL.width : PHYSICAL.height,
  };
}

/** Recorder wired like production: real GetEventReader + timeline + tracker, fake device edges. */
async function setupTapPipeline() {
  const timer = new FakeTimer();
  timer.advanceTime(1000);
  const probe = new FakeProbe();
  const source = new FakeDisplaySource();
  const timeline = new ScreenGeometryTimeline(
    AXES,
    { rotation: 0, display: PHYSICAL },
    timer.now(),
  );
  const tracker = new DisplayGeometryTracker(timeline, probe, timer);
  const adb = new ReaderAdb();
  const proc = new FakeAdbProcess();
  adb.spawn.mockResolvedValue(proc);
  const reader = new GetEventReader({
    adb,
    timer,
    density: 1,
    touchNode: { path: "/dev/input/event1", name: "touch", ...toNodeAxes(AXES) },
    scaler: timeline,
  });
  const recorder = new DualTrackRecorder(device, reader, new FakeA11y(), timer, tracker, source);
  await recorder.start();
  await Promise.resolve();
  const feed = (text: string): void => {
    proc.stdout.emit("data", Buffer.from(text));
  };
  return { timer, probe, source, tracker, recorder, feed };
}

function toNodeAxes(axes: TouchAxes) {
  return {
    axisXMin: axes.xMin,
    axisXMax: axes.xMax,
    axisYMin: axes.yMin,
    axisYMax: axes.yMax,
  };
}

/** The device rotates: later reads (e.g. the stop-time cross-check) see the new rotation. */
function rotate(pipeline: { probe: FakeProbe; source: FakeDisplaySource }, rotation: number): void {
  pipeline.probe.rotation = rotation;
  pipeline.source.emit(rotationChange(rotation));
}

function tap(pipeline: Awaited<ReturnType<typeof setupTapPipeline>>, holdMs = 124): void {
  pipeline.feed(TAP_DOWN);
  pipeline.timer.advanceTime(holdMs);
  pipeline.feed(TAP_UP);
}

describe("DualTrackRecorder geometry timeline (#10174)", () => {
  test("a tap after a rotation to 90 degrees maps to the landscape point", async () => {
    const p = await setupTapPipeline();
    rotate(p, 1);
    p.timer.advanceTime(2_000);
    tap(p);

    const result = await p.recorder.stop();

    expect(result.steps).toEqual([{ tool: "tapAt", params: { ...LANDSCAPE_TAP, action: "tap" } }]);
    expect(result.geometryWarnings).toBeUndefined();
  });

  test("a tap before the rotation keeps the portrait mapping and a later tap uses landscape", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.timer.advanceTime(2_000);
    rotate(p, 1);
    p.timer.advanceTime(2_000);
    tap(p);

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps.map((step) => step.params)).toEqual([
      { ...PORTRAIT_TAP, action: "tap" },
      { ...LANDSCAPE_TAP, action: "tap" },
    ]);
    expect(steps.every((step) => step.label === undefined)).toBe(true);
    expect(geometryWarnings).toBeUndefined();
  });

  test("a recording with no rotation is unchanged: portrait point, no label, no warnings", async () => {
    const p = await setupTapPipeline();
    tap(p);

    const result = await p.recorder.stop();

    expect(result).toEqual({
      steps: [{ tool: "tapAt", params: { ...PORTRAIT_TAP, action: "tap" } }],
      stepCount: 1,
    });
  });

  test("a gesture that spans a rotation is labelled instead of silently mapped", async () => {
    const p = await setupTapPipeline();
    p.feed(TAP_DOWN);
    p.timer.advanceTime(60);
    rotate(p, 1);
    p.timer.advanceTime(64);
    p.feed(TAP_UP);

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps).toHaveLength(1);
    expect(steps[0].label).toContain("gesture spans a display rotation/size change");
    expect(geometryWarnings).toEqual([expect.stringContaining("gesture spans")]);
  });

  test("a tap within the settle window of a reported rotation is labelled", async () => {
    const p = await setupTapPipeline();
    rotate(p, 1);
    p.timer.advanceTime(100);
    tap(p);

    const { steps } = await p.recorder.stop();

    expect(steps[0].label).toContain(`within ${GEOMETRY_SETTLE_MS} ms of this gesture`);
  });

  test("a tap that ended just before a late rotation push is labelled", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.timer.advanceTime(200);
    rotate(p, 1);

    const { steps } = await p.recorder.stop();

    expect(steps[0].params).toMatchObject(PORTRAIT_TAP);
    expect(steps[0].label).toContain("may use a stale rotation");
  });

  test("an unreadable rotation after a display change labels later steps and reports a warning", async () => {
    const p = await setupTapPipeline();
    p.probe.rotation = new Error("adb offline");
    // An APK that predates the rotation field: the host must re-read it.
    p.source.emit(rotationChange(undefined));
    await p.tracker.settle();
    p.timer.advanceTime(2_000);
    tap(p);

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps[0].label).toBe(`Warning: ${ROTATION_UNKNOWN_CAVEAT}`);
    // The stop-time read fails too, so the geometry also cannot be confirmed.
    expect(geometryWarnings).toEqual([ROTATION_UNKNOWN_CAVEAT, GEOMETRY_UNCONFIRMED_WARNING]);
  });

  test("an unreadable display size after a display change is reported", async () => {
    const p = await setupTapPipeline();
    p.probe.size = new Error("wm size failed");
    rotate(p, 1);
    await p.tracker.settle();
    p.timer.advanceTime(2_000);
    tap(p);

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps[0].label).toBe(`Warning: ${SIZE_UNKNOWN_CAVEAT}`);
    expect(geometryWarnings).toEqual([SIZE_UNKNOWN_CAVEAT]);
  });

  test("a size change a rotation cannot explain marks later steps as possibly another panel", async () => {
    const p = await setupTapPipeline();
    p.probe.size = { width: 1840, height: 2208 };
    p.source.emit(rotationChange(0));
    await p.tracker.settle();
    p.timer.advanceTime(2_000);
    tap(p);

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps[0].label).toContain("display size changed from 1080x2400 to 1840x2208");
    expect(steps[0].label).toContain("different panel");
    expect(geometryWarnings).toHaveLength(1);
  });

  test("a rotation that was never pushed is caught by the stop-time cross-check", async () => {
    const p = await setupTapPipeline();
    p.probe.rotation = 1;
    tap(p);

    const { steps, geometryWarnings } = await p.recorder.stop();

    // Nothing was pushed, so the touch cannot be proven right: it is labelled with the mismatch.
    expect(steps[0].label).toContain("display rotation at stop (1) differs");
    expect(geometryWarnings).toEqual([
      expect.stringContaining("display rotation at stop (1) differs"),
    ]);
  });

  test("changes on other displays are ignored and stop unsubscribes from the source", async () => {
    const p = await setupTapPipeline();
    p.source.emit(rotationChange(1, 2));
    p.timer.advanceTime(2_000);
    tap(p);

    const result = await p.recorder.stop();

    expect(result.steps[0].params).toMatchObject(PORTRAIT_TAP);
    expect(result.geometryWarnings).toBeUndefined();
    expect(p.source.unsubscribed).toBe(1);
  });

  test("stop called twice returns the same labelled result", async () => {
    const p = await setupTapPipeline();
    rotate(p, 1);
    p.timer.advanceTime(100);
    tap(p);

    const [first, second] = await Promise.all([p.recorder.stop(), p.recorder.stop()]);

    expect(second).toEqual(first);
    expect(first.geometryWarnings).toHaveLength(1);
  });
});

describe("captured swipes and taps after a rotation (#10174)", () => {
  // Real `getevent -lt` captures (test/fixtures/android-touch-node/README.md) fed through the
  // real GetEventReader, with the same physical motion recorded in ROTATION_0 and ROTATION_90.
  // The device's own export for those orientations was tapAt (325,378) / swipeOn up and left.
  type Pipeline = Awaited<ReturnType<typeof setupTapPipeline>>;

  function replay(pipeline: Pipeline, name: string): void {
    replayCapture(pipeline.timer, pipeline.feed, readTouchNodeCapture(name));
    pipeline.timer.advanceTime(1_000);
  }

  async function rotated(rotation: number): Promise<Pipeline> {
    const pipeline = await setupTapPipeline();
    rotate(pipeline, rotation);
    pipeline.timer.advanceTime(2_000);
    return pipeline;
  }

  test("a captured upward swipe in portrait exports swipeOn up, fast", async () => {
    const p = await setupTapPipeline();
    replay(p, "getevent-lt-swipe-portrait-all-axes-emulator-5600.txt");

    const result = await p.recorder.stop();

    expect(result.steps).toEqual([{ tool: "swipeOn", params: { direction: "up", speed: "fast" } }]);
    expect(result.geometryWarnings).toBeUndefined();
  });

  test("the same physical swipe after a rotation to 90 degrees exports swipeOn left", async () => {
    const p = await rotated(1);
    replay(p, "getevent-lt-swipe-landscape-rot90-all-axes-emulator-5600.txt");

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps).toEqual([{ tool: "swipeOn", params: { direction: "left", speed: "fast" } }]);
    expect(geometryWarnings).toBeUndefined();
  });

  test("a captured rotated tap exports the landscape point the capture header gives", async () => {
    const p = await rotated(1);
    replay(p, "getevent-lt-tap-landscape-rot90-all-axes-emulator-5600.txt");

    const { steps } = await p.recorder.stop();

    // Header: natural (300,900) = display (900,780) on 2400x1080; within 1 px of rounding.
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ tool: "tapAt", params: { action: "tap" } });
    expect(Math.abs(Number(steps[0].params.x) - 900)).toBeLessThanOrEqual(1);
    expect(Math.abs(Number(steps[0].params.y) - 780)).toBeLessThanOrEqual(1);
  });

  test("a recording that rotates between captures maps each gesture with its own rotation", async () => {
    const p = await setupTapPipeline();
    replay(p, "getevent-lt-tap-portrait-all-axes-emulator-5600.txt");
    replay(p, "getevent-lt-swipe-portrait-all-axes-emulator-5600.txt");
    rotate(p, 1);
    p.timer.advanceTime(2_000);
    replay(p, "getevent-lt-tap-landscape-rot90-all-axes-emulator-5600.txt");
    replay(p, "getevent-lt-swipe-landscape-rot90-all-axes-emulator-5600.txt");

    const { steps, geometryWarnings } = await p.recorder.stop();

    // The first tap reported no Y (the kernel dropped it as unchanged), so it cannot be placed.
    expect(steps.map((step) => [step.tool, step.params.direction])).toEqual([
      ["swipeOn", "up"],
      ["tapAt", undefined],
      ["swipeOn", "left"],
    ]);
    expect(steps.every((step) => step.label === undefined)).toBe(true);
    expect(geometryWarnings).toBeUndefined();
  });

  test("the portrait capture read under rotation 3 reverses to a rightward swipe", async () => {
    // Derived: no ROTATION_270 capture exists, so this reuses the portrait raw drag.
    const p = await rotated(3);
    replay(p, "getevent-lt-swipe-portrait-all-axes-emulator-5600.txt");

    const { steps } = await p.recorder.stop();

    expect(steps[0].params.direction).toBe("right");
  });
});

describe("ScreenGeometryTimeline", () => {
  const start = 1000;
  const make = (caveats: string[] = []) =>
    new ScreenGeometryTimeline(AXES, { rotation: 0, display: PHYSICAL }, start, caveats);

  test("resolves each touch against the entry in force at its DOWN time", () => {
    const timeline = make();
    timeline.apply({ rotation: 1 }, 5_000);
    expect(timeline.scalerAt(4_999).toScreenPoint(RAW.x, RAW.y)).toEqual(PORTRAIT_TAP);
    expect(timeline.scalerAt(5_000).toScreenPoint(RAW.x, RAW.y)).toEqual(LANDSCAPE_TAP);
    // A touch stamped before the timeline began falls back to the first entry.
    expect(timeline.scalerAt(0).toScreenPoint(RAW.x, RAW.y)).toEqual(PORTRAIT_TAP);
  });

  test("an unreadable rotation keeps the previous one but is flagged until a read succeeds", () => {
    const timeline = make();
    timeline.apply({ rotation: 1 }, 2_000);
    timeline.apply({ rotation: null }, 3_000);
    expect(timeline.currentRotation).toBe(1);
    expect(timeline.warningsFor(4_000, 4_100)).toEqual([ROTATION_UNKNOWN_CAVEAT]);
    timeline.apply({ rotation: 1 }, 5_000);
    expect(timeline.warningsFor(6_000, 6_100)).toEqual([]);
  });

  test("a start caveat labels touches until the first successful refresh", () => {
    const timeline = make([ROTATION_UNKNOWN_CAVEAT]);
    expect(timeline.warningsFor(2_000, 2_100)).toEqual([ROTATION_UNKNOWN_CAVEAT]);
    timeline.apply({ rotation: 0, display: PHYSICAL }, 3_000);
    expect(timeline.warningsFor(4_000, 4_100)).toEqual([]);
  });

  test("a restored display size clears the panel caveat", () => {
    const timeline = make();
    timeline.apply({ display: { width: 1840, height: 2208 } }, 2_000);
    expect(timeline.warningsFor(3_000, 3_100)).toHaveLength(1);
    timeline.apply({ display: PHYSICAL }, 4_000);
    expect(timeline.warningsFor(5_000, 5_100)).toEqual([]);
  });

  test("an entry never predates the previous one when refreshes complete late", () => {
    const timeline = make();
    timeline.apply({ rotation: 1 }, 5_000);
    timeline.apply({ rotation: 2 }, 4_000);
    expect(timeline.scalerAt(4_500).toScreenPoint(RAW.x, RAW.y)).toEqual(PORTRAIT_TAP);
  });
});

describe("stop-time geometry finalisation is bounded and best-effort (#10181)", () => {
  /** Let already-resolved promise chains run without advancing the fake clock. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  test("a stalled wm size read never loses the recording: stop returns the steps with a warning", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.timer.advanceTime(2_000);
    p.probe.sizeStalls = true;
    rotate(p, 1);

    const stopping = p.recorder.stop();
    await flush();
    p.timer.advanceTime(GEOMETRY_FINALIZE_BUDGET_MS);
    const result = await stopping;

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].params).toMatchObject(PORTRAIT_TAP);
    expect(result.geometryWarnings).toEqual(expect.arrayContaining([GEOMETRY_UNCONFIRMED_WARNING]));
  });

  test("a stalled stop-time rotation read also returns the recording with the warning", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.probe.rotationStalls = true;

    const stopping = p.recorder.stop();
    await flush();
    p.timer.advanceTime(GEOMETRY_FINALIZE_BUDGET_MS);
    const result = await stopping;

    expect(result.steps).toHaveLength(1);
    expect(result.geometryWarnings).toEqual([GEOMETRY_UNCONFIRMED_WARNING]);
  });

  test("a stop-time rotation read that rejects reports the geometry as unconfirmed", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.probe.rotation = new Error("adb offline");

    const result = await p.recorder.stop();

    expect(result.steps).toHaveLength(1);
    expect(result.geometryWarnings).toEqual([GEOMETRY_UNCONFIRMED_WARNING]);
  });

  test("a stop-time rotation read that reports nothing reports the geometry as unconfirmed", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.probe.rotation = null;

    const result = await p.recorder.stop();

    expect(result.geometryWarnings).toEqual([GEOMETRY_UNCONFIRMED_WARNING]);
  });

  test("the budget sits well under the manager's 10 s stop deadline", () => {
    expect(GEOMETRY_FINALIZE_BUDGET_MS).toBeLessThanOrEqual(5_000);
    expect(GEOMETRY_READ_TIMEOUT_MS).toBeLessThan(GEOMETRY_FINALIZE_BUDGET_MS);
  });

  test("a responsive device finishes at stop without the unconfirmed warning", async () => {
    const p = await setupTapPipeline();
    tap(p);

    const result = await p.recorder.stop();

    expect(result.geometryWarnings).toBeUndefined();
  });

  test("every adb read the tracker issues carries the short explicit timeout", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell wm size", "Physical size: 1080x2400");
    const probe = createAdbGeometryProbe(adb);

    await probe.readPhysicalSize().catch(() => undefined);
    await probe.readRotation().catch(() => undefined);

    const calls = adb.getCommandCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every((call) => call.timeoutMs === GEOMETRY_READ_TIMEOUT_MS)).toBe(true);
  });

  test("a display push that arrives while stop is finalising still labels the tap", async () => {
    const p = await setupTapPipeline();
    tap(p);
    // The device pushes inside its debounce window, after the user pressed stop.
    p.timer.advanceTime(50);
    p.probe.onRotationRead = () => p.source.emit(rotationChange(0));

    const { steps } = await p.recorder.stop();

    expect(steps[0].label).toContain(`within ${GEOMETRY_SETTLE_MS} ms of this gesture`);
    expect(p.source.unsubscribed).toBe(1);
  });

  test("an unpushed rotation labels every step after the last known-good geometry", async () => {
    const p = await setupTapPipeline();
    tap(p);
    p.timer.advanceTime(2_000);
    rotate(p, 1);
    p.timer.advanceTime(2_000);
    tap(p);
    p.timer.advanceTime(2_000);
    // The device rotates again but the push never arrives.
    p.probe.rotation = 2;
    tap(p);

    const { steps, geometryWarnings } = await p.recorder.stop();

    expect(steps).toHaveLength(3);
    expect(steps[0].label).toBeUndefined();
    // The rotation-1 entry is the last known-good one: touches from it onwards are suspect.
    expect(steps[1].label).toContain("display rotation at stop (2) differs");
    expect(steps[2].label).toContain("display rotation at stop (2) differs");
    expect(geometryWarnings).toEqual([expect.stringContaining("display rotation at stop (2)")]);
  });
});

describe("a superseded geometry refresh is discarded (#10181)", () => {
  test("an older size read finishing after a newer push does not become the effective geometry", async () => {
    const timer = new FakeTimer();
    timer.advanceTime(1000);
    const sizeReads: Array<(size: DisplaySize) => void> = [];
    const probe: DisplayGeometryProbe = {
      readRotation: async () => 0,
      readPhysicalSize: () => new Promise<DisplaySize>((resolve) => sizeReads.push(resolve)),
    };
    const timeline = new ScreenGeometryTimeline(
      AXES,
      { rotation: 0, display: PHYSICAL },
      timer.now(),
    );
    const tracker = new DisplayGeometryTracker(timeline, probe, timer);

    tracker.handleTransition(rotationChange(1));
    await Promise.resolve();
    timer.advanceTime(10);
    tracker.handleTransition(rotationChange(0));
    // The first push's read completes late with a size that differs from the baseline.
    sizeReads[0]({ width: 1840, height: 2208 });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // The newer push's read is still pending: nothing from the older read may be in force.
    const inForce = () => timeline.warningsFor(timer.now(), timer.now()).join(";");
    expect(inForce()).not.toContain("display size changed");
    sizeReads[1](PHYSICAL);
    await tracker.settle();
    expect(inForce()).not.toContain("display size changed");
  });
});
