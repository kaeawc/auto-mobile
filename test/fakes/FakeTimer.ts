import { Timer } from "../../src/utils/SystemTimer";

/**
 * Pending sleep call information
 */
interface PendingSleep {
  ms: number;
  resolve: () => void;
  timestamp: number;
  seq: number;
}

/**
 * Pending timeout information
 */
interface PendingTimeout {
  id: NodeJS.Timeout;
  callback: () => void;
  ms: number;
  timestamp: number;
  seq: number;
}

/**
 * Pending interval information
 */
interface PendingInterval {
  id: NodeJS.Timeout;
  callback: () => void;
  ms: number;
  timestamp: number;
  lastFiredAt: number;
  seq: number;
}

/**
 * Work waiting for auto-advance dispatch.
 */
interface PendingAutoAdvanceTask {
  dueAt: number;
  registrationOrder: number;
  callback: () => void;
  resolveOnReset?: () => void;
}

/**
 * Fake Timer implementation for testing.
 *
 * All time-related operations are controlled manually:
 * - sleep() pends until advanceTime() is called
 * - setTimeout() stores callbacks that fire when time advances past their delay
 * - setInterval() stores callbacks that fire repeatedly as time advances
 * - now() returns the fake currentTime
 *
 * Tests must explicitly advance time using advanceTime() or resolveAll().
 *
 * For tests that don't need time control, call enableAutoAdvance() to make
 * sleeps resolve asynchronously while preserving timer deadline order.
 */
export class FakeTimer implements Timer {
  private pendingSleeps: PendingSleep[] = [];
  private sleepHistory: number[] = [];
  private currentTime: number = 0;
  private pendingTimeouts: PendingTimeout[] = [];
  private pendingIntervals: PendingInterval[] = [];
  private nextTimeoutId: number = 1;
  private nextIntervalId: number = 1000000;
  private autoAdvance: boolean = false;
  private pendingAutoAdvanceTasks: PendingAutoAdvanceTask[] = [];
  private nextAutoAdvanceTaskOrder: number = 1;
  private autoAdvanceDispatchScheduled: boolean = false;
  // Invalidates auto-advance callbacks that were scheduled before reset().
  private autoAdvanceGeneration: number = 0;
  // Monotonic registration counter so manual advanceTime() can break equal
  // due-time ties by FIFO registration order across sleeps/timeouts/intervals.
  private nextEventSeq: number = 1;
  // Track cancelled timeout IDs for autoAdvance mode.
  private cancelledTimeoutIds: Set<number> = new Set();
  // Track cancelled interval IDs for autoAdvance mode.
  private cancelledIntervalIds: Set<number> = new Set();

  /**
   * Enable auto-advance mode where sleeps and timeouts resolve asynchronously.
   * Use this for tests that don't need to control time explicitly.
   */
  enableAutoAdvance(): void {
    this.autoAdvance = true;
  }

  /**
   * Sleep for the specified duration.
   * In normal mode: pends until advanceTime() is called.
   * In auto-advance mode: resolves asynchronously at its scheduled fake time.
   */
  async sleep(ms: number): Promise<void> {
    this.sleepHistory.push(ms);
    if (this.autoAdvance) {
      return new Promise<void>((resolve) => {
        this.enqueueAutoAdvanceTask(resolve, ms, resolve);
      });
    }
    return new Promise<void>((resolve) => {
      this.pendingSleeps.push({
        ms,
        resolve,
        timestamp: this.currentTime,
        seq: this.nextEventSeq++,
      });
    });
  }

