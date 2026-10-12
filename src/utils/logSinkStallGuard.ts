import type { Timer } from "./SystemTimer";

interface PendingWrite {
  issuedAt: number;
  settle: (completed: boolean) => void;
  fail: (error: unknown) => void;
}

interface StallPolicy {
  timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">;
  timeoutMs: number;
  abandonMs?: number;
  stalled: (pending: number) => void;
  resumed: (elapsedMs: number, diverted: number) => void;
  abandoned?: (elapsedMs: number, pending: number) => void;
}

/** One watchdog for the oldest unresolved operation, also shared by rotation waiters. */
export class LogSinkStallGuard {
  private readonly pending = new Set<PendingWrite>();
  private timeout: NodeJS.Timeout | undefined;
  private episode: { detectedAt: number; diverted: number; failed: number } | undefined;
  private observing = true;

  constructor(private readonly policy: StallPolicy) {}

  get stalled(): boolean {
    return this.episode !== undefined;
  }

  divert(): void {
    if (this.episode) {
      this.episode.diverted++;
    }
  }

  track(start: (done: (error?: unknown) => void) => void): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const pending = { issuedAt: this.policy.timer.now(), settle: resolve, fail: reject };
      this.pending.add(pending);
      this.armOldest();
      try {
        start((error) => this.complete(pending, error));
      } catch (error) {
        // A synchronous sink failure follows the same caller-owned degradation as a callback error.
        this.complete(pending, error);
      }
    });
  }

  /** Shutdown retains its existing drain deadline; only diagnostic timers stop. */
  suspend(): void {
    this.observing = false;
    this.clearTimeout();
  }

  /** Closed/abandoned operations no longer hold flush or accept late callbacks. */
  retire(error?: unknown): void {
    this.suspend();
    for (const pending of this.pending) {
      if (error) {
        pending.fail(error);
      } else {
        pending.settle(false);
      }
    }
    this.pending.clear();
    this.episode = undefined;
  }

  private complete(pending: PendingWrite, error: unknown): void {
    if (!this.pending.delete(pending)) {
      return;
    }
    if (error) {
      if (this.episode) {
        this.episode.failed++;
      }
      pending.fail(error);
    } else {
      pending.settle(true);
    }
    if (!this.observing) {
      return;
    }
    if (this.episode && !error && !this.oldestExpired()) {
      this.resume();
    }
    if (this.pending.size === 0 && !this.episode) {
      this.clearTimeout();
    }
    this.armOldest();
  }

  private oldest(): PendingWrite | undefined {
    return this.pending.values().next().value;
  }

  private oldestExpired(): boolean {
    const oldest = this.oldest();
    return (
      oldest !== undefined && this.policy.timer.now() - oldest.issuedAt >= this.policy.timeoutMs
    );
  }

  private resume(): void {
    const episode = this.episode;
    this.episode = undefined;
    this.clearTimeout();
    if (episode) {
      this.policy.resumed(this.policy.timer.now() - episode.detectedAt, episode.diverted);
    }
  }

  private armOldest(): void {
    const oldest = this.oldest();
    if (!this.observing || this.timeout !== undefined || this.episode || !oldest) {
      return;
    }
    this.arm(Math.max(0, this.policy.timeoutMs - (this.policy.timer.now() - oldest.issuedAt)));
  }

  private arm(delay: number): void {
    this.timeout = this.policy.timer.setTimeout(() => {
      this.timeout = undefined;
      this.onDeadline();
    }, delay);
    // FakeTimer uses numeric handles; production handles must not keep a CLI alive.
    if (typeof this.timeout === "object" && typeof this.timeout.unref === "function") {
      this.timeout.unref();
    }
  }

  private onDeadline(): void {
    if (this.episode) {
      const elapsed = this.policy.timer.now() - this.episode.detectedAt;
      const dropped = this.pending.size + this.episode.failed;
      this.retire();
      this.policy.abandoned?.(elapsed, dropped);
      return;
    }
    if (!this.oldestExpired()) {
      this.armOldest();
      return;
    }
    this.episode = { detectedAt: this.policy.timer.now(), diverted: 0, failed: 0 };
    this.policy.stalled(this.pending.size);
    // Expired timers run before already-completed I/O callbacks on a starved host.
    // Keep the sink alive: destroying at detection would discard those good lines.
    for (const pending of this.pending) {
      pending.settle(false);
    }
    if (this.policy.abandonMs !== undefined) {
      this.arm(this.policy.abandonMs);
    }
  }

  private clearTimeout(): void {
    if (this.timeout !== undefined) {
      this.policy.timer.clearTimeout(this.timeout);
    }
    this.timeout = undefined;
  }
}
