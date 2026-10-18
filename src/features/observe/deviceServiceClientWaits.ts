/**
 * Deadline-bounded waits used by DeviceServiceClient: connect-with-retry,
 * recovery-promise racing and the observer's pending-request drain.
 */

import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { RequestManager } from "../../utils/RequestManager";
import type { RetryExecutor } from "../../utils/retry/RetryExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { ObserverPendingRequestTimeoutError } from "./ObserverPendingRequestTimeoutError";
import { RealCtrlProxyWebSocketInTestError } from "./RealCtrlProxyWebSocketInTestError";

export interface ConnectWithRetryOptions {
  retryExecutor: RetryExecutor;
  timer: Timer;
  logTag: string;
  ensureConnected: () => Promise<boolean>;
  maxAttempts: number;
  delayMs: number;
}

/**
 * Retry `ensureConnected` up to `maxAttempts` times, `delayMs` apart.
 *
 * @returns true if connected, false if all attempts failed
 */
export async function connectWithRetry(options: ConnectWithRetryOptions): Promise<boolean> {
  const { retryExecutor, timer, logTag, ensureConnected, maxAttempts, delayMs } = options;
  const signal = getAbortSignal();
  signal?.throwIfAborted();
  const result = await retryExecutor.execute(
    async (attempt) => {
      const connected = await raceWithDeadline(() => ensureConnected(), {
        timer,
        signal,
        label: "CtrlProxy WebSocket connect",
      });
      if (connected) {
        logger.info(
          `[${logTag}] WebSocket connected after ${attempt} attempt(s) (${(attempt - 1) * delayMs}ms)`,
        );
        return true;
      }

      throw new Error(`Connection attempt ${attempt} failed`);
    },
    {
      maxAttempts,
      signal,
      delays: delayMs,
      shouldRetry: (error) => !(error instanceof RealCtrlProxyWebSocketInTestError),
      onRetry: (_error, attempt) => {
        logger.debug(
          `[${logTag}] Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`,
        );
      },
    },
  );
  signal?.throwIfAborted();

  if (result.error instanceof RealCtrlProxyWebSocketInTestError) {
    throw result.error;
  }
  if (!result.success) {
    logger.warn(
      `[${logTag}] WebSocket not ready after ${maxAttempts} attempts (${maxAttempts * delayMs}ms)`,
    );
    return false;
  }

  return result.value ?? false;
}

/** Race an in-flight recovery against a budget and an optional caller signal. */
export async function awaitRecoveryOutcome(
  recovery: Promise<boolean>,
  timer: Timer,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<"recovered" | "failed" | "timed_out"> {
  const timedOut = new Error("Recovery wait timed out");
  try {
    return await raceWithDeadline(
      recovery.then((connected) => (connected ? "recovered" : "failed") as "recovered" | "failed"),
      {
        timer,
        timeoutMs: budgetMs,
        signal,
        label: "Recovery wait",
        timeoutError: () => timedOut,
      },
    );
  } catch (error) {
    if (error === timedOut || signal?.aborted) {
      return "timed_out";
    }
    throw error;
  }
}

/** Queue an observer read behind the owner's already-dispatched requests. */
export async function waitForPendingRequestsToDrain(
  requestManager: RequestManager,
  timer: Timer,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = timer.now() + timeoutMs;
  while (requestManager.getPendingCount() > 0) {
    signal?.throwIfAborted();
    const remaining = deadline - timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    await timer.sleep(Math.min(10, remaining));
  }
  signal?.throwIfAborted();
}
