import { exponentialBackoff, type BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import { BINDING_REGISTRY_BUSY_TIMEOUT_MS } from "./sqliteBindingRegistry";

/** First retry delay for shared registry contention. */
export const REGISTRY_RETRY_INITIAL_DELAY_MS = 25;
/** Retry cadence stays at this cap until cleanup lands or the caller closes. */
export const REGISTRY_RETRY_MAX_DELAY_MS = 1_000;
/** Longest quiet wait after a blocked attempt, including a session release's per-daemon DB write. */
export const REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS = 5_000;
/** Time one blocked registry write holds the event loop before failing. */
export const REGISTRY_BUSY_WRITE_MS = BINDING_REGISTRY_BUSY_TIMEOUT_MS;

interface RegistryRetryPacingOptions {
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxBlockedWaitMs?: number;
  backoff?: BackoffPolicy;
}

interface RetryWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  expedited?: AbortSignal;
  started: boolean;
}

interface SharedRetryState {
  quietUntilMs: number;
  queue: RetryWaiter[];
  active?: RetryWaiter;
  quietTimer?: NodeJS.Timeout;
  wakeAtMs?: number;
}

const retryStates = new WeakMap<RegistryRetryPacingOptions["timer"], SharedRetryState>();

/**
 * Quiet time and FIFO turns are shared by pacers using the same timer object.
 * Acquisition back-out, execution re-owning and settled-binding recovery share this pacing.
 * Callers must bound their operations because each attempt holds the shared turn.
 */
export class RegistryRetryPacing {
  private readonly closing = new AbortController();
  private readonly backoff: BackoffPolicy;
  private readonly shared: SharedRetryState;

  private readonly options: RegistryRetryPacingOptions & {
    initialDelayMs: number;
    maxDelayMs: number;
    maxBlockedWaitMs: number;
  };

  constructor(options: RegistryRetryPacingOptions) {
    this.options = {
      ...options,
      initialDelayMs: options.initialDelayMs ?? REGISTRY_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: options.maxDelayMs ?? REGISTRY_RETRY_MAX_DELAY_MS,
      maxBlockedWaitMs: options.maxBlockedWaitMs ?? REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
    };
    this.backoff = options.backoff ?? exponentialBackoff(this.options);
    let shared = retryStates.get(options.timer);
    if (!shared) {
      shared = { quietUntilMs: 0, queue: [] };
      retryStates.set(options.timer, shared);
    }
    this.shared = shared;
  }

  close(): void {
    this.closing.abort();
  }

  delay(attempt: number): number {
    try {
      const delay = this.backoff.delayForAttempt(attempt);
      if (!Number.isFinite(delay)) {
        throw new Error(`Registry retry backoff delay must be finite, got ${delay}`);
      }
      return Math.min(Math.max(delay, this.options.initialDelayMs), this.options.maxDelayMs);
    } catch (error) {
      // An injected policy must not stop expected contention recovery; use its safe cap.
      if (!this.closing.signal.aborted) {
        logger.debug(
          `[Bindings] Registry retry backoff failed; using the cap: ${errorMessage(error)}`,
          error,
        );
      }
      return this.options.maxDelayMs;
    }
  }