  /**
   * Advance time and resolve all pending sleeps, fire timeouts, and intervals that have elapsed.
   *
   * Caution: catch-up fires all due interval ticks SYNCHRONOUSLY within one call —
   * no microtask boundary runs between them. A concurrency guard that drops a tick
   * while a prior async tick is still pending (e.g. a `pending` latch) will therefore
   * observe only the first of a caught-up burst, unlike a real event loop that yields
   * between turns. Drive such a monitor by advancing one interval period at a time and
   * draining microtasks between steps (see PerformanceMonitor.test.ts), not one large
   * advance. For the same reason, avoid advancing by a huge multiple of a tiny interval
   * (e.g. advanceTime(1_000_000) against a 1ms interval) — it spins that many synchronous
   * callbacks.
   * @param ms - Milliseconds to advance
   */
  advanceTime(ms: number): void {
    const target = this.currentTime + ms;

    // Fire every due sleep, timeout, and interval in due-time order (FIFO
    // registration order breaks equal-time ties). As each fires, the clock is
    // advanced to that event's OWN due time, so a callback observes its
    // scheduled time via now() (schedule-time clock) rather than the fully
    // advanced end-of-window time. Intervals catch up: an interval of period p
    // fires floor(elapsed / p) times across a single advance, not just once.
    for (;;) {
      const next = this.nextDueEvent(target);
      if (next === undefined) {
        break;
      }
      this.currentTime = next.dueAt;
      next.fire();
    }

    this.currentTime = target;
  }

  /**
   * Advance time like advanceTime(), yielding an event-loop turn after each due
   * event.
   *
   * Use this when callbacks begin asynchronous work that must settle before the
   * next caught-up interval tick. The synchronous advanceTime() remains useful
   * for deterministic single-turn tests.
   */
  async advanceTimeAsync(ms: number): Promise<void> {
    const target = this.currentTime + ms;

    for (;;) {
      const next = this.nextDueEvent(target);
      if (next === undefined) {
        break;
      }
      this.currentTime = next.dueAt;
      next.fire();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    this.currentTime = target;
  }

  /**
   * Find the earliest-due pending sleep/timeout/interval whose due time is at or
   * before `target`, breaking equal-time ties by registration order. Returns a
   * closure that removes-and-fires (sleeps/timeouts) or advances-and-fires
   * (intervals). Recomputed each loop turn in advanceTime so interval catch-up
   * and callbacks that schedule new work are handled correctly.
   */
  private nextDueEvent(target: number): { dueAt: number; fire: () => void } | undefined {
    let best: { dueAt: number; seq: number; fire: () => void } | undefined;
    const consider = (dueAt: number, seq: number, fire: () => void): void => {
      if (dueAt > target) {
        return;
      }
      if (!best || dueAt < best.dueAt || (dueAt === best.dueAt && seq < best.seq)) {
        best = { dueAt, seq, fire };
      }
    };

    for (const sleep of this.pendingSleeps) {
      consider(sleep.timestamp + sleep.ms, sleep.seq, () => {
        this.pendingSleeps = this.pendingSleeps.filter((candidate) => candidate !== sleep);
        sleep.resolve();
      });
    }

    for (const timeout of this.pendingTimeouts) {
      consider(timeout.timestamp + timeout.ms, timeout.seq, () => {
        this.pendingTimeouts = this.pendingTimeouts.filter((candidate) => candidate !== timeout);
        timeout.callback();
      });
    }

    for (const interval of this.pendingIntervals) {
      // A non-positive period would loop forever; clamp to one tick (matching
      // the real clock's setInterval(0) behaviour) and fire at most once per
      // advance by jumping lastFiredAt to the window end.
      const period = interval.ms > 0 ? interval.ms : 1;
      consider(interval.lastFiredAt + period, interval.seq, () => {
        interval.lastFiredAt = interval.ms > 0 ? interval.lastFiredAt + interval.ms : target;
        interval.callback();
      });
    }

    return best;
  }

  /**
   * Get the current fake time.
   */
  now(): number {
    return this.currentTime;
  }

  /**
   * Resolve all pending sleeps immediately regardless of time.
   * Useful for tests that don't care about timing details.
   */
  resolveAll(): void {
    const toResolve = [...this.pendingSleeps];
    this.pendingSleeps = [];
    toResolve.forEach((sleep) => sleep.resolve());
  }

  /**
   * Get all pending sleep durations.
   */
  getPendingSleeps(): number[] {
    return this.pendingSleeps.map((s) => s.ms);
  }

  /**
   * Get count of pending sleeps.
   */
  getPendingSleepCount(): number {
    return this.pendingSleeps.length;
  }

  /**
   * Get history of all sleep calls (including resolved ones).
   */
  getSleepHistory(): number[] {
    return [...this.sleepHistory];
  }

  /**
   * Get total number of sleep calls made.
   */
  getSleepCallCount(): number {
    return this.sleepHistory.length;
  }

  /**
   * Check if a specific sleep duration was called.
   */
  wasSleepCalled(ms: number): boolean {
    return this.sleepHistory.includes(ms);
  }

  /**
   * Backward compatibility alias for wasSleepCalled.
   */
  wasCalledWithDuration(ms: number): boolean {
    return this.wasSleepCalled(ms);
  }

  /**
   * Get current fake time.
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * Set the current time directly (useful for specific test scenarios).
   */
  setCurrentTime(time: number): void {
    this.currentTime = time;
  }

  /**
   * Synchronous alias for advanceTime.
   * Provided for compatibility with tests that expect this method name.
   */
  advanceTimersByTime(ms: number): void {
    this.advanceTime(ms);
  }

  /**
   * Async version of advanceTime.
   * Advances time and awaits a microtask to let any async callbacks complete.
   */
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    this.advanceTime(ms);
    // Give any async callbacks a chance to complete
    await Promise.resolve();
  }

