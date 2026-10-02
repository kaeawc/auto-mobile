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
  for (let step = 0; step <= maxSteps; step++) {
    // The promise may traverse several awaits before registering its next timer.
    // Unrelated recurring timers cannot serve as a readiness predicate here.
    for (let turn = 0; turn < 1_000 && !settled; turn++) {
      await Promise.resolve();
    }
    if (settled) {
      return await promise;
    }
    if (step < maxSteps) {
      timer.advanceTime(stepMs);
    }
  }
  throw new Error(`Fake time exceeded ${maxSteps} steps of ${stepMs}ms waiting for ${description}`);
}
