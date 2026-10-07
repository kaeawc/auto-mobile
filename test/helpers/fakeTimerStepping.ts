import type { FakeTimer } from "../fakes/FakeTimer";

/** Wait for an observable state without giving the real event loop a turn. */
export async function drainUntil(
  predicate: () => boolean,
  { description, maxTurns = 1_000 }: { description: string; maxTurns?: number },
): Promise<void> {
  for (let turn = 0; turn < maxTurns && !predicate(); turn++) {
    await Promise.resolve();
  }
  if (!predicate()) {
    throw new Error(`Microtask drain exceeded ${maxTurns} turns waiting for ${description}`);
  }
}

/** For negative assertions whose completed no-op has no observable signal. */
export async function drainMicrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

// The four DevicePool suites measured a longest observable-event gap of 40 turns;
// the shared drain adds an await boundary, so thresholds 1..38 failed and 39
// passed. Use four times that minimum (156) as margin for await-chain growth.
export const FAKE_TIMER_QUIET_TURNS = 156;
const MAX_MICROTASK_TURNS = 1_000;

async function drainTimerState(
  timer: FakeTimer,
  settled: () => boolean,
  quietTurns: number,
  maxTurns: number,
): Promise<boolean> {
  // Compare allocation-free public counters, including sleep history so even
  // same-duration re-sleeps reset quiet. Same-count timeout/interval replacement
  // within one turn is invisible, even with a different duration, as is work
  // with no timer signal. This is bounded observed quiet, not proof that every
  // async operation has finished.
  let previousTime = timer.now();
  let previousSleepCalls = timer.getSleepCallCount();
  let previousSleeps = timer.getPendingSleepCount();
  let previousTimeouts = timer.getPendingTimeoutCount();
  let previousIntervals = timer.getPendingIntervalCount();
  let quiet = 0;
  for (let turn = 0; turn < maxTurns && !settled() && quiet < quietTurns; turn++) {
    await Promise.resolve();
    const time = timer.now();
    const sleepCalls = timer.getSleepCallCount();
    const sleeps = timer.getPendingSleepCount();
    const timeouts = timer.getPendingTimeoutCount();
    const intervals = timer.getPendingIntervalCount();
    quiet =
      time === previousTime &&
      sleepCalls === previousSleepCalls &&
      sleeps === previousSleeps &&
      timeouts === previousTimeouts &&
      intervals === previousIntervals
        ? quiet + 1
        : 0;
    previousTime = time;
    previousSleepCalls = sleepCalls;
    previousSleeps = sleeps;
    previousTimeouts = timeouts;
    previousIntervals = intervals;
  }
  return settled() || quiet >= quietTurns;
}

/** Drain observed timer activity; unsuitable for negative assertions without timer signals. */
export async function drainUntilQuiescent(
  timer: FakeTimer,
  {
    description = "FakeTimer state",
    quietTurns = FAKE_TIMER_QUIET_TURNS,
    maxTurns = MAX_MICROTASK_TURNS,
  }: { description?: string; quietTurns?: number; maxTurns?: number } = {},
): Promise<void> {
  const cap = Math.min(maxTurns, MAX_MICROTASK_TURNS);
  if (!(await drainTimerState(timer, () => false, quietTurns, cap))) {
    throw new Error(
      `Microtask drain exceeded ${cap} turns waiting for quiescence of ${description}`,
    );
  }
}

/**
 * Settle a promise by firing pending fake-timer events in due order, one due time per
 * step, draining only microtasks in between. Unlike enableAutoAdvance(), which spends a
 * real event-loop turn per event, this never waits on the real loop, so its cost does not
 * grow with runner load. Use it when the waits span very different durations, where a
 * fixed `stepMs` would be either too coarse or too many steps.
 */
export async function settleByFakeEvents<T>(
  timer: FakeTimer,
  promise: Promise<T>,
  { maxEvents = 1_000, description }: { maxEvents?: number; description: string },
): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const isSettled = () => settled;
  for (let event = 0; event <= maxEvents; event++) {
    await drainTimerState(timer, isSettled, FAKE_TIMER_QUIET_TURNS, MAX_MICROTASK_TURNS);
    if (settled) {
      return await promise;
    }
    const delayMs = timer.getMsUntilNextDueEvent();
    if (delayMs === undefined) {
      throw new Error(`Nothing is pending on fake time, but ${description} has not settled`);
    }
    if (event < maxEvents) {
      timer.advanceTime(delayMs);
    }
  }
  throw new Error(`Fake time fired ${maxEvents} events without settling ${description}`);
}

/** Drive a bounded fake-time wait, allowing async work to park before each step. */
export async function settleWithFakeTime<T>(
  timer: FakeTimer,
  promise: Promise<T>,
  { stepMs, maxSteps, description }: { stepMs: number; maxSteps: number; description: string },
): Promise<T> {
  let settled = false;
  // Observe both outcomes immediately, including falsy rejection reasons.
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const isSettled = () => settled;
  for (let step = 0; step <= maxSteps; step++) {
    await drainTimerState(timer, isSettled, FAKE_TIMER_QUIET_TURNS, MAX_MICROTASK_TURNS);
    // Quiet but unsettled work may be parked on fake time: always try the next
    // step, retaining the finite step-cap error even if the drain hit its cap.
    if (settled) {
      return await promise;
    }
    if (step < maxSteps) {
      timer.advanceTime(stepMs);
    }
  }
  throw new Error(`Fake time exceeded ${maxSteps} steps of ${stepMs}ms waiting for ${description}`);
}