  /**
   * Reset all state (clears pending sleeps, timeouts, intervals, history, and time).
   */
  reset(): void {
    this.autoAdvanceGeneration++;
    // Resolve all pending sleeps before clearing to avoid hanging promises
    this.resolveAll();
    this.sleepHistory = [];
    this.currentTime = 0;
    this.pendingTimeouts = [];
    this.pendingIntervals = [];
    for (const task of this.pendingAutoAdvanceTasks) {
      task.resolveOnReset?.();
    }
    this.pendingAutoAdvanceTasks = [];
    this.nextAutoAdvanceTaskOrder = 1;
    this.nextEventSeq = 1;
    this.nextTimeoutId = 1;
    this.nextIntervalId = 1000000;
    this.cancelledTimeoutIds.clear();
    this.cancelledIntervalIds.clear();
  }

  /**
   * Clear sleep history but keep pending sleeps and time.
   */
  clearHistory(): void {
    this.sleepHistory = [];
  }

  /**
   * Schedule a callback to be executed after a specified delay.
   * In normal mode: fires when advanceTime() moves past the delay.
   * In auto-advance mode: fires asynchronously at its scheduled fake time (but can be cancelled).
   */
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const id = this.nextTimeoutId as unknown as NodeJS.Timeout;
    const numericId = this.nextTimeoutId;
    this.nextTimeoutId++;
    if (this.autoAdvance) {
      this.enqueueAutoAdvanceTask(() => {
        if (!this.cancelledTimeoutIds.has(numericId)) {
          callback();
        }
        this.cancelledTimeoutIds.delete(numericId);
      }, ms);
      return id;
    }
    this.pendingTimeouts.push({
      id,
      callback,
      ms,
      timestamp: this.currentTime,
      seq: this.nextEventSeq++,
    });
    return id;
  }

  /**
   * Clear a pending timeout.
   */
  clearTimeout(handle: NodeJS.Timeout): void {
    this.pendingTimeouts = this.pendingTimeouts.filter((t) => t.id !== handle);
    // Also mark as cancelled for autoAdvance mode where callback is already scheduled
    this.cancelledTimeoutIds.add(handle as unknown as number);
  }

  /**
   * Schedule a callback to be executed repeatedly at a specified interval.
   * In normal mode: fires each time advanceTime() moves past the interval.
   * In auto-advance mode: reschedules itself at each fake interval until cancelled.
   */
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    const id = this.nextIntervalId as unknown as NodeJS.Timeout;
    const numericId = this.nextIntervalId;
    this.nextIntervalId++;
    if (this.autoAdvance) {
      const period = ms > 0 ? ms : 1;
      const generation = this.autoAdvanceGeneration;
      const scheduleNext = (): void =>
        this.enqueueAutoAdvanceTask(() => {
          if (
            generation === this.autoAdvanceGeneration &&
            !this.cancelledIntervalIds.has(numericId)
          ) {
            callback();
            if (
              generation === this.autoAdvanceGeneration &&
              !this.cancelledIntervalIds.has(numericId)
            ) {
              scheduleNext();
              return;
            }
          }
          if (generation === this.autoAdvanceGeneration) {
            this.cancelledIntervalIds.delete(numericId);
          }
        }, period);
      scheduleNext();
      return id;
    }
    this.pendingIntervals.push({
      id,
      callback,
      ms,
      timestamp: this.currentTime,
      lastFiredAt: this.currentTime,
      seq: this.nextEventSeq++,
    });
    return id;
  }

  /**
   * Clear a pending interval.
   */
  clearInterval(handle: NodeJS.Timeout): void {
    this.pendingIntervals = this.pendingIntervals.filter((i) => i.id !== handle);
    this.cancelledIntervalIds.add(handle as unknown as number);
  }

  /**
   * Get all pending timeout durations.
   */
  getPendingTimeouts(): number[] {
    return this.pendingTimeouts.map((t) => t.ms);
  }

  /**
   * Get all pending interval durations.
   */
  getPendingIntervals(): number[] {
    return this.pendingIntervals.map((i) => i.ms);
  }

  /**
   * Get count of pending timeouts.
   */
  getPendingTimeoutCount(): number {
    return this.pendingTimeouts.length;
  }

  /**
   * Get count of pending intervals.
   */
  getPendingIntervalCount(): number {
    return this.pendingIntervals.length;
  }

  /**
   * Advance time until a promise resolves.
   * Useful for tests where the code uses timer-based polling (setInterval).
   * @param promise - The promise to wait for
   * @param stepMs - Milliseconds to advance per iteration (default: 50)
   * @returns The resolved value of the promise
   */
  async resolvePromise<T>(promise: Promise<T>, stepMs: number = 50): Promise<T> {
    let settled = false;
    let result: T | undefined;
    let error: unknown;

    promise
      .then((value) => {
        settled = true;
        result = value;
      })
      .catch((err) => {
        settled = true;
        error = err;
      });

    // Advance time until promise settles
    while (!settled) {
      this.advanceTime(stepMs);
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (error) {
      throw error;
    }
    return result as T;
  }

  /**
   * Queue auto-advance work. Dispatching one task per event-loop turn gives
   * callers a chance to schedule competing deadlines before fake time moves.
   */
  private enqueueAutoAdvanceTask(
    callback: () => void,
    ms: number,
    resolveOnReset?: () => void,
  ): void {
    this.pendingAutoAdvanceTasks.push({
      dueAt: this.currentTime + Math.max(0, ms),
      registrationOrder: this.nextAutoAdvanceTaskOrder++,
      callback,
      resolveOnReset,
    });
    this.scheduleAutoAdvanceDispatch();
  }

  private scheduleAutoAdvanceDispatch(): void {
    if (this.autoAdvanceDispatchScheduled) {
      return;
    }
    this.autoAdvanceDispatchScheduled = true;
    setImmediate(() => {
      this.autoAdvanceDispatchScheduled = false;
      const task = this.takeNextAutoAdvanceTask();
      if (task === undefined) {
        return;
      }

      this.currentTime = Math.max(this.currentTime, task.dueAt);
      task.callback();
      this.scheduleAutoAdvanceDispatch();
    });
  }

  private takeNextAutoAdvanceTask(): PendingAutoAdvanceTask | undefined {
    if (this.pendingAutoAdvanceTasks.length === 0) {
      return undefined;
    }

    this.pendingAutoAdvanceTasks.sort(
      (left, right) => left.dueAt - right.dueAt || left.registrationOrder - right.registrationOrder,
    );
    return this.pendingAutoAdvanceTasks.shift();
  }
}
