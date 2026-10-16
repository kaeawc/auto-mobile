/** One unsettled restore of a recorded device-state baseline, joined by every caller that asks. */
export interface PendingRestore<S> {
  state: S;
  /** Set when the device was removed: no retry may reach a replacement. */
  removed: boolean;
  controller: AbortController;
  /** Drop the baseline from its owning session once restored or retired. */
  clear: () => void;
  result: Promise<{ pending: Promise<void> | null }>;
}

/**
 * The per-kind differences between the clock, rotation and screen-reader restores that are policy
 * rather than mechanics (#11794). The mechanics live in {@link DeviceStateRestoreQueue}.
 */
export interface RestoreQueuePolicy {
  kind: "clock" | "rotation" | "screen-reader";
  /**
   * Retired when the pool bumps a device's incarnation after a VM restore. Only the clock is today;
   * rotation and screen reader are retired only on removal. Whether that split is intended is an
   * open question, so this field records current behaviour rather than a decision.
   */
  retiredOnIncarnationBump: boolean;
  /**
   * How a setup that outlives a bounded release hands its restore to device quarantine: the clock
   * awaits the restore's start and tracks only a real pending retry; rotation and screen reader
   * track eagerly because their setup still holds the device mutex.
   */
  setupHandoff: "await-then-track" | "track-eagerly";
  /** Shown when a setup notices its device was removed mid-flight. */
  removedDuringSetupMessage: string;
}

/**
 * Join point per device and baseline object, plus the removal generation that lets a setup or a
 * deferred restore notice its device was removed. Starting, retrying and abandoning a restore stay
 * with the owner, which supplies them as callbacks.
 */
export class DeviceStateRestoreQueue<S extends object> {
  readonly targets = new Map<string, Map<S, PendingRestore<S>>>();
  private readonly generations = new Map<string, number>();

  constructor(readonly policy: RestoreQueuePolicy) {}

  /** Bumped by every {@link retire}; a changed value means the device was removed. */
  generation(deviceId: string): number {
    return this.generations.get(deviceId) ?? 0;
  }

  /**
   * The restore already joined for this baseline, else a new one published before `start` runs any
   * asynchronous work.
   */
  join(
    deviceId: string,
    state: S,
    clear: () => void,
    start: (target: PendingRestore<S>) => Promise<{ pending: Promise<void> | null }>,
  ): Promise<{ pending: Promise<void> | null }> {
    let targets = this.targets.get(deviceId);
    const existing = targets?.get(state);
    if (existing) {
      return existing.result;
    }
    if (!targets) {
      targets = new Map();
      this.targets.set(deviceId, targets);
    }
    const result = Promise.withResolvers<{ pending: Promise<void> | null }>();
    const target: PendingRestore<S> = {
      state,
      removed: false,
      controller: new AbortController(),
      result: result.promise,
      clear,
    };
    // Publish the join point before starting any asynchronous restore work.
    targets.set(state, target);
    void start(target).then(result.resolve, result.reject);
    return target.result;
  }

  /** Removal retires in-memory ownership; no retries may target a replacement device. */
  retire(deviceId: string): void {
    const targets = this.targets.get(deviceId);
    this.generations.set(deviceId, this.generation(deviceId) + 1);
    for (const target of targets?.values() ?? []) {
      target.removed = true;
      target.controller.abort();
      target.clear();
    }
    this.targets.delete(deviceId);
  }
}

/** How one restore attempt ended before any retry. */
export type RestoreAttemptOutcome = { outcome: "restored" } | { outcome: "failed"; error: unknown };

/** The per-target pieces of a kind's restore, built once when its restoration starts. */
export interface RestoreRun {
  /** One full dispatch of the restore; resolves once restored and cleared. */
  restore(): Promise<void>;
  /** Called when the first attempt failed or timed out and the device will be quarantined. */
  quarantined(outcome: "failed" | "timed-out", error: unknown): void;
  /** The retry loop that runs after a failed first attempt. */
  retry(restoration: Promise<RestoreAttemptOutcome>): Promise<void>;
}

/** What differs between kinds in starting a restoration; the skeleton is shared (#11794). */
export interface RestoreKindSpec<S extends object> {
  queue: DeviceStateRestoreQueue<S>;
  /** Sentence-case name used in labels and messages, such as "Screen reader". */
  name: string;
  timeoutMs: number;
  /** Maps an unexpected failure of the first attempt's own wait; the clock rethrows it as is. */
  mapStartError(error: unknown): unknown;
  prepare(deviceId: string, target: PendingRestore<S>): RestoreRun;
}

/** Bounded retries with backoff, then abandonment with the state remembered (rotation, screen reader). */
export interface BoundedRetrySpec<S extends object> {
  attempts: number;
  delayForAttempt(attempt: number): number;
  isNonRetryable(error: unknown): boolean;
  logFirstFailure(deviceId: string, error: unknown): void;
  logRetryFailure(deviceId: string, attempt: number, error: unknown): void;
  /** Give up: release the device from quarantine and remember the state still on it. */
  abandon(deviceId: string, target: PendingRestore<S>, lastError: unknown, when: string): void;
}

/** The one extra attempt at a baseline an earlier release gave up on. */
export interface AbandonedRestoreSpec<S extends object> {
  memory: Map<string, S>;
  inFlight: Map<string, Promise<void>>;
  timeoutMs: number;
  label: string;
  /** Run one dispatch of the restore; the signal aborts it. */
  restore(deviceId: string, state: S, signal: AbortSignal): Promise<void>;
  /** The restore succeeded. */
  restored(deviceId: string, state: S): void;
  /** The restore failed; the record is kept unless this forgets it. */
  failed(deviceId: string, state: S, error: unknown): void;
}
