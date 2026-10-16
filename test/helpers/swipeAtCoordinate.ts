import { SwipeAtCoordinate } from "../../src/features/action/SwipeAtCoordinate";
import type { ExecuteGesture } from "../../src/features/action/ExecuteGesture";
import type { SnapshotReferenceStore } from "../../src/features/observe/SnapshotReferenceStore";
import type { DisplayFenceDependencies } from "../../src/features/action/BaseVisualChange";
import type { BootedDevice, SwipeResult } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";
import { observation } from "./tapAtCoordinate";

type SwipeArgs = Parameters<ExecuteGesture["swipe"]>;

export interface RecordedSwipe {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  duration: number | undefined;
}

/** Records every dispatched swipe; `failWith` makes the next dispatches report a failure. */
class RecordingGesture implements Pick<ExecuteGesture, "swipe"> {
  readonly swipes: RecordedSwipe[] = [];
  /** Per dispatch: whether it received the in-flight display fence. */
  readonly fences: boolean[] = [];
  failWith?: string;
  /** With `failWith`: the swipe was dispatched but never acknowledged. */
  indeterminate = false;

  async swipe(...[x1, y1, x2, y2, options]: SwipeArgs): Promise<SwipeResult> {
    // The real dispatch asserts the fence before any input is sent.
    options?.displayFence?.assertCurrent();
    this.swipes.push({ x1, y1, x2, y2, duration: options?.duration });
    this.fences.push(options?.displayFence !== undefined);
    return this.failWith
      ? {
          success: false,
          x1,
          y1,
          x2,
          y2,
          duration: 0,
          error: this.failWith,
          ...(this.indeterminate ? { outcomeIndeterminate: true } : {}),
        }
      : { success: true, x1, y1, x2, y2, duration: options?.duration ?? 0 };
  }
}

export function createSwipeAt(
  device: BootedDevice,
  width = 100,
  height = 200,
  snapshotReferences?: SnapshotReferenceStore,
  fence: DisplayFenceDependencies = {},
) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(width, height));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const gesture = new RecordingGesture();
  let iosCacheInvalidations = 0;
  const swipeAt = new SwipeAtCoordinate(device, new FakeAdbExecutor(), {
    timer,
    invalidateIosCache: () => {
      iosCacheInvalidations++;
    },
    snapshotReferences,
    executeGesture: gesture,
    ...fence,
  });
  // Coordinate dispatch tests must not read the persistent per-device window cache.
  swipeAt.window = new FakeWindow();
  swipeAt.observeScreen = observeScreen;
  return {
    swipeAt,
    observeScreen,
    gesture,
    swipes: gesture.swipes,
    fences: gesture.fences,
    timer,
    iosCacheInvalidations: () => iosCacheInvalidations,
  };
}
