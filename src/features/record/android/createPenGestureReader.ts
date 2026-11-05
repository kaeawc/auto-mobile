import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import { GetEventReader } from "./GetEventReader";
import type { KernelTimeLineMergeScope } from "./KernelTimeLineMerge";
import {
  followWithPenTimelines,
  type DisplaySize,
  type ScreenGeometryTimeline,
} from "./ScreenGeometryTimeline";
import type { TouchInputNode } from "./TouchNodeDiscovery";
import type { GestureEmitter } from "./types";

interface PenGestureReaderOptions {
  adb: AdbExecutor;
  penNode: TouchInputNode;
  timeline: ScreenGeometryTimeline;
  rotation: number;
  display: DisplaySize;
  caveats: readonly string[];
  density: number;
  timer: Timer;
  lineMerge: KernelTimeLineMergeScope;
}

/** Read a pen with its own axes while following the recording's display geometry. */
export function createPenGestureReader({
  adb,
  penNode,
  timeline,
  rotation,
  display,
  caveats,
  density,
  timer,
  lineMerge,
}: PenGestureReaderOptions): GestureEmitter {
  const [{ scaler, stopFollowing }] = followWithPenTimelines(
    timeline,
    [penNode],
    { rotation, display },
    { startedAt: timer.now(), caveats },
  );
  const penReader = new GetEventReader({
    adb,
    touchNode: penNode,
    scaler,
    density,
    timer,
    lineMerge,
  });
  return {
    start: (onGesture, onError) => penReader.start(onGesture, onError),
    stop: () => {
      penReader.stop();
      stopFollowing();
    },
  };
}
