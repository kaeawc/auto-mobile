import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GetEventReader } from "../../src/features/record/android/GetEventReader";
import {
  ScreenGeometryTimeline,
  type DisplaySize,
  type TouchAxes,
} from "../../src/features/record/android/ScreenGeometryTimeline";
import type { GestureEvent } from "../../src/features/record/android/types";
import type { AdbProcess } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbProcess } from "../fakes/FakeAdbProcess";
import { FakeTimer } from "../fakes/FakeTimer";

const DIRECTORY = join(__dirname, "../fixtures/android-touch-node");

/** The captured file's exact text (see test/fixtures/android-touch-node/README.md). */
export function readTouchNodeCapture(name: string): string {
  return readFileSync(join(DIRECTORY, name), "utf8");
}

/** One SYN_REPORT-terminated frame of captured `getevent -lt` text. */
export interface CapturedFrame {
  /** The getevent `[ seconds ]` stamp of the frame, in milliseconds. */
  deviceMs: number;
  /** The frame's lines, newline terminated, exactly as captured. */
  text: string;
}

const STAMP = /^\[\s*(\d+)\.(\d+)\]/;

/**
 * Split captured `getevent -lt` text into frames at each `EV_SYN SYN_REPORT`,
 * dropping the `#` header lines the capture carries. The lines themselves are
 * not touched.
 */
export function captureFrames(capture: string): CapturedFrame[] {
  const frames: CapturedFrame[] = [];
  let pending: string[] = [];
  for (const line of capture.split("\n")) {
    const stamp = STAMP.exec(line);
    if (!stamp) {
      continue;
    }
    pending.push(line);
    if (line.includes("EV_SYN") && line.includes("SYN_REPORT")) {
      frames.push({
        deviceMs: Math.round(Number(`${stamp[1]}.${stamp[2]}`) * 1000),
        text: pending.join("\n") + "\n",
      });
      pending = [];
    }
  }
  return frames;
}

/** The geometry the captures were taken under: a 1080x2400 panel, touch axes 0..32767. */
export const CAPTURE_AXES: TouchAxes = { xMin: 0, xMax: 32767, yMin: 0, yMax: 32767 };
export const CAPTURE_DISPLAY: DisplaySize = { width: 1080, height: 2400 };

class SpawnAdb extends FakeAdbExecutor {
  readonly spawn = mock<(args: string[]) => Promise<AdbProcess>>();
}

/** Replays captured frames at their device spacing on a FakeTimer. */
export function replayCapture(
  timer: FakeTimer,
  feed: (text: string) => void,
  capture: string,
): void {
  let previous: number | undefined;
  for (const frame of captureFrames(capture)) {
    if (previous !== undefined) {
      timer.advanceTime(frame.deviceMs - previous);
    }
    previous = frame.deviceMs;
    feed(frame.text);
  }
}

export interface CaptureSegment {
  capture: string;
  /** Surface rotation the timeline holds while this capture replays. */
  rotation: number;
}

/**
 * The production path for `getevent -lt` text: a real GetEventReader (reconstructor
 * and classifier) over a real ScreenGeometryTimeline, fed the captured text through
 * a fake adb process. Returns every gesture the reader emitted, in order.
 */
export async function readGestures(segments: CaptureSegment[]): Promise<GestureEvent[]> {
  const timer = new FakeTimer();
  timer.advanceTime(1000);
  const timeline = new ScreenGeometryTimeline(
    CAPTURE_AXES,
    { rotation: 0, display: CAPTURE_DISPLAY },
    timer.now(),
  );
  const adb = new SpawnAdb();
  const proc = new FakeAdbProcess();
  adb.spawn.mockResolvedValue(proc);
  const reader = new GetEventReader({
    adb,
    timer,
    density: 1,
    touchNode: {
      path: "/dev/input/event1",
      name: "virtio_input_multi_touch_1",
      axisXMin: CAPTURE_AXES.xMin,
      axisXMax: CAPTURE_AXES.xMax,
      axisYMin: CAPTURE_AXES.yMin,
      axisYMax: CAPTURE_AXES.yMax,
    },
    scaler: timeline,
  });
  const gestures: GestureEvent[] = [];
  reader.start((gesture) => gestures.push(gesture));
  await Promise.resolve();
  let rotation = 0;
  for (const segment of segments) {
    if (segment.rotation !== rotation) {
      rotation = segment.rotation;
      timer.advanceTime(2_000);
      timeline.apply({ rotation }, timer.now());
      timer.advanceTime(2_000);
    }
    replayCapture(timer, (text) => proc.stdout.emit("data", Buffer.from(text)), segment.capture);
    timer.advanceTime(1_000);
  }
  reader.stop();
  return gestures;
}
