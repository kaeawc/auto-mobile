import { runOutsideRequestContext } from "../../../utils/AbortContext";
import type { DeviceLockState } from "../../../models/DeviceLockState";
import type { IosLockStateProbe, IosLockStateReading } from "./IosLockStateProbe";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";

export interface IosLockStateInvalidation {
  /**
   * The action that invalidated the cache always leaves the device locked (an iOS power
   * press locks an unlocked device and keeps a locked one locked, #17770). SpringBoard
   * publishes the new lock state a moment after the press acknowledges, so an unlocked
   * reading inside the transition window is a pre-transition reading, not the answer.
   */
  expectLocked?: boolean;
}

export interface IosLockStateInvalidator {
  invalidate(deviceId: string, invalidation?: IosLockStateInvalidation): void;
}
interface Entry {
  epoch: number;
  reading?: IosLockStateReading;
  expiresAt: number;
  /** Last known reading and when it stopped being fresh; served while a refresh runs. */
  lastKnown?: { lock: DeviceLockState; staleSince: number };
  flight?: Promise<IosLockStateReading>;
}

export class CachedIosLockStateProbe implements IosLockStateProbe, IosLockStateInvalidator {
  private readonly entries = new Map<string, Entry>();
  private readonly settling = new Set<string>();
  private readonly epochs = new Map<string, number>();
  /** Deadline of a pending lock transition; unlocked readings before it are re-polled. */
  private readonly lockTransitions = new Map<string, number>();
  constructor(
    private readonly inner: IosLockStateProbe,
    private readonly timer: Timer,
    private readonly options: {
      knownTtlMs?: number;
      lockedTtlMs?: number;
      failureTtlMs?: number;
      settleTtlMs?: number;
      /** How long past expiry an unlocked reading may be served while it refreshes. */
      staleUnlockedMs?: number;
      /** Same for a locked reading; short, because a locked device is about to change. */
      staleLockedMs?: number;
      /** How long after an `expectLocked` invalidation an unlocked reading is re-polled. */
      lockTransitionMs?: number;
      /** Delay between re-polls while a lock transition is pending. */
      lockTransitionPollMs?: number;
    } = {},
  ) {}

  invalidate(deviceId: string, invalidation: IosLockStateInvalidation = {}): void {
    // Detached flights still resolve for existing callers, but cannot fill the new epoch.
    this.entries.delete(deviceId);
    this.settling.add(deviceId);
    this.epochs.set(deviceId, (this.epochs.get(deviceId) ?? 0) + 1);
    if (invalidation.expectLocked) {
      this.lockTransitions.set(
        deviceId,
        this.timer.now() + (this.options.lockTransitionMs ?? 5_000),
      );
    } else {
      this.lockTransitions.delete(deviceId);
    }
  }

