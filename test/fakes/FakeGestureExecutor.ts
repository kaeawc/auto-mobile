import { GestureOptions } from "../../src/models";
import { SwipeResult } from "../../src/models/SwipeResult";
import { PerformanceTracker } from "../../src/utils/PerformanceTracker";
import { GestureExecutor } from "../../src/features/action/swipeon";
import { throwIfAborted } from "../../src/utils/toolUtils";

/** Mirrors ExecuteGesture's ADB-mode default when a caller gives no duration. */
const DEFAULT_SWIPE_DURATION_MS = 300;

export class FakeGestureExecutor implements GestureExecutor {
  private swipeCalls: Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    options?: GestureOptions;
  }> = [];
  private failure: string | undefined;

  /** Make every later swipe resolve unsuccessfully, as a failed device command does. */
  failWith(message: string | undefined): void {
    this.failure = message;
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: GestureOptions = {},
    ...rest: [perf?: PerformanceTracker, signal?: AbortSignal]
  ): Promise<SwipeResult> {
    const signal = rest[1];
    throwIfAborted(signal);
    const duration = options.duration ?? DEFAULT_SWIPE_DURATION_MS;
    if (this.failure !== undefined) {
      return { success: false, x1, y1, x2, y2, duration, error: this.failure };
    }
    this.swipeCalls.push({ x1, y1, x2, y2, options });
    return { success: true, x1, y1, x2, y2, duration };
  }

  getSwipeCalls(): Array<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    options?: GestureOptions;
  }> {
    return [...this.swipeCalls];
  }
}
