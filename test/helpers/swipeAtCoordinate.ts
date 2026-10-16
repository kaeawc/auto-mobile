import { SwipeAtCoordinate } from "../../src/features/action/SwipeAtCoordinate";
import type { ExecuteGesture } from "../../src/features/action/ExecuteGesture";
import type { Window } from "../../src/features/observe/Window";
import type { SnapshotReferenceStore } from "../../src/features/observe/SnapshotReferenceStore";
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
  failWith?: string;

  async swipe(...[x1, y1, x2, y2, options]: SwipeArgs): Promise<SwipeResult> {
    this.swipes.push({ x1, y1, x2, y2, duration: options?.duration });
    return this.failWith
      ? { success: false, x1, y1, x2, y2, duration: 0, error: this.failWith }
      : { success: true, x1, y1, x2, y2, duration: options?.duration ?? 0 };
  }
}

export function createSwipeAt(
  device: BootedDevice,
  width = 100,
  height = 200,
  snapshotReferences?: SnapshotReferenceStore,
) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation(width, height));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const gesture = new RecordingGesture();
  const swipeAt = new SwipeAtCoordinate(device, new FakeAdbExecutor(), {
    timer,
    snapshotReferences,
    executeGesture: gesture,
  });
  // Coordinate dispatch tests must not read the persistent per-device window cache.
  swipeAt.window = new FakeWindow() as unknown as Window;
  swipeAt.observeScreen = observeScreen;
  return { swipeAt, observeScreen, gesture, swipes: gesture.swipes, timer };
}
