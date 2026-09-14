/**
 * Orders installed-app cache writes per device and fences rebuilds that began
 * before a package mutation. The shutdown barrier tracks write lifetime; this
 * coordinator preserves cache coherence between otherwise concurrent readers
 * and mutations.
 *
 * Two tokens, two concerns (#6894):
 * - A *generation* fences one rebuild against invalidations: it moves on every
 *   invalidation and a rebuild only commits against the generation it began
 *   under.
 * - An *incarnation* identifies one lifetime of a device id. It moves only
 *   when the id is retired (shutdown / pool removal) and a later request
 *   starts a fresh one. Requests capture it before any await, so work that
 *   belongs to a retired device is rejected instead of being promoted onto a
 *   reused id, and a release binds to the incarnation it was captured for so
 *   a late release cannot discard a replacement's bookkeeping.
 */
import { type DbWriteBarrier, getDbWriteBarrier } from "./dbWriteBarrier";

export interface InstalledAppsCacheWriteCoordinator {
  /**
   * Captures the incarnation a request starts under. Call it BEFORE the
   * request's first await (device discovery included) and pass the token to
   * {@link beginRebuild}: a request that resumes after its incarnation was
   * retired is then refused a committable generation.
   */
  captureIncarnation(deviceId: string): number;
  /**
   * Returns the generation a rebuild must commit against, or `undefined` when
   * `incarnation` is no longer the device's live incarnation. Without an
   * incarnation the live one is used (started fresh when none exists or the
   * previous one was retired).
   */
  beginRebuild(deviceId: string): number;
  beginRebuild(deviceId: string, incarnation: number): number | undefined;
  commitRebuild(deviceId: string, generation: number, write: () => Promise<void>): Promise<boolean>;
  isDirty(deviceId: string): boolean;
  markRebuilt(deviceId: string, generation: number): boolean;
  invalidateWithoutWrite(deviceId: string): number;
  invalidate(deviceId: string, write: () => Promise<void>): Promise<void>;
  /**
   * Synchronously retires the live incarnation: fences its generation so
   * nothing captured under it can commit, and makes the next request on the
   * id start a fresh incarnation. Returns the retired incarnation so the
   * caller can bind a later {@link releaseDevice} to it, captured before any
   * window in which the id may be reused.
   */
  retireIncarnation(deviceId: string): number;
  /**
   * Permanently forgets a device incarnation once the caller is certain it is
   * gone (e.g. after pool removal's final `invalidate()` has drained). Retires
   * the incarnation if the caller has not already, drains the device's write
   * tail, then deletes the per-device bookkeeping only if no newer incarnation
   * started on the id meanwhile. With `incarnation` the release is a no-op
   * unless that incarnation is still the one on record, so a late release can
   * never discard a replacement's fences. Safe to call from a hot path that
   * reuses device ids: a reused id simply starts clean.
   */
  releaseDevice(deviceId: string, incarnation?: number): Promise<void>;
}

interface DeviceState {
  incarnation: number;
  generation: number;
  /** Set while a failed stale-marker write leaves old DB rows physically fresh. */
  dirtyGeneration?: number;
  retired: boolean;
}

export class PerDeviceInstalledAppsCacheWriteCoordinator implements InstalledAppsCacheWriteCoordinator {
  private states = new Map<string, DeviceState>();
  private tails = new Map<string, Promise<unknown>>();
  private nextGeneration = 0;
  private nextIncarnation = 0;

  constructor(private readonly getBarrier: () => DbWriteBarrier = getDbWriteBarrier) {}

  captureIncarnation(deviceId: string): number {
    return this.liveState(deviceId).incarnation;
  }

  beginRebuild(deviceId: string): number;
  beginRebuild(deviceId: string, incarnation: number): number | undefined;
  beginRebuild(deviceId: string, incarnation?: number): number | undefined {
    if (incarnation === undefined) {
      return this.liveState(deviceId).generation;
    }
    const state = this.states.get(deviceId);
    if (!state || state.retired || state.incarnation !== incarnation) {
      return undefined;
    }
    return state.generation;
  }

  isDirty(deviceId: string): boolean {
    return this.states.get(deviceId)?.dirtyGeneration !== undefined;
  }

  markRebuilt(deviceId: string, generation: number): boolean {
    const state = this.states.get(deviceId);
    if (state?.generation !== generation) {
      return false;
    }
    delete state.dirtyGeneration;
    return true;
  }

