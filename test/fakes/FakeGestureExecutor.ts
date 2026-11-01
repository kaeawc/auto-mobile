import { GestureOptions } from "../../src/models";
import { SwipeResult } from "../../src/models/SwipeResult";
import type { ActionCall } from "../../src/features/action/ActionCall";
import type { SwipeLine } from "../../src/features/action/ExecuteGesture";
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
    { x1, y1, x2, y2 }: SwipeLine,
    options: GestureOptions = {},
    call: ActionCall | undefined = undefined,
  ): Promise<SwipeResult> {
    throwIfAborted(call?.signal);
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