  async read(deviceId: string, signal?: AbortSignal): Promise<IosLockStateReading> {
    try {
      return await raceWithDeadline(() => this.sharedRead(deviceId), {
        timer: this.timer,
        signal,
        label: "iOS lock-state cache",
      });
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation detaches this caller without cancelling the shared flight.
        logger.debug("[iOS] Lock-state cache caller aborted");
        return { kind: "unknown", reason: "pending", message: "caller aborted" };
      }
      logger.warn(`[iOS] Lock-state cache failed: ${errorMessage(error)}`, error);
      return { kind: "unknown", reason: "error", message: errorMessage(error) };
    }
  }

  private sharedRead(deviceId: string): Promise<IosLockStateReading> {
    let entry = this.entries.get(deviceId);
    if (entry?.reading) {
      if (this.timer.now() < entry.expiresAt) {
        // A cached failure must not hide a recent known reading while the probe is unhealthy.
        const kept = entry.reading.kind === "known" ? undefined : this.staleReading(entry);
        return Promise.resolve(kept ?? entry.reading);
      }
    }
    if (!entry?.flight) {
      entry = { expiresAt: 0, epoch: this.epochs.get(deviceId) ?? 0, lastKnown: entry?.lastKnown };
      this.entries.set(deviceId, entry);
      entry.flight = this.fill(deviceId, entry);
    }
    // Stale-while-revalidate (#15311): a burst of observes after a TTL expiry would otherwise
    // all wait on one slow `simctl spawn`, miss the observe budget, and report the lock as
    // unknown. A recent known reading is a better answer than "pending"; the refresh already
    // runs, and any button press, wake or release invalidated this entry (dropping lastKnown).
    const stale = this.staleReading(entry);
    return stale ? Promise.resolve(stale) : entry.flight;
  }

  private staleReading(entry: Entry): IosLockStateReading | undefined {
    const known = entry.lastKnown;
    if (!known) {
      return undefined;
    }
    const windowMs = known.lock.locked
      ? (this.options.staleLockedMs ?? 10_000)
      : (this.options.staleUnlockedMs ?? 120_000);
    return this.timer.now() - known.staleSince < windowMs
      ? { kind: "known", lock: known.lock }
      : undefined;
  }

  private async readInner(deviceId: string): Promise<IosLockStateReading> {
    try {
      // Caller signals must never cancel a flight shared with other observations.
      return await runOutsideRequestContext(async () => this.inner.read(deviceId));
    } catch (error) {
      return this.probeFailure(error);
    }
  }

  private probeFailure(error: unknown): IosLockStateReading {
    logger.warn(`[iOS] Shared lock-state probe failed: ${errorMessage(error)}`, error);
    return { kind: "unknown", reason: "error", message: errorMessage(error) };
  }

  private isCurrent(deviceId: string, entry: Entry): boolean {
    return (this.epochs.get(deviceId) ?? 0) === entry.epoch;
  }

  /** True while this flight's unlocked reading predates an expected lock transition. */
  private awaitingLock(deviceId: string, entry: Entry, reading: IosLockStateReading): boolean {
    const deadline = this.lockTransitions.get(deviceId);
    return (
      deadline !== undefined &&
      this.isCurrent(deviceId, entry) &&
      reading.kind === "known" &&
      !reading.lock.locked &&
      this.timer.now() < deadline
    );
  }

  /**
   * Re-polls a pre-transition unlocked reading until the host reports the lock or the bounded
   * window ends (#17770). Callers past their observe budget get `pending`, never the stale
   * unlocked value, and the flight fills the cache once the transition lands.
   */
  private async awaitLockTransition(
    deviceId: string,
    entry: Entry,
    first: IosLockStateReading,
  ): Promise<IosLockStateReading> {
    let reading = first;
    while (this.awaitingLock(deviceId, entry, reading)) {
      await this.timer.sleep(this.options.lockTransitionPollMs ?? 250);
      reading = await this.readInner(deviceId);
    }
    return reading;
  }

  private async fill(deviceId: string, entry: Entry): Promise<IosLockStateReading> {
    let reading: IosLockStateReading;
    try {
      // Inline (not readInner) so an ordinary fill lands as promptly as a direct inner read.
      reading = await runOutsideRequestContext(async () => this.inner.read(deviceId));
    } catch (error) {
      reading = this.probeFailure(error);
    }
    if (this.awaitingLock(deviceId, entry, reading)) {
      reading = await this.awaitLockTransition(deviceId, entry, reading);
    }
    if (this.isCurrent(deviceId, entry)) {
      let ttlMs = this.options.failureTtlMs ?? 5_000;
      if (reading.kind === "known") {
        // A locked reading ends the transition; past the deadline the host reading is trusted.
        this.lockTransitions.delete(deviceId);
        ttlMs = reading.lock.locked
          ? (this.options.lockedTtlMs ?? 2_000)
          : (this.options.knownTtlMs ?? 30_000);
        // Only a known reading in the current epoch consumes settling. Never
        // lengthen a shorter locked TTL when capping the first transition read.
        if (this.settling.delete(deviceId)) {
          ttlMs = Math.min(ttlMs, this.options.settleTtlMs ?? 2_000);
        }
      }
      entry.reading = reading;
      entry.expiresAt = this.timer.now() + ttlMs;
      if (reading.kind === "known") {
        entry.lastKnown = { lock: reading.lock, staleSince: entry.expiresAt };
      }
      entry.flight = undefined;
    }
    return reading;
  }
}
