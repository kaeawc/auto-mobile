import { toActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

/** Listener cleanup with no bound of its own; the quarantine caps it once its holder leaves. */
export interface AbandonablePendingDeviceCleanup {
  name: string;
  leftover: string;
  /** Fence late work before the device can be acquired again. */
  abandon?: () => void;
}

interface PendingDeviceCleanupBound {
  settlesBy?: number;
  /** Present only until a manager-enforced cap starts. */
  start?: () => void;
}

export interface DeviceCleanupQuarantineHost {
  timer: Timer;
  /** The session clock every bound is stamped with. */
  now(): number;
  /** Whether a live session currently owns the device. */
  hasOwner(deviceId: string): boolean;
  /** Cap the quarantine puts on listener cleanup once its holder leaves. */
  teardownCapMs: number;
  /** Retry hint when nothing bounds the quarantine. */
  defaultRetryAfterMs: number;
}

/**
 * Post-release device work, keyed by device id rather than session id: the device stays
 * quarantined (a bind is refused) until it settles. Holds no session state (#11793).
 */
export class DeviceCleanupQuarantine {
  /** Device work that outlived its bounded release phase, as one chained promise per device. */
  private readonly pending = new Map<string, Promise<void>>();
  /** Individual promises let an undo join every cleanup except the gate it still owns. */
  private readonly work = new Map<string, Set<Promise<unknown>>>();
  /** Bounds belong to individual promises and disappear as each settles. */
  private readonly bounds = new Map<string, Set<PendingDeviceCleanupBound>>();
  /** Capped teardown promises retain the shield's deadline when transferred to device cleanup. */
  private readonly teardownBounds = new WeakMap<Promise<void>, number>();
  /**
   * Work started by the device's current acquisition (owner-less recording stop, #11041). It never
   * blocks the live holder, but counts as cleanup once the device has no owner again.
   */
  private readonly acquisition = new Map<string, Promise<void>>();
  private readonly acquisitionBounds = new Map<string, Set<PendingDeviceCleanupBound>>();

  constructor(private readonly host: DeviceCleanupQuarantineHost) {}

  /** Return outstanding post-release device work, if the device must stay quarantined. */
  get(deviceId: string, ownGate?: Promise<void>): Promise<void> | null {
    if (ownGate) {
      const work = Array.from(this.work.get(deviceId) ?? []).filter(
        (cleanup) => cleanup !== ownGate,
      );
      return work.length > 0 ? Promise.allSettled(work).then(() => undefined) : null;
    }
    return this.pending.get(deviceId) ?? null;
  }

  /** Whether acquisition-triggered work is running (it only counts once the device has no owner). */
  hasAcquisitionWork(deviceId: string): boolean {
    return this.acquisition.has(deviceId);
  }

  /** Wait for the device work that outlived release, without blocking shutdown indefinitely. */
  async drain(timeoutMs: number): Promise<boolean> {
    const cleanups = [...this.pending.values(), ...this.acquisition.values()];
    if (cleanups.length === 0) {
      return true;
    }
    const timedOut = Symbol("device cleanup drain timeout");
    try {
      await raceWithDeadline(Promise.allSettled(cleanups), {
        timer: this.host.timer,
        timeoutMs,
        label: "Device cleanup drain",
        timeoutError: () => timedOut,
      });
      return true;
    } catch (error) {
      if (error !== timedOut) {
        throw toActionableError(error, "Failed to drain pending device cleanups");
      }
      logger.warn(`Timed out after ${timeoutMs}ms draining pending device cleanups`);
      return false;
    }
  }

  /** Register externally-dispatched work; `bound` is a trusted cap or a manager-capped descriptor. */
  register(
    deviceId: string,
    cleanup: Promise<unknown>,
    /** Numeric caps are trusted; only listener descriptors are manager-capped. */
    bound?: number | AbandonablePendingDeviceCleanup,
  ): void {
    if (bound === undefined) {
      this.track(deviceId, [cleanup]);
      return;
    }
    const record: PendingDeviceCleanupBound = {};
    if (typeof bound === "number") {
      record.settlesBy = this.host.now() + bound;
    } else {
      cleanup = this.cap(deviceId, cleanup, record, bound);
    }
    this.trackBound(this.bounds, deviceId, cleanup, record);
    this.track(deviceId, [cleanup]);
    this.armCaps(deviceId);
  }

  /** Work the current acquirer triggered on its own device; see {@link hasAcquisitionWork}. */
  registerAcquisition(
    deviceId: string,
    cleanup: Promise<unknown>,
    /** The cleanup's own cap, when it has one: it bounds the retry hint a refused bind gets. */
    capMs?: number,
  ): void {
    if (capMs !== undefined) {
      this.trackBound(this.acquisitionBounds, deviceId, cleanup, {
        settlesBy: this.host.now() + capMs,
      });
    }
    const tracked = Promise.allSettled([cleanup]).then(() => undefined);
    const previous = this.acquisition.get(deviceId);
    const combined = previous
      ? Promise.allSettled([previous, tracked]).then(() => undefined)
      : tracked;
    this.acquisition.set(deviceId, combined);
    void combined.then(() => {
      if (this.acquisition.get(deviceId) === combined) {
        this.acquisition.delete(deviceId);
      }
    });
  }

  /** Record the deadline of a capped teardown promise so it survives the transfer to quarantine. */
  noteTeardownBound(teardown: Promise<void>, settlesBy: number): void {
    this.teardownBounds.set(teardown, settlesBy);
  }

  /** Quarantine capped teardown promises, keeping each one's recorded deadline. */
  trackTeardown(deviceId: string, cleanups: readonly Promise<void>[]): void {
    for (const cleanup of cleanups) {
      const settlesBy = this.teardownBounds.get(cleanup);
      if (settlesBy !== undefined) {
        this.trackBound(this.bounds, deviceId, cleanup, { settlesBy });
      }
    }
    this.track(deviceId, cleanups);
  }

  /** Quarantine already-running work with no bound of its own. */
  track(deviceId: string, cleanups: readonly Promise<unknown>[]): void {
    const work = this.work.get(deviceId) ?? new Set<Promise<unknown>>();
    this.work.set(deviceId, work);
    for (const promise of cleanups) {
      work.add(promise);
      const remove = () => {
        work.delete(promise);
        if (work.size === 0 && this.work.get(deviceId) === work) {
          this.work.delete(deviceId);
        }
      };
      void promise.then(remove, remove);
    }
    const previous = this.pending.get(deviceId);
    const cleanup = Promise.allSettled(previous ? [previous, ...cleanups] : cleanups).then(
      () => undefined,
    );
    this.pending.set(deviceId, cleanup);
    void cleanup.then(() => {
      if (this.pending.get(deviceId) === cleanup) {
        this.pending.delete(deviceId);
      }
    });
  }

  /** Start the caps of listener cleanup once the device has no owner. */
  armCaps(deviceId: string): void {
    if (this.host.hasOwner(deviceId)) {
      return;
    }
    for (const record of this.bounds.get(deviceId) ?? []) {
      record.start?.();
    }
  }

  /**
   * How long a refused bind should wait before retrying (#10960): the longest remaining bound among
   * the caller's in-flight release bounds (absolute times) and this device's cleanup caps, or the
   * default polling hint when nothing bounds it. An acquisition cleanup counts once its holder is
   * gone (#11616).
   */
  retryAfterMs(deviceId: string, releaseBounds: readonly number[]): number {
    const now = this.host.now();
    const bounds = [...releaseBounds];
    for (const record of this.bounds.get(deviceId) ?? []) {
      if (record.start) {
        bounds.push(now + this.host.teardownCapMs);
      } else if (record.settlesBy !== undefined) {
        bounds.push(record.settlesBy);
      }
    }
    if (!this.host.hasOwner(deviceId)) {
      for (const record of this.acquisitionBounds.get(deviceId) ?? []) {
        if (record.settlesBy !== undefined) {
          bounds.push(record.settlesBy);
        }
      }
    }
    const remaining = Math.max(0, ...bounds.map((bound) => bound - now));
    return remaining > 0 ? remaining : this.host.defaultRetryAfterMs;
  }

  /** Number of unsettled quarantined promises for a device (diagnostics and tests). */
  workCount(deviceId: string): number {
    return this.work.get(deviceId)?.size ?? 0;
  }

  /** Number of live bound records for a device (diagnostics and tests). */
  boundCount(deviceId: string): number {
    return this.bounds.get(deviceId)?.size ?? 0;
  }

  private trackBound(
    registry: Map<string, Set<PendingDeviceCleanupBound>>,
    deviceId: string,
    cleanup: Promise<unknown>,
    record: PendingDeviceCleanupBound,
  ): void {
    const records = registry.get(deviceId) ?? new Set<PendingDeviceCleanupBound>();
    registry.set(deviceId, records);
    records.add(record);
    const remove = () => {
      records.delete(record);
      if (records.size === 0 && registry.get(deviceId) === records) {
        registry.delete(deviceId);
      }
    };
    void cleanup.then(remove, remove);
  }

  private cap(
    deviceId: string,
    cleanup: Promise<unknown>,
    record: PendingDeviceCleanupBound,
    descriptor: AbandonablePendingDeviceCleanup,
  ): Promise<void> {
    const capMs = this.host.teardownCapMs;
    const tracked = Promise.withResolvers<void>();
    let settled = false;
    const settle = () => {
      settled = true;
      record.start = undefined;
      tracked.resolve();
    };
    // Both outcomes retire work; late failure after abandonment is already observed here.
    void cleanup.then(settle, settle);
    record.start = () => {
      record.start = undefined;
      if (settled) {
        return;
      }
      record.settlesBy = this.host.now() + capMs;
      void raceWithDeadline(cleanup, {
        timer: this.host.timer,
        timeoutMs: capMs,
        unref: true,
        label: descriptor.name,
        onTimeout: () => {
          try {
            descriptor.abandon?.();
          } catch (error) {
            logger.warn(
              `Failed to abandon ${descriptor.name} for ${deviceId}: ${errorMessage(error)}`,
              error,
            );
          }
          logger.warn(
            `Abandoned ${descriptor.name} for ${deviceId} after ${capMs}ms; ` +
              `the device is no longer held for it and may still carry ${descriptor.leftover}`,
          );
        },
      }).then(settle, (error: unknown) => {
        // The capped wait and raw rejection are observed; abandonment already named any leftover.
        logger.debug(`Device cleanup wait ended for ${deviceId}: ${errorMessage(error)}`);
        settle();
      });
    };
    return tracked.promise;
  }
}