  /** An expedited signal wakes this wait successfully; stop/close still cancel it. */
  async wait(delayMs: number, stopped?: AbortSignal, expedited?: AbortSignal): Promise<void> {
    let handle: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    const signal = this.signal(stopped);
    const cancel = () => {
      if (handle !== undefined) {
        this.options.timer.clearTimeout(handle);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            wake = resolve;
            expedited?.addEventListener("abort", wake, { once: true });
            if (expedited?.aborted) {
              resolve();
            } else {
              handle = this.options.timer.setTimeout(resolve, delayMs);
            }
          }),
        { timer: this.options.timer, signal, label: "Registry retry wait" },
      );
    } finally {
      signal.removeEventListener("abort", cancel);
      if (wake) {
        expedited?.removeEventListener("abort", wake);
      }
      if (handle !== undefined) {
        this.options.timer.clearTimeout(handle);
      }
    }
  }

  /**
   * Callers must bound their operation: its FIFO turn is shared by every pacer on this timer.
   * Close cancels the wait, but a hung unbounded operation otherwise blocks every successor.
   */
  async run<T>(
    operation: () => Promise<T>,
    succeeded: (result: T) => boolean,
    stopped?: AbortSignal,
    expedited?: AbortSignal,
  ): Promise<T> {
    const signal = this.signal(stopped);
    signal.throwIfAborted();
    const granted = Promise.withResolvers<void>();
    const waiter: RetryWaiter = {
      resolve: granted.resolve,
      reject: granted.reject,
      expedited,
      started: false,
    };
    const wake = () => this.schedule();
    const cancel = () => {
      granted.reject(signal.reason);
      this.removeQueued(waiter);
      if (this.shared.active === waiter && !waiter.started) {
        this.shared.active = undefined;
      }
      this.schedule();
    };
    signal.addEventListener("abort", cancel, { once: true });
    expedited?.addEventListener("abort", wake, { once: true });
    this.shared.queue.push(waiter);
    let startedMs: number | undefined;
    let failed = true;
    try {
      this.schedule();
      await granted.promise;
      signal.throwIfAborted();
      waiter.started = true;
      startedMs = this.options.timer.now();
      const result = await raceWithDeadline(operation, {
        timer: this.options.timer,
        signal,
        label: "Registry retry operation",
      });
      failed = !succeeded(result);
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
      expedited?.removeEventListener("abort", wake);
      if (failed && startedMs !== undefined) {
        this.extendQuietPeriod(startedMs);
      }
      this.removeQueued(waiter);
      if (this.shared.active === waiter) {
        this.shared.active = undefined;
      }
      this.schedule();
    }
  }

  private removeQueued(waiter: RetryWaiter): void {
    const index = this.shared.queue.indexOf(waiter);
    if (index !== -1) {
      this.shared.queue.splice(index, 1);
    }
  }

  /** Grant the first eligible waiter without moving quiet-blocked entries. */
  private schedule(): void {
    const shared = this.shared;
    const timer = this.options.timer;
    const eligible = (waiter: RetryWaiter) =>
      waiter.expedited?.aborted || timer.now() >= shared.quietUntilMs;
    const waiter = shared.active ? undefined : shared.queue.find(eligible);
    const needsQuietTimer = !shared.active && !waiter && shared.queue.length > 0;
    try {
      this.updateQuietTimer(needsQuietTimer);
    } catch (error) {
      logger.warn(`[Bindings] Registry retry quiet timer failed: ${errorMessage(error)}`, error);
      for (const queued of [...shared.queue]) {
        if (!eligible(queued)) {
          this.removeQueued(queued);
          queued.reject(error);
        }
      }
    }
    if (waiter) {
      this.removeQueued(waiter);
      shared.active = waiter;
      waiter.resolve();
    }
  }

  private updateQuietTimer(needsQuietTimer: boolean): void {
    const shared = this.shared;
    const timer = this.options.timer;
    if (!needsQuietTimer || shared.wakeAtMs !== shared.quietUntilMs) {
      if (shared.quietTimer !== undefined) {
        const handle = shared.quietTimer;
        shared.quietTimer = undefined;
        shared.wakeAtMs = undefined;
        timer.clearTimeout(handle);
      }
    }
    if (needsQuietTimer && shared.quietTimer === undefined) {
      const handle = timer.setTimeout(() => {
        // A failed clear may leave an old callback; it no longer owns the shared wake-up.
        if (shared.quietTimer !== handle) {
          return;
        }
        shared.quietTimer = undefined;
        shared.wakeAtMs = undefined;
        this.schedule();
      }, shared.quietUntilMs - timer.now());
      shared.quietTimer = handle;
      shared.wakeAtMs = shared.quietUntilMs;
    }
  }

  /** Account for a failed inline attempt that deliberately took no turn. */
  noteBlocked(startedMs: number): void {
    this.extendQuietPeriod(startedMs);
  }

  private extendQuietPeriod(startedMs: number): void {
    if (this.closing.signal.aborted) {
      return;
    }
    const endMs = this.options.timer.now();
    this.shared.quietUntilMs = Math.max(
      this.shared.quietUntilMs,
      endMs + Math.min(Math.max(0, endMs - startedMs), this.options.maxBlockedWaitMs),
    );
    this.schedule();
  }

  private signal(stopped?: AbortSignal): AbortSignal {
    return stopped ? AbortSignal.any([this.closing.signal, stopped]) : this.closing.signal;
  }
}
