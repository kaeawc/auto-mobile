import type { InitialObservationFrame } from "./observationInitialFrame";
import { INITIAL_FRAME_MAX_CONCURRENCY } from "./observationInitialFrame";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { TTLCache } from "../utils/cache/Cache";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

// A reconnect burst can reuse a complete frame, without delaying a later refresh.
export const INITIAL_FRAME_FRESHNESS_WINDOW_MS = 1_000;
// Whole started-job budget: hierarchy (3s) + screenshot (3s), with 14s for
// connection/setup and fallback overhead. Queued time does not consume this budget.
export const INITIAL_FRAME_CAPTURE_DEADLINE_MS = 20_000;

interface InitialFrameResult {
  frame: InitialObservationFrame;
  replay: boolean;
}

export interface ObservationInitialFrameCoordinator {
  request(
    deviceId: string,
    capture: () => Promise<InitialObservationFrame | undefined>,
    signal: AbortSignal,
    maxConcurrency?: number,
  ): Promise<InitialFrameResult | undefined>;
}

interface Waiter {
  complete(result?: InitialFrameResult): void;
  fail(error: unknown): void;
}

interface Capture {
  deviceId: string;
  run: () => Promise<InitialObservationFrame | undefined>;
  started: boolean;
  waiters: Set<Waiter>;
}

/** One instance per stream server. Authorization belongs to delivery, never the shared capture. */
export class DefaultObservationInitialFrameCoordinator implements ObservationInitialFrameCoordinator {
  private readonly captures = new Map<string, Capture>();
  private readonly queue: Capture[] = [];
  private readonly recent: TTLCache<string, InitialObservationFrame>;
  private active = 0;

  constructor(
    private readonly timer: Timer = defaultTimer,
    private maxConcurrency = INITIAL_FRAME_MAX_CONCURRENCY,
    private readonly getLiveFrameGeneration: (deviceId: string) => number = () => 0,
  ) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("Initial observation frame concurrency must be a positive integer");
    }
    this.recent = new TTLCache(timer, { ttlMs: INITIAL_FRAME_FRESHNESS_WINDOW_MS, maxEntries: 32 });
  }

  request(
    deviceId: string,
    capture: () => Promise<InitialObservationFrame | undefined>,
    signal: AbortSignal,
    maxConcurrency?: number,
  ): Promise<InitialFrameResult | undefined> {
    if (maxConcurrency !== undefined) {
      if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
        throw new RangeError("Initial observation frame concurrency must be a positive integer");
      }
      // An override changes admission for this shared queue, never creates a per-caller pool.
      // Already-started captures finish normally if the limit is lowered.
      this.maxConcurrency = maxConcurrency;
    }
    if (signal.aborted) {
      return Promise.resolve(undefined);
    }
    const recent = this.recent.get(deviceId);
    if (recent && recent.liveFrameGeneration === this.getLiveFrameGeneration(deviceId)) {
      return Promise.resolve({ frame: recent, replay: true });
    }
    this.recent.delete(deviceId);
    let entry = this.captures.get(deviceId);
    if (!entry) {
      entry = { deviceId, run: capture, started: false, waiters: new Set() };
      this.captures.set(deviceId, entry);
      this.queue.push(entry);
    }
    const shared = entry;
    const result = new Promise<InitialFrameResult | undefined>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        shared.waiters.delete(waiter);
      };
      const waiter: Waiter = {
        complete: (value) => {
          cleanup();
          resolve(value);
        },
        fail: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        waiter.complete();
        if (!shared.started && shared.waiters.size === 0) {
          this.captures.delete(deviceId);
          this.queue.splice(this.queue.indexOf(shared), 1);
        }
      };
      shared.waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.drain();
    return result;
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      entry.started = true;
      this.active++;
      // Keep an ownerless in-flight capture joinable until completion. SingleFlight's
      // cancel-all mode removes it immediately, allowing overlapping recaptures of this device.
      void this.capture(entry);
    }
  }

  private async capture(entry: Capture): Promise<void> {
    try {
      const generation = this.getLiveFrameGeneration(entry.deviceId);
      const captured = await raceWithDeadline(entry.run, {
        timer: this.timer,
        timeoutMs: INITIAL_FRAME_CAPTURE_DEADLINE_MS,
        label: `Initial observation frame for ${entry.deviceId}`,
      });
      // A live frame delivered while connecting/capturing supersedes this result.
      // Drop it, including for joined waiters; a later subscription can recapture.
      const frame =
        generation === this.getLiveFrameGeneration(entry.deviceId) ? captured : undefined;
      if (frame) {
        frame.liveFrameGeneration = generation;
      }
      if (frame?.screenshot && entry.waiters.size > 0) {
        this.recent.set(entry.deviceId, frame);
      }
      for (const waiter of [...entry.waiters]) {
        waiter.complete(frame ? { frame, replay: false } : undefined);
      }
    } catch (error) {
      // Live request boundaries log their failures; ownerless jobs still need a trace.
      if (entry.waiters.size === 0) {
        logger.warn(
          `[Daemon] Initial observation capture failed for ${entry.deviceId}: ${errorMessage(error)}`,
          error,
        );
      }
      for (const waiter of [...entry.waiters]) {
        waiter.fail(error);
      }
    } finally {
      this.captures.delete(entry.deviceId);
      this.active--;
      this.drain();
    }
  }
}
