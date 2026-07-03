import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

/**
 * Tracks in-flight best-effort DB writes so graceful shutdown can quiesce them
 * (bounded) before `closeDatabase()` runs.
 *
 * Fire-and-forget telemetry/cleanup writes are untracked by construction
 * (`void this.handleMessage(...)`, `cleanupRetention().catch(() => {})`), so the
 * shutdown path has no handle to await. This barrier is that handle: writers
 * route their DB work through {@link track}, and shutdown calls {@link drain} to
 * wait — with a hard time bound so a wedged write can never hang shutdown (the
 * exact failure mode issue #2792 is preventing).
 */
export interface DbWriteBarrier {
  /** True once shutdown drain has begun; new tracked writes short-circuit. */
  isDraining(): boolean;

  /**
   * Run a best-effort DB write under the barrier. While draining, the write is
   * skipped (resolves `undefined`) so no new query ever enters the connection
   * once close is imminent — avoiding "Cannot use a closed database" thrown to
   * callers on the way down.
   */
  track<T>(work: () => Promise<T>): Promise<T | undefined>;

  /**
   * Flip the draining flag so subsequent {@link track} calls short-circuit.
   * The flag latches for the process lifetime: production exits after shutdown,
   * and a same-process restart (tests) starts from a fresh barrier via
   * {@link resetDbWriteBarrier} or an injected instance.
   */
  beginDrain(): void;

  /**
   * Begin draining and await outstanding tracked writes, bounded by `timeoutMs`.
   * Resolves `true` if every tracked write settled, `false` if the bound elapsed
   * first (shutdown then proceeds to close anyway — best-effort writes were
   * best-effort).
   */
  drain(timeoutMs: number): Promise<boolean>;

  /** Count of outstanding tracked writes (diagnostics/tests). */
  inFlightCount(): number;
}

export class InMemoryDbWriteBarrier implements DbWriteBarrier {
  #inFlight = 0;
  #draining = false;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle?: () => void;
  readonly #timer: Timer;

  constructor(timer: Timer = defaultTimer) {
    this.#timer = timer;
  }

  isDraining(): boolean {
    return this.#draining;
  }

  inFlightCount(): number {
    return this.#inFlight;
  }

  async track<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (this.#draining) {
      // Safe to swallow: these writes are best-effort and shutdown is imminent.
      logger.debug("[DbWriteBarrier] Skipping best-effort DB write during shutdown drain");
      return undefined;
    }

    if (this.#inFlight++ === 0) {
      this.#idle = new Promise<void>(resolve => {
        this.#resolveIdle = resolve;
      });
    }

    try {
      return await work();
    } finally {
      if (--this.#inFlight === 0) {
        this.#resolveIdle?.();
        this.#resolveIdle = undefined;
      }
    }
  }

  beginDrain(): void {
    this.#draining = true;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    this.beginDrain();

    if (this.#inFlight === 0) {
      return true;
    }

    let handle: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>(resolve => {
      handle = this.#timer.setTimeout(() => resolve(false), timeoutMs);
    });

    const drained = this.#idle.then(() => true);
    const result = await Promise.race([drained, timeout]);

    if (handle !== undefined) {
      this.#timer.clearTimeout(handle);
    }
    return result;
  }
}

let sharedBarrier: DbWriteBarrier | null = null;

/** The process-wide barrier shared by writers and the shutdown drain. */
export function getDbWriteBarrier(): DbWriteBarrier {
  if (!sharedBarrier) {
    sharedBarrier = new InMemoryDbWriteBarrier();
  }
  return sharedBarrier;
}

/** Reset the shared barrier (testing only). */
export function resetDbWriteBarrier(): void {
  sharedBarrier = null;
}
