import { getAbortSignal } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { RequestManager } from "../../utils/RequestManager";
import type { RetryExecutor } from "../../utils/retry/RetryExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { ObserverPendingRequestTimeoutError } from "./ObserverPendingRequestTimeoutError";
import { RealCtrlProxyWebSocketInTestError } from "./RealCtrlProxyWebSocketInTestError";
interface PendingRequestWaitHost {
  readonly timer: Timer;
  readonly requestManager: Pick<RequestManager, "getPendingCount">;
}
interface ConnectionWaitHost {
  readonly timer: Timer;
  readonly retryExecutor: RetryExecutor;
  readonly logTag: string;
  ensureConnected(): Promise<boolean>;
}
interface RecoveryWaitHost {
  readonly timer: Timer;
  readonly recoveryPromise: Promise<boolean> | null;
}
interface HandshakeWaitHost {
  readonly timer: Timer;
  readonly supportedCommands: Set<string> | null;
  readonly pollIntervalMs: number;
  beforeHandshakeWait(signal?: AbortSignal): void;
  awaitHandshakePoll(work: () => Promise<void>, signal: AbortSignal): Promise<void>;
}

/** Queue an observer read behind the owner's already-dispatched requests. */
export async function waitForPendingRequests(
  host: PendingRequestWaitHost,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = host.timer.now() + timeoutMs;
  while (host.requestManager.getPendingCount() > 0) {
    signal?.throwIfAborted();
    const remaining = deadline - host.timer.now();
    if (remaining <= 0) {
      throw new ObserverPendingRequestTimeoutError();
    }
    await host.timer.sleep(Math.min(10, remaining));
  }
  signal?.throwIfAborted();
}

/**
 * Wait for connection with retry logic.
 *
 * @param maxAttempts Maximum number of connection attempts
 * @param delayMs Delay between attempts in milliseconds
 * @returns true if connected, false if all attempts failed
 */
export async function waitForConnection(
  host: ConnectionWaitHost,
  maxAttempts: number = 10,
  delayMs: number = 300,
): Promise<boolean> {
  const signal = getAbortSignal();
  signal?.throwIfAborted();
  const result = await host.retryExecutor.execute(
    async (attempt) => {
      const connected = await raceWithDeadline(() => host.ensureConnected(), {
        timer: host.timer,
        signal,
        label: "CtrlProxy WebSocket connect",
      });
      if (connected) {
        logger.info(
          `[${host.logTag}] WebSocket connected after ${attempt} attempt(s) (${(attempt - 1) * delayMs}ms)`,
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
          `[${host.logTag}] Connection attempt ${attempt}/${maxAttempts} failed, retrying in ${delayMs}ms`,
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
      `[${host.logTag}] WebSocket not ready after ${maxAttempts} attempts (${maxAttempts * delayMs}ms)`,
    );
    return false;
  }

  return result.value ?? false;
}

export async function awaitRecovery(
  host: RecoveryWaitHost,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<"recovered" | "not_recovering" | "failed" | "timed_out"> {
  const recovery = host.recoveryPromise;
  if (!recovery) {
    return "not_recovering";
  }
  if (signal?.aborted) {
    return "timed_out";
  }
  const timedOut = new Error("Recovery wait timed out");
  try {
    return await raceWithDeadline(
      recovery.then((connected): "recovered" | "failed" => (connected ? "recovered" : "failed")),
      {
        timer: host.timer,
        timeoutMs: budgetMs,
        signal,
        label: "Recovery wait",
        timeoutError: () => timedOut,
      },
    );
  } catch (error) {
    if (error === timedOut || signal?.aborted) {
      // The caller's deadline does not cancel recovery; its typed wait outcome is expected.
      logger.debug("[DeviceServiceClient] Recovery wait ended before recovery completed", error);
      return "timed_out";
    }
    throw error;
  }
}

export async function waitForHandshake(
  host: HandshakeWaitHost,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  host.beforeHandshakeWait(signal);
  const deadline = host.timer.now() + timeoutMs;
  while (host.supportedCommands === null && host.timer.now() < deadline) {
    if (!signal) {
      await host.timer.sleep(host.pollIntervalMs);
      continue;
    }
    let timeout: ReturnType<Timer["setTimeout"]> | undefined;
    try {
      await host.awaitHandshakePoll(
        () =>
          new Promise<void>((resolve) => {
            timeout = host.timer.setTimeout(resolve, host.pollIntervalMs);
          }),
        signal,
      );
    } finally {
      if (timeout !== undefined) {
        host.timer.clearTimeout(timeout);
      }
    }
  }
}
