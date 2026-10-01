import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { ActionableError } from "../../models";
import { PressButton } from "./PressButton";
import type { SwipeOnDependencies } from "./swipeon/types";
import { SwipeOn } from "./swipeon/SwipeOn";
import type { IosScreenUnlocker } from "./WakeAndUnlock";

export interface IosUnlockActions {
  pressHome(timeoutMs: number): Promise<{ success: boolean; error?: string }>;
  swipeUp(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; warning?: string }>;
}

/**
 * iOS wake + swipe-dismiss, over the existing gesture primitives.
 *
 * iOS simulators cannot set a device passcode, so there is no secure bouncer:
 * "unlock" is waking the display (home button) and swiping the non-secure lock
 * screen up. No PIN is involved — WakeAndUnlock ignores it on iOS (issue #4360).
 */
export class IosLockScreenUnlocker implements IosScreenUnlocker {
  private readonly actions: IosUnlockActions;

  constructor(
    device: BootedDevice,
    actions?: IosUnlockActions,
    private readonly timer: Timer = defaultTimer,
    createSwipe: (
      device: BootedDevice,
      dependencies: SwipeOnDependencies,
    ) => Pick<SwipeOn, "execute"> = (d, deps) => new SwipeOn(d, null, deps),
  ) {
    this.actions = actions ?? {
      // press() skips execute()'s observedInteraction, but simulator Home still
      // verifies foreground through a runner hierarchy read.
      pressHome: (timeoutMs) => new PressButton(device).press("home", timeoutMs),
      swipeUp: (timeoutMs, signal) => {
        const deadline = this.timer.now() + timeoutMs;
        return createSwipe(device, {
          skipCallerDisplayFence: true,
          stopAfterIosGestureFailure: true,
          iosGestureTimeoutMs: () => deadline - this.timer.now(),
        }).execute({ direction: "up", autoTarget: false }, undefined, signal);
      },
    };
  }

  async wakeAndDismiss(
    remainingMs: () => number = () => Infinity,
  ): Promise<{ success: boolean; error?: string }> {
    await this.pressHomeBestEffort(remainingMs);
    const swipeBudget = Math.min(5_000, remainingMs());
    if (swipeBudget <= 0) {
      throw new ActionableError(
        "wakeAndUnlock: iOS unlock budget exhausted before swipe; retry after the runner reconnects",
      );
    }
    try {
      const swipeAbort = new AbortController();
      const swipe = await raceWithDeadline(
        () => this.actions.swipeUp(swipeBudget, swipeAbort.signal),
        {
          timer: this.timer,
          timeoutMs: swipeBudget,
          label: "iOS lock-screen swipe",
          onTimeout: () => swipeAbort.abort(),
        },
      );
      if (!swipe.success) {
        logger.warn(
          `[IosLockScreenUnlocker] lock-screen swipe failed: ${swipe.error ?? swipe.warning ?? "unknown error"}`,
        );
      }
      return {
        success: swipe.success !== false,
        error:
          swipe.success === false
            ? (swipe.error ?? swipe.warning ?? "iOS lock-screen swipe did not report success")
            : undefined,
      };
    } catch (error) {
      const message = errorMessage(error);
      logger.warn(`[IosLockScreenUnlocker] lock-screen swipe failed: ${message}`, error);
      return { success: false, error: message };
    }
  }

  private async pressHomeBestEffort(remainingMs: () => number): Promise<void> {
    // Home is best effort: its lock-screen foreground verification can fail
    // even after the display wakes. The swipe and lock-state probe decide success.
    try {
      const homeBudget = Math.min(2_000, remainingMs());
      if (homeBudget <= 0) {
        throw new ActionableError("iOS unlock budget exhausted before Home press");
      }
      const home = await raceWithDeadline(() => this.actions.pressHome(homeBudget), {
        timer: this.timer,
        timeoutMs: homeBudget,
        label: "iOS Home press before unlock",
      });
      if (!home.success) {
        logger.warn(`[IosLockScreenUnlocker] Home press failed: ${home.error ?? "unknown error"}`);
      }
    } catch (error) {
      logger.warn(`[IosLockScreenUnlocker] Home press failed: ${errorMessage(error)}`, error);
    }
  }
}
