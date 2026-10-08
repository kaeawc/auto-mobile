import { Timer } from "../../src/utils/SystemTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// Events the auto-advance pump fires before yielding one real event-loop turn.
const AUTO_ADVANCE_EVENTS_PER_BURST = 100;

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
  private autoAdvancePumpRunning: boolean = false;
  private pacedIntervalTickScheduled: boolean = false;
  // Monotonic registration counter so manual advanceTime() can break equal
  // due-time ties by FIFO registration order across sleeps/timeouts/intervals.
  private nextEventSeq: number = 1;

  /**
   * Enable auto-advance mode where sleeps and timeouts resolve asynchronously.
   * Use this for tests that don't need to control time explicitly.
   *
   * A microtask-only pump waits for the timer state to go quiet (see
   * drainUntilQuiescent), then fires the next due sleep, timeout, or interval
   * tick in due order (FIFO on equal deadlines), one event per drain. It never
   * waits on the real event loop, so a starved runner cannot stretch a test's
   * real-time budget while fake time crawls. Two bounds keep endless background
   * work from running away: every AUTO_ADVANCE_EVENTS_PER_BURST events the pump
   * yields one real turn, and while only intervals are pending it fires one tick
   * per real turn. Work that completes only on a real event-loop turn (a real
   * socket, a fake or test step that answers via setImmediate) loses any race
   * against a pending fake deadline: deliver it on a microtask or
   * process.nextTick instead.
   */
  enableAutoAdvance(): void {
    this.autoAdvance = true;
    this.kickAutoAdvancePump();
  }

  /**
   * Sleep for the specified duration.
   * In normal mode: pends until advanceTime() is called.
   * In auto-advance mode: resolves asynchronously at its scheduled fake time.
   */
  async sleep(ms: number): Promise<void> {
    this.sleepHistory.push(ms);
    const sleeping = new Promise<void>((resolve) => {
      this.pendingSleeps.push({
        ms,
        resolve,
        timestamp: this.currentTime,
        seq: this.nextEventSeq++,
      });
    });
    this.kickAutoAdvancePump();
    return sleeping;
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
   * next caught-up interval tick. Pure promise-based harnesses can inject a
   * microtask drain as afterEvent to avoid host scheduling without changing the
   * event ordering. The synchronous advanceTime() remains useful
   * for deterministic single-turn tests.
   */
  async advanceTimeAsync(
    ms: number,
    afterEvent: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
  ): Promise<void> {
    const target = this.currentTime + ms;

    for (;;) {
      const next = this.nextDueEvent(target);
      if (next === undefined) {
        break;
      }
      this.currentTime = Math.max(this.currentTime, next.dueAt);
      next.fire();
      await afterEvent();
    }

    // Auto-advance may have moved the clock past target while this awaited.
    this.currentTime = Math.max(this.currentTime, target);
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
   * Fake milliseconds until the earliest pending sleep, timeout, or interval tick is
   * due, or undefined when nothing is pending. Auto-advanced work is counted too.
   */
  getMsUntilNextDueEvent(): number | undefined {
    const next = this.nextDueEvent(Number.POSITIVE_INFINITY);
    return next === undefined ? undefined : Math.max(0, next.dueAt - this.currentTime);
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
    // Resolve all pending sleeps before clearing to avoid hanging promises
    this.resolveAll();
    this.sleepHistory = [];
    this.currentTime = 0;
    this.pendingTimeouts = [];
    this.pendingIntervals = [];
    this.nextEventSeq = 1;
    this.nextTimeoutId = 1;
    this.nextIntervalId = 1000000;
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
    this.nextTimeoutId++;
    this.pendingTimeouts.push({
      id,
      callback,
      ms,
      timestamp: this.currentTime,
      seq: this.nextEventSeq++,
    });
    this.kickAutoAdvancePump();
    return id;
  }

  /**
   * Clear a pending timeout.
   */
  clearTimeout(handle: NodeJS.Timeout): void {
    this.pendingTimeouts = this.pendingTimeouts.filter((t) => t.id !== handle);
  }

  /**
   * Schedule a callback to be executed repeatedly at a specified interval.
   * In normal mode: fires each time advanceTime() moves past the interval.
   * In auto-advance mode: reschedules itself at each fake interval until cancelled.
   */
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    const id = this.nextIntervalId as unknown as NodeJS.Timeout;
    this.nextIntervalId++;
    this.pendingIntervals.push({
      id,
      callback,
      ms,
      timestamp: this.currentTime,
      lastFiredAt: this.currentTime,
      seq: this.nextEventSeq++,
    });
    this.kickAutoAdvancePump();
    return id;
  }

  /**
   * Clear a pending interval.
   */
  clearInterval(handle: NodeJS.Timeout): void {
    this.pendingIntervals = this.pendingIntervals.filter((i) => i.id !== handle);
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
   * Fire the most-recently-registered pending timeout immediately, ignoring
   * the normal due-time/FIFO-registration-order tie-break that `advanceTime`
   * uses. Simulates a Timer implementation (or runtime) that does not
   * guarantee FIFO-among-equal-delay firing, so a test can assert behavior
   * holds regardless of which of two same-duration timers actually fires
   * first (see the `DatabaseHealthProbe` two-timeout ordering fragility,
   * issue #6655). No-op if there are no pending timeouts.
   */
  fireNewestPendingTimeout(): void {
    let newest: PendingTimeout | undefined;
    for (const timeout of this.pendingTimeouts) {
      if (!newest || timeout.seq > newest.seq) {
        newest = timeout;
      }
    }
    if (!newest) {
      return;
    }
    this.pendingTimeouts = this.pendingTimeouts.filter((candidate) => candidate !== newest);
    this.currentTime = Math.max(this.currentTime, newest.timestamp + newest.ms);
    newest.callback();
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

  /** Start the microtask pump if auto-advance is on and it is not already running. */
  private kickAutoAdvancePump(): void {
    if (!this.autoAdvance || this.autoAdvancePumpRunning) {
      return;
    }
    this.autoAdvancePumpRunning = true;
    queueMicrotask(() => void this.runAutoAdvancePump());
  }

  private async runAutoAdvancePump(): Promise<void> {
    let then: "stop" | "burst" | "pacedInterval" = "stop";
    try {
      for (let event = 0; event < AUTO_ADVANCE_EVENTS_PER_BURST; event++) {
        // process.nextTick callbacks queued from a microtask run only once the
        // microtask queue empties, which an active drain never lets happen; let
        // them (e.g. a fake child's "exit") land before fake time moves.
        await new Promise<void>((resolve) => process.nextTick(resolve));
        // Hitting the drain's turn cap only means work is still active; fire the
        // next event anyway, as a real clock would.
        await drainUntilQuiescent(this, { description: "auto-advanced FakeTimer" }).catch(
          () => undefined,
        );
        if (this.onlyIntervalsPending()) {
          then = "pacedInterval";
          return;
        }
        if (!this.fireNextDueEvent()) {
          return;
        }
      }
      then = "burst";
    } finally {
      if (then === "burst") {
        // An endless poll would otherwise monopolize the microtask queue; give the
        // host one real turn, then keep pumping. The pump stays marked running
        // until then, so new registrations cannot restart it from a microtask.
        setImmediate(() => {
          this.autoAdvancePumpRunning = false;
          this.kickAutoAdvancePump();
        });
      } else {
        this.autoAdvancePumpRunning = false;
        if (then === "pacedInterval") {
          this.schedulePacedIntervalTick();
        }
      }
    }
  }

  private onlyIntervalsPending(): boolean {
    return (
      this.pendingIntervals.length > 0 &&
      this.pendingSleeps.length === 0 &&
      this.pendingTimeouts.length === 0
    );
  }

  /**
   * With only intervals pending, nothing is waiting on fake time except periodic
   * background work (heartbeats, pollers) that never ends on its own. Pumping it
   * from microtasks would spin fake time forward without bound while the rest of
   * the test waits, so fire one tick per real event-loop turn instead.
   */
  private schedulePacedIntervalTick(): void {
    if (this.pacedIntervalTickScheduled) {
      return;
    }
    this.pacedIntervalTickScheduled = true;
    setImmediate(() => {
      this.pacedIntervalTickScheduled = false;
      if (this.autoAdvancePumpRunning) {
        return;
      }
      if (this.onlyIntervalsPending()) {
        this.fireNextDueEvent();
      }
      this.kickAutoAdvancePump();
    });
  }

  /** Fire exactly one earliest-due event (FIFO on ties); false when nothing is pending. */
  private fireNextDueEvent(): boolean {
    const earliest = this.nextDueEvent(Number.POSITIVE_INFINITY);
    if (earliest === undefined) {
      return false;
    }
    // Re-select with a finite window so a zero-period interval records a finite
    // lastFiredAt; the selection itself is unchanged.
    const event = this.nextDueEvent(earliest.dueAt) ?? earliest;
    this.currentTime = Math.max(this.currentTime, event.dueAt);
    event.fire();
    return true;
  }
}
