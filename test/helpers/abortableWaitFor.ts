import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

/** Bound an operation that can otherwise hold a CI isolate indefinitely. */
export async function withDeadline<T>(
  step: string,
  timeoutMs: number,
  run: () => Promise<T>,
  timer: Timer = defaultTimer,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = timer.setTimeout(
      () =>
        reject(
          new Error(
            `${step} did not complete within ${timeoutMs}ms — bounded real-I/O deadline hit`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    if (timeout !== undefined) {
      timer.clearTimeout(timeout);
    }
  }
}

/**
 * Poll a cancellable operation until it succeeds or its absolute deadline
 * expires. The predicate must pass its signal to any cancellable real I/O.
 */
export async function waitFor(
  predicate: (signal: AbortSignal) => Promise<boolean>,
  message: string,
  timeoutMs = 30_000,
  timer: Timer = defaultTimer,
): Promise<void> {
  const deadline = timer.now() + timeoutMs;
  while (timer.now() < deadline) {
    const controller = new AbortController();
    const result = predicate(controller.signal);
    try {
      if (await withDeadline(message, deadline - timer.now(), () => result, timer)) {
        return;
      }
    } catch (error) {
      controller.abort(error);
      // Do not let a canceled subprocess race the caller's teardown.
      await result.catch(() => undefined);
      throw error;
    }
    await timer.sleep(100);
  }
  throw new Error(message);
}
