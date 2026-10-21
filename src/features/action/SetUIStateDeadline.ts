import type { ProgressCallback } from "./BaseVisualChange";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";

/** Subscribe to extensions of a live transport deadline. */
export type LiveDeadlineSubscriber = (listener: () => void) => (() => void) | undefined;

/**
 * Wraps a field's progress callback so every tick that reaches it also
 * calls `onTick` -- the hook `raceAgainstDeadline` uses to re-arm an
 * in-flight race's timeout against the LIVE cutoff (issue #6222 P1,
 * fujuk). A progress notification is the only thing that can move a
 * `ProgressExtendableDeadline` forward (`extendOnProgress`,
 * `src/daemon/socketServer.ts`), so re-checking exactly when one is
 * forwarded -- rather than only once at field admission -- is what lets a
 * mid-field extension apply to THIS SAME field's own remaining budget
 * instead of only to fields admitted afterward. A no-op (returns
 * `undefined`) when there is no inner callback to wrap, matching
 * `fieldProgress`'s own contract.
 */
export function withRearmOnTick(
  inner: ProgressCallback | undefined,
  onTick: () => void,
): ProgressCallback | undefined {
  if (!inner) {
    return undefined;
  }
  return async (childProgress, childTotal, message) => {
    await inner(childProgress, childTotal, message);
    onTick();
  };
}

export class SetUIStateDeadline {
  constructor(private readonly timer: Timer) {}
  /**
   * Race a unit of device I/O against a live-read cutoff (issue #6222 P1,
   * unifying fujug/fujuk/fujun). Used for both the initial observation and
   * each admitted field's `processField()` call. Without this, either can run
   * past the transport deadline and reproduce the exact silent-discard this whole feature exists to
   * prevent, even though it was correctly started under budget at the time.
   *
   * This deadline is a safety net: when it wins, started work may remain
   * active in the background. An external AbortSignal is forwarded to the
   * text actions and observation so they can stop between device calls.
   *
   * Takes a THUNK, not an already-started promise: `startWork()` must not be
   * called until AFTER the timeout is armed. Its own dependencies can run
   * synchronously far enough to matter (fakes in tests advance a shared
   * clock synchronously; real device I/O at least burns real wall-clock time
   * before its first genuine suspension) -- starting it as part of
   * evaluating this method's arguments, before its body runs, would arm the
   * timeout against a clock that already moved, silently shrinking the
   * work's actual budget.
   *
   * `getCutoffMs` is read fresh both when the timeout is (re-)armed here and
   * again every time `startWork`'s own `onTick` hook fires (see
   * `withRearmOnTick`) -- so a live-extended deadline applies to an
   * ALREADY-RUNNING race, not just to work started afterward (fujuk). A
   * cutoff at or before now re-arms as an IMMEDIATE timeout rather than a
   * no-op, so an extension that shrinks the effective remaining time (e.g.
   * the live deadline did not move) still resolves promptly.
   *
   * @param startWork - Starts the work. Invoked exactly once, after the
   *   timeout below is first armed. Receives `onTick`, to be invoked
   *   whenever the caller learns the live cutoff may have moved.
   * @param getCutoffMs - Returns the CURRENT absolute cutoff (already
   *   headroom-adjusted, e.g. `cutoffMs()`) this race must finish before.
   *   Read fresh on every (re-)arm, never cached.
   * @param describeWork - Only used to identify the work in a debug log if
   *   its promise eventually settles after the race already timed out.
   * @param subscribeToCutoffMoves - Optional subscription to live-deadline
   *   extensions. While the race is pending, every extension re-arms the
   *   timeout exactly like `onTick`, so an extension that lands after the
   *   last tick's re-read (but before the old cutoff) still keeps the work
   *   running (issue #6283). Unsubscribed as soon as the race settles.
   * @returns The work's real result if it settles in time, or the literal
   *   string `"timed-out"` if the timeout wins the race.
   */
  async race<T>(
    startWork: (onTick: () => void) => Promise<T>,
    getCutoffMs: () => number,
    describeWork: string,
    subscribeToCutoffMoves?: LiveDeadlineSubscriber,
  ): Promise<T | "timed-out"> {
    // A background settlement after abandonment has no observer left to
    // report to beyond this debug trace -- expected once the work's own
    // budget has already been spent.
    const logBackgroundSettlement = (workPromise: Promise<T>): void => {
      workPromise
        .then(() => {
          logger.debug(`[SetUIState] Background work settled after timeout for ${describeWork}`);
        })
        .catch((error: unknown) => {
          logger.debug(
            `[SetUIState] Background work rejected after timeout for ${describeWork}: ${errorMessage(error)}`,
          );
        });
    };

    return new Promise<T | "timed-out">((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      // startWork may synchronously advance a FakeTimer and fire the timeout
      // before returning its promise. The initialized holder is safe to read
      // during that reentrant callback; the post-start check traces it later.
      const workState: { promise?: Promise<T> } = {};
      let unsubscribeCutoffMoves: (() => void) | undefined;

      const finishTimedOut = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        unsubscribeCutoffMoves?.();
        if (timeoutHandle !== undefined) {
          this.timer.clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (workState.promise) {
          logBackgroundSettlement(workState.promise);
        }
        resolve("timed-out");
      };

      // (Re-)arms the timeout against a FRESHLY read cutoff. A non-positive
      // remaining budget still resolves "timed-out" immediately rather than
      // arming a timer for it.
      const armTimeout = (): void => {
        if (settled) {
          return;
        }
        if (timeoutHandle !== undefined) {
          this.timer.clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        const budgetMs = getCutoffMs() - this.timer.now();
        if (budgetMs <= 0) {
          finishTimedOut();
          return;
        }
        timeoutHandle = this.timer.setTimeout(finishTimedOut, budgetMs);
      };

      // Passed to `startWork` as `onTick`: re-arms against the live cutoff
      // whenever the caller learns it may have moved (issue #6222 P1,
      // fujuk). A no-op once already settled.
      const onTick = (): void => {
        armTimeout();
      };

      armTimeout();
      // Re-arm whenever the live deadline is extended, not only on a tick:
      // the daemon applies the extension in its own `onprogress` handler,
      // which may run after this call's tick already re-read the old value
      // (issue #6283).
      if (!settled) {
        unsubscribeCutoffMoves = subscribeToCutoffMoves?.(armTimeout);
      }
      // Armed above; only now does the work actually start.
      workState.promise = startWork(onTick);
      const startedWorkPromise = workState.promise;
      if (settled) {
        // The timeout above already fired (synchronously, budget<=0, or
        // re-entrantly while `startWork()` was still running synchronously)
        // before this closure could observe it via `workState.promise` -- trace
        // its eventual settlement here instead.
        logBackgroundSettlement(startedWorkPromise);
        return;
      }
      startedWorkPromise.then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          unsubscribeCutoffMoves?.();
          if (timeoutHandle !== undefined) {
            this.timer.clearTimeout(timeoutHandle);
          }
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          unsubscribeCutoffMoves?.();
          if (timeoutHandle !== undefined) {
            this.timer.clearTimeout(timeoutHandle);
          }
          // The known callers (`processField`, `ObserveScreen.execute`)
          // resolve rather than reject in practice -- this is a defensive
          // fallback for something truly unexpected. Propagated to the
          // caller rather than swallowed here, since only the caller knows
          // how to shape a failure specific to what it was racing.
          reject(error);
        },
      );
    });
  }
}
