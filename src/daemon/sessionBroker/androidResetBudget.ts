import { ActionableError } from "../../models/ActionableError";
import { AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbCommandTimeoutError";
import { exponentialBackoff } from "../../utils/Backoff";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

export const ANDROID_RESET_ADB_ATTEMPTS = 4;
export const ANDROID_RESET_MIN_ATTEMPT_MS = 2000;
// Bounded post-abort process settlement, not a command timeout.
export const ANDROID_RESET_SETTLEMENT_MS = 2000;
const backoff = exponentialBackoff({ initialDelayMs: 250, multiplier: 2, maxDelayMs: 2000 });

export function adbAttemptTimeoutMs(
  remainingMs: number,
  attempt: number,
  attempts = ANDROID_RESET_ADB_ATTEMPTS,
): number {
  return Math.min(
    remainingMs,
    Math.max(ANDROID_RESET_MIN_ATTEMPT_MS, Math.floor(remainingMs / 2 ** (attempts - attempt + 2))),
  );
}

export function isTransientAdbTimeout(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") {
    return false;
  }
  return error instanceof AdbCommandTimeoutError || /timed out after \d+ms/.test(error.message);
}

interface ResetBudgetOptions {
  timer: Pick<Timer, "now" | "sleep">;
  deadlineMs: number;
  signal?: AbortSignal;
  label: string;
}

export function ctrlProxyDeadlineMs(timer: Pick<Timer, "now">, deadlineMs: number): number {
  const now = timer.now();
  const remaining = deadlineMs - now;
  return (
    now + Math.min(remaining, Math.max(ANDROID_RESET_MIN_ATTEMPT_MS, Math.floor(remaining / 4)))
  );
}

async function pause(options: ResetBudgetOptions, attempt: number): Promise<void> {
  await options.timer.sleep(
    Math.min(
      backoff.delayForAttempt(attempt),
      Math.max(0, options.deadlineMs - options.timer.now()),
    ),
  );
  options.signal?.throwIfAborted();
}

export async function retryAdbWithinBudget<T>(
  operation: (timeoutMs: number) => Promise<T>,
  options: ResetBudgetOptions & { minAttemptMs?: number; attempts?: number },
): Promise<T> {
  const attempts = options.attempts ?? ANDROID_RESET_ADB_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    const remaining = options.deadlineMs - options.timer.now();
    if (remaining <= 0) {
      throw new ActionableError(`${options.label} exceeded the reset budget`);
    }
    const timeoutMs = Math.min(
      remaining,
      Math.max(options.minAttemptMs ?? 0, adbAttemptTimeoutMs(remaining, attempt, attempts)),
    );
    try {
      const result = await operation(timeoutMs);
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (
        !isTransientAdbTimeout(error) ||
        attempt >= attempts ||
        options.timer.now() >= options.deadlineMs
      ) {
        throw error;
      }
      logger.warn(`${options.label} timed out; retrying (attempt ${attempt + 1})`, error);
    }
    await pause(options, attempt);
  }
}

export async function pollUntilWithinBudget(
  probe: (timeoutMs: number) => Promise<boolean>,
  options: ResetBudgetOptions,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    const remaining = options.deadlineMs - options.timer.now();
    if (remaining <= 0) {
      return false;
    }
    const ready = await probe(adbAttemptTimeoutMs(remaining, Math.min(attempt, 2)));
    options.signal?.throwIfAborted();
    if (options.timer.now() >= options.deadlineMs) {
      return false;
    }
    if (ready) {
      return true;
    }
    await pause(options, attempt);
  }
}