  async commitRebuild(
    deviceId: string,
    generation: number,
    write: () => Promise<void>,
  ): Promise<boolean> {
    return this.enqueue(deviceId, async () => {
      if (this.states.get(deviceId)?.generation !== generation) {
        return false;
      }
      await write();
      return true;
    });
  }

  async invalidate(deviceId: string, write: () => Promise<void>): Promise<void> {
    this.invalidateWithoutWrite(deviceId);
    try {
      await this.enqueue(deviceId, write);
    } finally {
      // A rebuild can begin after the first fence but before the DB stale-marker
      // commits. Bump again once that write settles so it cannot publish a
      // snapshot read from the old rows while it was in flight.
      this.invalidateWithoutWrite(deviceId);
    }
  }

  invalidateWithoutWrite(deviceId: string): number {
    // An invalidation is a fence, not a birth: on a retired incarnation it
    // lands on the retired state (a shutdown's own post-notification
    // re-invalidation must not start a phantom incarnation that leaks).
    const state = this.states.get(deviceId) ?? this.startIncarnation(deviceId, undefined);
    state.generation = ++this.nextGeneration;
    // A failed stale-marker write leaves old DB rows physically fresh. Keep the
    // cache bypassed until ListInstalledApps successfully commits a replacement.
    state.dirtyGeneration = state.generation;
    return state.generation;
  }

  retireIncarnation(deviceId: string): number {
    // Idempotent: a teardown retry re-fences the incarnation it already
    // retired rather than minting a phantom one just to retire it.
    const state = this.states.get(deviceId) ?? this.startIncarnation(deviceId, undefined);
    // Fence: bump the generation so a rebuild that already captured an older
    // one cannot later commit against this id even if it is reused.
    state.generation = ++this.nextGeneration;
    state.retired = true;
    return state.incarnation;
  }

  async releaseDevice(deviceId: string, incarnation?: number): Promise<void> {
    const state = this.states.get(deviceId);
    if (!state || (incarnation !== undefined && state.incarnation !== incarnation)) {
      return;
    }
    if (!state.retired) {
      this.retireIncarnation(deviceId);
    }

    // Drain: wait behind any write already queued for this device (including
    // the final invalidate() write this call is expected to follow) before
    // treating the device as idle.
    await this.enqueue(deviceId, async () => undefined);

    // Delete only if no newer incarnation started on the id while this call
    // was waiting on the tail above (a reused id that was rebuilt or
    // invalidated meanwhile). Leaving the entry in that case keeps the
    // replacement's fences instead of resetting them.
    if (this.states.get(deviceId) === state) {
      this.states.delete(deviceId);
    }
  }

  /**
   * Test-only diagnostic: number of device identifiers with any retained
   * bookkeeping (state or in-flight tail). Not part of the
   * {@link InstalledAppsCacheWriteCoordinator} interface — production callers
   * have no use for it.
   */
  trackedDeviceCount(): number {
    return new Set<string>([...this.states.keys(), ...this.tails.keys()]).size;
  }

  /** The live (non-retired) state for an id, starting a fresh incarnation when needed. */
  private liveState(deviceId: string): DeviceState {
    const state = this.states.get(deviceId);
    if (state && !state.retired) {
      return state;
    }
    return this.startIncarnation(deviceId, state);
  }

  private startIncarnation(deviceId: string, retired: DeviceState | undefined): DeviceState {
    const state: DeviceState = {
      incarnation: ++this.nextIncarnation,
      generation: ++this.nextGeneration,
      retired: false,
    };
    // A dirty fence only ever clears through markRebuilt() or a release of its
    // own incarnation: rows a retired incarnation failed to mark stale must
    // keep the cache bypassed for whoever reuses the id.
    if (retired?.dirtyGeneration !== undefined) {
      state.dirtyGeneration = state.generation;
    }
    this.states.set(deviceId, state);
    return state;
  }

  private async enqueue<T>(deviceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(deviceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    // Register the whole queued lifetime before shutdown can start draining.
    // Individual DB writes may still use track() to skip after draining begins;
    // this makes a write already waiting behind a same-device predecessor
    // visible to drain.
    void this.getBarrier().trackExisting(next);
    this.tails.set(deviceId, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(deviceId) === next) {
        this.tails.delete(deviceId);
      }
    }
  }
}

const sharedInstalledAppsCacheWriteCoordinator = new PerDeviceInstalledAppsCacheWriteCoordinator();

export function getInstalledAppsCacheWriteCoordinator(): InstalledAppsCacheWriteCoordinator {
  return sharedInstalledAppsCacheWriteCoordinator;
}
