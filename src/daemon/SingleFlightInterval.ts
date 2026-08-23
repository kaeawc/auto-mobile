import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface SingleFlightIntervalOptions {
  /** Maximum time shutdown waits for work already started by an interval tick. */
  stopTimeoutMs?: number;
  /** Receives a rejected background tick after its in-flight state is cleared. */
  onError?: (error: unknown) => void;
}

/**
 * Schedules asynchronous work without allowing interval callbacks to overlap.
 *
 * The callback is deliberately dropped while a prior invocation is active:
 * monitors use a completed callback as one polling epoch, so queueing a stale
 * callback would compress misses immediately after a slow dependency recovers.
 */
export class SingleFlightInterval {
  private intervalHandle: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly stopTimeoutMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly intervalMs: number,
    private readonly task: () => Promise<void>,
    options: SingleFlightIntervalOptions = {},
  ) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.onError =
      options.onError ??
      ((error) => {
        logger.error("[SingleFlightInterval] Background tick failed", error);
      });
  }

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = this.timer.setInterval(() => {
      void this.run();
    }, this.intervalMs);

    const handle = this.intervalHandle as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  }

  /** Run one polling epoch, sharing an already-active invocation if present. */
  run(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    let inFlight: Promise<void>;
    try {
      inFlight = this.task();
    } catch (error) {
      inFlight = Promise.reject(error);
    }
    this.inFlight = inFlight;
    void inFlight.then(
      () => this.clearInFlight(inFlight),
      (error) => {
        this.clearInFlight(inFlight);
        this.onError(error);
      },
    );
    return inFlight;
  }

  /** Stop future ticks and wait a bounded amount of time for the current one. */
  async stop(): Promise<boolean> {
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    return this.awaitInFlightTick();
  }

  private async awaitInFlightTick(): Promise<boolean> {
    const activeTick = this.inFlight;
    if (!activeTick) {
      return true;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timeoutHandle = this.timer.setTimeout(() => resolve(false), this.stopTimeoutMs);
    });

    try {
      return await Promise.race([
        activeTick.then(
          () => true,
          () => true,
        ),
        timeout,
      ]);
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private clearInFlight(inFlight: Promise<void>): void {
    if (this.inFlight === inFlight) {
      this.inFlight = null;
    }
  }
}
