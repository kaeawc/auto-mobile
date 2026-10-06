import { throwIfAborted, awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { ActionableError } from "../../models";
import { PressButton } from "./PressButton";
import type { SwipeOnDependencies } from "./swipeon/types";
import { SwipeOn } from "./swipeon/SwipeOn";
import type { IosScreenUnlocker, IosUnlockOptions } from "./WakeAndUnlock";

const PRE_SWIPE_LOCK_PROBE_MAX_MS = 1_500;

export interface IosUnlockActions {
  pressHome(timeoutMs: number, signal?: AbortSignal): Promise<{ success: boolean; error?: string }>;
  swipeUp(
    timeoutMs: number,
    options?: { signal?: AbortSignal; lockScreen?: true },
  ): Promise<{
    success: boolean;
    error?: string;
    warning?: string;
    /** The swipe was dispatched but no result was confirmed (it may have been applied). */
    outcomeIndeterminate?: boolean;
  }>;
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
      pressHome: (timeoutMs, signal) =>
        new PressButton(device).press("home", timeoutMs, undefined, signal),
      swipeUp: (timeoutMs, options) => {
        const deadline = this.timer.now() + timeoutMs;
        return createSwipe(device, {
          skipCallerDisplayFence: true,
          stopAfterIosGestureFailure: true,
          ...(options?.lockScreen ? { iosLockScreenSwipe: true } : {}),
          iosGestureTimeoutMs: () => deadline - this.timer.now(),
        }).execute({ direction: "up", autoTarget: false }, undefined, options?.signal);
      },
    };
  }

  async wakeAndDismiss(
    options: IosUnlockOptions | (() => number) = () => Infinity,
    legacySignal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string; warning?: string }> {
    const { remainingMs, signal, readUnlocked } =
      typeof options === "function"
        ? { remainingMs: options, signal: legacySignal, readUnlocked: undefined }
        : options;
    throwIfAborted(signal);
    await this.pressHomeBestEffort(remainingMs, signal);
    throwIfAborted(signal);
    let swipeBudget = Math.min(5_000, remainingMs());
    if (swipeBudget <= 0) {
      throw new ActionableError(
        "wakeAndUnlock: iOS unlock budget exhausted before swipe; retry after the runner reconnects",
      );
    }
    if (readUnlocked) {
      const unlocked = await this.readUnlockedAfterWake({ readUnlocked, swipeBudget, signal });
      if (unlocked === true) {
        logger.info("[IosLockScreenUnlocker] device unlocked after wake; no swipe was needed");
        return { success: true, warning: "device unlocked after wake; no swipe was needed" };
      }
      swipeBudget = Math.min(5_000, remainingMs());
      if (swipeBudget <= 0) {
        throw new ActionableError("wakeAndUnlock: iOS unlock budget exhausted before swipe");
      }
    }
    return this.swipeAndDismiss({ remainingMs, signal, readUnlocked, swipeBudget });
  }

  private async swipeAndDismiss({
    remainingMs,
    signal,
    readUnlocked,
    swipeBudget,
  }: IosUnlockOptions & {
    swipeBudget: number;
  }): Promise<{ success: boolean; error?: string; warning?: string }> {
    const swipeDeadline = this.timer.now() + swipeBudget;
    const fast = await this.swipe({
      timeoutMs: readUnlocked ? swipeBudget / 2 : swipeBudget,
      signal,
      lockScreen: true,
    });
    if (!readUnlocked || cannotRetrySwipe(fast)) {
      logger.info(
        `[IosLockScreenUnlocker] fast swipe finished; fallback unavailable: ${fast.error ?? "no lock-state reader"}`,
      );
      return fast;
    }
    const unlocked = await awaitWhileRequestIsLive(readUnlocked({ phase: "afterSwipe" }), signal);
    if (unlocked === true) {
      logger.info("[IosLockScreenUnlocker] fast swipe unlocked the device");
      return fast;
    }
    const fallbackBudget = Math.min(swipeDeadline - this.timer.now(), remainingMs());
    if (fallbackBudget <= 0) {
      logger.info(
        "[IosLockScreenUnlocker] fast swipe left lock state locked or unknown; budget exhausted",
      );
      return fast;
    }
    const fallback = await this.swipe({ timeoutMs: fallbackBudget, signal });
    // Confirmation/polling stays with WakeAndUnlock's existing bounded probe path.
    logger.info(`[IosLockScreenUnlocker] fallback swipe finished: ${fallback.error ?? "success"}`);
    return {
      ...fallback,
      warning: "unlocked by the fallback swipe after the fast swipe had no effect",
    };
  }

  private async readUnlockedAfterWake({
    readUnlocked,
    swipeBudget,
    signal,
  }: {
    readUnlocked: NonNullable<IosUnlockOptions["readUnlocked"]>;
    swipeBudget: number;
    signal?: AbortSignal;
  }): Promise<boolean | undefined> {
    const probeAbort = new AbortController();
    try {
      const unlocked = await raceWithDeadline(
        () =>
          readUnlocked({
            phase: "afterWake",
            signal: signal ? AbortSignal.any([signal, probeAbort.signal]) : probeAbort.signal,
          }),
        {
          timer: this.timer,
          signal,
          // Reserve at least three quarters of the remaining budget for swipes.
          timeoutMs: Math.min(PRE_SWIPE_LOCK_PROBE_MAX_MS, swipeBudget / 4),
          label: "iOS post-wake lock-state probe",
          onTimeout: () => probeAbort.abort(),
        },
      );
      throwIfAborted(signal);
      return unlocked;
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[IosLockScreenUnlocker] post-wake lock-state probe failed: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async swipe({
    timeoutMs,
    signal,
    lockScreen,
  }: {
    timeoutMs: number;
    signal?: AbortSignal;
    lockScreen?: true;
  }): Promise<{ success: boolean; error?: string; outcomeIndeterminate?: boolean }> {
    try {
      const swipeAbort = new AbortController();
      const swipe = await raceWithDeadline(
        () =>
          this.actions.swipeUp(timeoutMs, {
            signal: signal ? AbortSignal.any([signal, swipeAbort.signal]) : swipeAbort.signal,
            ...(lockScreen ? { lockScreen } : {}),
          }),
        {
          timer: this.timer,
          signal,
          timeoutMs,
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
        ...(swipe.success === false && swipe.outcomeIndeterminate === true
          ? { outcomeIndeterminate: true }
          : {}),
      };
    } catch (error) {
      throwIfAborted(signal);
      const message = errorMessage(error);
      logger.warn(`[IosLockScreenUnlocker] lock-screen swipe failed: ${message}`, error);
      return { success: false, error: message };
    }
  }

  private async pressHomeBestEffort(
    remainingMs: () => number,
    signal?: AbortSignal,
  ): Promise<void> {
    // Home is best effort: its lock-screen foreground verification can fail
    // even after the display wakes. The swipe and lock-state probe decide success.
    try {
      const homeBudget = Math.min(2_000, remainingMs());
      if (homeBudget <= 0) {
        throw new ActionableError("iOS unlock budget exhausted before Home press");
      }
      throwIfAborted(signal);
      const home = await awaitWhileRequestIsLive(
        raceWithDeadline(() => this.actions.pressHome(homeBudget, signal), {
          timer: this.timer,
          timeoutMs: homeBudget,
          label: "iOS Home press before unlock",
          signal,
        }),
        signal,
      );
      if (!home.success) {
        logger.warn(`[IosLockScreenUnlocker] Home press failed: ${home.error ?? "unknown error"}`);
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[IosLockScreenUnlocker] Home press failed: ${errorMessage(error)}`, error);
    }
  }
}

// A dispatched swipe with no confirmed result (timeout, socket close, abort after the write) may
// already have unlocked the screen, so the structured `outcomeIndeterminate` marker decides that no
// fallback swipe follows, whatever the error text says. Text only covers replies that carry no
// marker: the decoder's typed runnerBusy flag is consumed by IOSCtrlProxyClient and action results
// retain only its message, and a thrown transport timeout arrives as text.
function cannotRetrySwipe(fast: { error?: string; outcomeIndeterminate?: boolean }): boolean {
  const message = fast.error;
  return (
    fast.outcomeIndeterminate === true ||
    (message !== undefined &&
      (/runner_busy|iOS runner is busy executing/i.test(message) ||
        /exceeded execution bound[\s\S]*XCUITest call is still executing/i.test(message) ||
        // The runner's deadline error (#10084). "gesture was not started" is safe to retry; a
        // gesture that completed after its deadline may already have unlocked the screen.
        /gesture completed after its deadline/i.test(message) ||
        (!message.startsWith("iOS lock-screen swipe timed out after ") &&
          /swipe timed out|request.*timed out/i.test(message))))
  );
}
