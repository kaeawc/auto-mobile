import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { getDbWriteBarrier } from "../db";
import {
  type NavigationRetention,
  type NavigationRetentionSummary,
  resolveNavigationRetentionIntervalMs,
} from "../db/navigationRetention";

/**
 * Background scheduler for {@link NavigationRetention} (nav (app,build) Phase 3,
 * #4986). Fires a prune pass on a fixed interval, dropping overlapping ticks so a
 * slow pass never stacks. Extracted from the daemon so the cadence + skip guard
 * can be driven deterministically with an injected {@link Timer} in tests; the
 * daemon passes its default timer in production.
 */
export class NavigationRetentionMonitor {
  private timerHandle: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private lastSummary: NavigationRetentionSummary | null = null;

  constructor(
    private readonly retention: NavigationRetention,
    private readonly timer: Timer = defaultTimer,
    intervalMs?: number,
  ) {
    this.intervalMs = resolveNavigationRetentionIntervalMs(intervalMs);
  }

  start(): void {
    if (this.timerHandle) {
      return;
    }
    this.timerHandle = this.timer.setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Never keep the process alive for a best-effort cleanup pass.
    const handle = this.timerHandle as { unref?: () => void };
    if (handle && typeof handle.unref === "function") {
      handle.unref();
    }
  }

  stop(): void {
    if (this.timerHandle) {
      this.timer.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  /** The most recent prune summary, for a storage indicator / diagnostics. */
  getLastSummary(): NavigationRetentionSummary | null {
    return this.lastSummary;
  }

  /**
   * Run a single prune pass. Exposed for deterministic testing; also invoked on
   * each interval tick. Overlapping invocations are dropped, and any failure is
   * logged and swallowed — retention is best-effort and must not crash the daemon.
   *
   * The pass is registered with the DB write barrier so an in-flight prune DRAINS
   * within the shutdown budget (`Daemon.stop()` → barrier.drain → closeDatabase),
   * rather than racing the connection close. When the barrier is already draining,
   * `track` short-circuits (returns undefined) and the pass is skipped.
   */
  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const summary = await getDbWriteBarrier().track(() => this.retention.prune(this.timer.now()));
      if (summary) {
        this.lastSummary = summary;
      }
    } catch (error) {
      logger.warn(`Navigation retention pass failed: ${error}`, error);
    } finally {
      this.running = false;
    }
  }
}
