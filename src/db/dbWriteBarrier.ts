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
   * Count an ALREADY-STARTED best-effort write toward the shutdown drain without
   * inserting an await hop into the caller's chain (issue #2885). The caller
   * starts the promise itself and keeps awaiting the *original* promise object, so
   * the write's start time and its resolution timing relative to anything the
   * caller interleaves are byte-for-byte identical to a world with no barrier at
   * all. This lets the fire-and-forget navigation-graph write be drained without
   * touching the hot-path nav-event↔hierarchy-update ordering that "preserve SDK
   * screen names" depends on.
   *
   * Why not {@link track} here? `await track(() => write())` starts the write at
   * the same time, but adds one promise-resolution turn before the navigation
   * handler resumes. The #3506 ordering guards prove that lets a concurrent
   * hierarchy path resume first. Keep `trackExisting` for this narrow hot path so
   * the caller can await its original promise with no extra turn. Prefer plain
   * {@link track} everywhere the caller does not already own the started promise
   * on an ordering-sensitive path — this method is the narrow exception, not the
   * default.
   *
   * Contract / misuse warning: the returned promise NEVER rejects (it resolves the
   * value on success and `undefined` on rejection) so a fire-and-forget
   * `void barrier.trackExisting(p)` cannot surface an unhandled rejection. But it
   * only swallows ITS OWN derived copy — the ORIGINAL `p`'s rejection is still the
   * caller's to own. Always use the exact idiom
   * `const p = write(); void barrier.trackExisting(p); await p;` (or otherwise
   * `.catch` `p`); passing an un-awaited promise
   * (`void barrier.trackExisting(write())`) leaks an unhandled rejection on the
   * original. Unlike {@link track}, which owns promise creation, this method
   * cannot enforce that for you.
   *
   * While draining it short-circuits: the write already started and cannot be
   * skipped, so it is simply not counted (Part 1's dialect reject-on-closed makes
   * that mid-flight close race safe, issue #2792) and `undefined` is returned.
   * Consequence: `trackExisting` only meaningfully drains writes registered
   * *before* {@link beginDrain}; a write registered mid-drain gets best-effort
   * Part-1 coverage, not a drain guarantee.
   */
  trackExisting<T>(work: Promise<T>): Promise<T | undefined>;

  /**
   * Flip the draining flag so subsequent {@link track} calls short-circuit.
   * The flag latches for the instance's lifetime; a fresh cold start comes from
   * a new barrier. `closeDatabase()` clears the *shared* barrier via
   * {@link resetDbWriteBarrier} on every DB close, so a same-process reopen —
   * whether a real shutdown drain-then-reopen or a test restart — resolves a
   * fresh, non-draining barrier from {@link getDbWriteBarrier} (issue #2896).
   *
   * Every shared-barrier consumer resolves `getDbWriteBarrier()` at use-time
   * (per-write), so the {@link resetDbWriteBarrier} identity swap reaches all of
   * them — none capture the instance at construction. TelemetryRecorder,
   * FailureAnalyticsRepository and SessionManager were converted from a captured
   * field to a per-write resolver in #2912 (decision (a)); AndroidCtrlProxyClient
   * and IosSdkEventIngestor already resolved fresh per call. A future in-process
   * reopen path therefore needs no consumer reconstruction and no in-place
   * barrier reset.
   *
   * The two use-site consumers deliberately take NO `getBarrier` resolver
   * parameter, unlike the three converted ones. That asymmetry is intentional,
   * not an oversight: the conversion existed to fix construction-captured
   * staleness, which resolving the global per call already avoids. A resolver
   * would exist only to let a test swap the instance, and a test can `spyOn` the
   * freshly-reset singleton instead (see CtrlProxyClient.test.ts). Unify them
   * with the resolver pattern if a test ever genuinely needs injection (#2960).
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

    this.#enter();
    try {
      return await work();
    } finally {
      this.#leave();
    }
  }

  trackExisting<T>(work: Promise<T>): Promise<T | undefined> {
    if (this.#draining) {
      // The write already started and cannot be un-started; it is simply not
      // counted toward the drain (Part 1's reject-on-closed covers the race,
      // issue #2792). Resolve `undefined` and never reject — safe to `void`.
      logger.debug("[DbWriteBarrier] Not tracking an in-flight DB write during shutdown drain");
      return work.then(
        () => undefined,
        () => undefined,
      );
    }

    this.#enter();
    // Attach the settle handler to the ORIGINAL promise so the caller can keep
    // awaiting `work` directly with unchanged timing. The derived promise
    // swallows rejection to `undefined` so a fire-and-forget `void` of it never
    // surfaces an unhandled rejection — the caller's own await owns `work`'s error.
    return work.then(
      (value) => {
        this.#leave();
        return value as T | undefined;
      },
      () => {
        this.#leave();
        return undefined;
      },
    );
  }

  /** Increment the in-flight count, arming the idle promise on the 0→1 edge. */
  #enter(): void {
    if (this.#inFlight++ === 0) {
      this.#idle = new Promise<void>((resolve) => {
        this.#resolveIdle = resolve;
      });
    }
  }

  /** Decrement the in-flight count, resolving the idle promise on the 1→0 edge. */
  #leave(): void {
    if (--this.#inFlight === 0) {
      this.#resolveIdle?.();
      this.#resolveIdle = undefined;
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
    const timeout = new Promise<boolean>((resolve) => {
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

/**
 * Discard the shared barrier so the next {@link getDbWriteBarrier} lazily
 * creates a fresh, non-draining one. Called by `closeDatabase()` so a
 * same-process DB reopen cold-starts the barrier (issue #2896) — its draining
 * flag would otherwise latch for the process lifetime after a shutdown drain —
 * and by tests for isolation.
 *
 * Identity swap, not in-place reset (issue #2912 decision (a)). Now that every
 * shared-barrier consumer re-resolves {@link getDbWriteBarrier} per write (see
 * {@link beginDrain}), the swap reaches all of them: in the drain→close window a
 * late write still resolves the *previous*, still-draining barrier and
 * short-circuits (the #2792 safety margin); only after this reset does a new
 * write resolve the fresh non-draining barrier. Note the short-circuit protects
 * only writes that resolve the still-draining barrier: a use-time consumer firing
 * *after* the reset (e.g. `AndroidCtrlProxyClient.markInstalledAppsStale()`,
 * fire-and-forget from `onConnectionClosed()`) resolves the fresh, non-draining
 * barrier and is NOT short-circuited — it attempts a write against the just-closed
 * connection, protected only by the synchronous reset→`process.exit(0)` window
 * plus its own `try/catch` (#2912 sub-item 2), not by this swap. Kept as an identity swap rather
 * than an in-place `#draining` clear because, with all consumers per-write, the
 * two are behaviorally equivalent — so in-place reset (issue option (b)) would
 * only grow the {@link DbWriteBarrier} interface with a `reset()` for no benefit
 * while no in-process reopen path exists. Revisit if one is added.
 */
export function resetDbWriteBarrier(): void {
  sharedBarrier = null;
}
