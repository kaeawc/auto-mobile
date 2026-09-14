import type { Timer } from "../../../utils/SystemTimer";
import { defaultTimer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";

/**
 * TTL for cached per-device screenshot state. Mirrors
 * `RealObserveScreen.OBSERVE_RESULT_CACHE_TTL_MS` so reads of the most-recent
 * screenshot state stay aligned with the observe result cache.
 */
export const OBSERVE_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_OBSERVATION_SCREENSHOT_STATES_PER_DEVICE = 10;
/**
 * Backstop on cleared-observation tombstones per device. Only observations
 * still pending at clear time are tombstoned, and each tombstone retires after
 * `OBSERVE_RESULT_CACHE_TTL_MS`, so this cap is only reached by pathological
 * clear storms; insertion-order eviction keeps the newest fences.
 */
export const MAX_CLEARED_OBSERVATION_TOMBSTONES_PER_DEVICE = 64;

interface ScreenshotState {
  path: string | null;
  error: string | null;
  timestamp: number;
}

/**
 * Read/write API for the most recent screenshot path/error per device.
 *
 * Behaviour notes:
 * - `update` writes the latest path/error and bumps the timestamp.
 * - `getPath` / `getError` accept an optional device id; when omitted they
 *   return data from the most-recently-updated device across all known
 *   devices. Expired entries are evicted on read.
 * - `clear` evicts a single device when an id is provided, or all devices
 *   when called without arguments.
 */
export interface ScreenshotStateStore {
  update(deviceId: string, path?: string, error?: string): void;
  updateForObservation(
    deviceId: string,
    observationId: string,
    path?: string,
    error?: string,
  ): void;
  /** Register a screenshot write that will later be committed for this observation. */
  beginObservation(deviceId: string, observationId: string): void;
  /** Wait for this observation's registered screenshot write, or its timeout. */
  waitForObservation(deviceId: string, observationId: string, timeoutMs: number): Promise<void>;
  /** Whether this observation still has a registered screenshot write in flight. */
  isObservationPending(deviceId: string, observationId: string): boolean;
  /** Record terminal cancellation evidence without replacing an existing result. */
  endObservation(deviceId: string, observationId: string, reason: string): void;
  getPath(deviceId?: string): string | undefined;
  getError(deviceId?: string): string | undefined;
  getPathForObservation(deviceId: string, observationId: string): string | undefined;
  getErrorForObservation(deviceId: string, observationId: string): string | undefined;
  clear(deviceId?: string): void;
}

/**
 * In-memory implementation backed by a `Map<deviceId, ScreenshotState>`.
 *
 * Time is injected via a `Timer` so tests can use `FakeTimer` for TTL
 * exercises. The default uses `defaultTimer` (wall clock) for production use.
 */
export class InMemoryScreenshotStateStore implements ScreenshotStateStore {
  private states: Map<string, ScreenshotState> = new Map();
  private observationStates: Map<string, Map<string, ScreenshotState>> = new Map();
  private pendingObservationWaiters: Map<string, Map<string, Set<() => void>>> = new Map();
  /**
   * Observation IDs that were still pending when their device state was
   * explicitly cleared, keyed to the clear timestamp. A pending capture may
   * still issue late callbacks (`updateForObservation` / `endObservation`,
   * possibly more than one per job) that must not recreate cleared state;
   * completed observations cannot call back, so they are never tombstoned.
   * Tombstones retire after `OBSERVE_RESULT_CACHE_TTL_MS`, are consumed by a
   * `beginObservation` that reuses the id, and are capped per device.
   */
  private clearedObservationIds: Map<string, Map<string, number>> = new Map();
  private timer: Timer;

  constructor(timer: Timer = defaultTimer) {
    this.timer = timer;
  }

  update(deviceId: string, path?: string, error?: string): void {
    this.states.set(deviceId, {
      path: path ?? null,
      error: error ?? null,
      timestamp: this.timer.now(),
    });
  }

  updateForObservation(
    deviceId: string,
    observationId: string,
    path?: string,
    error?: string,
  ): void {
    if (this.isClearedObservation(deviceId, observationId)) {
      logger.debug(
        `[OBSERVE] Ignoring late screenshot update for cleared observation ${observationId} on ${deviceId}`,
      );
      return;
    }
    const states = this.observationStates.get(deviceId) ?? new Map<string, ScreenshotState>();
    states.delete(observationId);
    states.set(observationId, {
      path: path ?? null,
      error: error ?? null,
      timestamp: this.timer.now(),
    });
    while (states.size > MAX_OBSERVATION_SCREENSHOT_STATES_PER_DEVICE) {
      const oldestObservationId = states.keys().next().value;
      if (oldestObservationId === undefined) {
        break;
      }
      states.delete(oldestObservationId);
    }
    this.observationStates.set(deviceId, states);
    this.completeObservation(deviceId, observationId);
  }

  beginObservation(deviceId: string, observationId: string): void {
    this.clearObservationTombstone(deviceId, observationId);
    const pendingForDevice = this.pendingObservationWaiters.get(deviceId);
    if (pendingForDevice?.has(observationId)) {
      return;
    }
    const pending = pendingForDevice ?? new Map<string, Set<() => void>>();
    pending.set(observationId, new Set());
    this.pendingObservationWaiters.set(deviceId, pending);
  }

  waitForObservation(deviceId: string, observationId: string, timeoutMs: number): Promise<void> {
    const waiters = this.pendingObservationWaiters.get(deviceId)?.get(observationId);
    if (!waiters) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const timeout: { id?: NodeJS.Timeout } = {};
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        waiters.delete(finish);
        if (timeout.id) {
          this.timer.clearTimeout(timeout.id);
        }
        resolve();
      };
      timeout.id = this.timer.setTimeout(finish, timeoutMs);
      waiters.add(finish);
    });
  }

  isObservationPending(deviceId: string, observationId: string): boolean {
    return this.pendingObservationWaiters.get(deviceId)?.has(observationId) ?? false;
  }

  endObservation(deviceId: string, observationId: string, reason: string): void {
    if (this.isClearedObservation(deviceId, observationId)) {
      logger.debug(
        `[OBSERVE] Ignoring late screenshot completion for cleared observation ${observationId} on ${deviceId}`,
      );
      return;
    }
    const existing = this.findObservation(deviceId, observationId);
    // A late cancellation must not replace a real path or error recorded by another capture.
    if (!existing || (existing.path === null && existing.error === null)) {
      this.updateForObservation(deviceId, observationId, undefined, reason);
      return;
    }
    this.completeObservation(deviceId, observationId);
  }

  getPath(deviceId?: string): string | undefined {
    const state = this.findLatest(deviceId);
    return state?.path ?? undefined;
  }

  getError(deviceId?: string): string | undefined {
    const state = this.findLatest(deviceId);
    return state?.error ?? undefined;
  }

  getPathForObservation(deviceId: string, observationId: string): string | undefined {
    return this.findObservation(deviceId, observationId)?.path ?? undefined;
  }

  getErrorForObservation(deviceId: string, observationId: string): string | undefined {
    return this.findObservation(deviceId, observationId)?.error ?? undefined;
  }

  clear(deviceId?: string): void {
    if (deviceId) {
      this.markPendingObservationsCleared(deviceId);
      this.states.delete(deviceId);
      this.observationStates.delete(deviceId);
      this.completeAllObservationsForDevice(deviceId);
    } else {
      this.states.clear();
      this.observationStates.clear();
      for (const pendingDeviceId of [...this.pendingObservationWaiters.keys()]) {
        this.markPendingObservationsCleared(pendingDeviceId);
        this.completeAllObservationsForDevice(pendingDeviceId);
      }
    }
  }

  /** Number of live (unexpired) cleared-observation tombstones for a device. */
  clearedObservationCount(deviceId: string): number {
    const clearedForDevice = this.clearedObservationIds.get(deviceId);
    if (!clearedForDevice) {
      return 0;
    }
    this.retireExpiredTombstones(deviceId, clearedForDevice);
    return clearedForDevice.size;
  }

  private findLatest(deviceId?: string): { path: string | null; error: string | null } | null {
    const now = this.timer.now();

    if (deviceId) {
      const state = this.states.get(deviceId);
      if (!state) {
        return null;
      }
      if (now - state.timestamp > OBSERVE_RESULT_CACHE_TTL_MS) {
        this.states.delete(deviceId);
        return null;
      }
      return { path: state.path, error: state.error };
    }

    // Find most recent across all devices, evicting expired entries along the way.
    let mostRecent: ScreenshotState | null = null;
    for (const [id, state] of this.states.entries()) {
      if (now - state.timestamp > OBSERVE_RESULT_CACHE_TTL_MS) {
        this.states.delete(id);
        continue;
      }
      if (!mostRecent || state.timestamp > mostRecent.timestamp) {
        mostRecent = state;
      }
    }

    if (!mostRecent) {
      return null;
    }
    return { path: mostRecent.path, error: mostRecent.error };
  }

  private findObservation(deviceId: string, observationId: string): ScreenshotState | undefined {
    const states = this.observationStates.get(deviceId);
    const state = states?.get(observationId);
    if (!state) {
      return undefined;
    }
    if (this.timer.now() - state.timestamp > OBSERVE_RESULT_CACHE_TTL_MS) {
      states?.delete(observationId);
      if (states?.size === 0) {
        this.observationStates.delete(deviceId);
      }
      return undefined;
    }
    return state;
  }

  private completeObservation(deviceId: string, observationId: string): void {
    const pendingForDevice = this.pendingObservationWaiters.get(deviceId);
    const waiters = pendingForDevice?.get(observationId);
    if (!waiters) {
      return;
    }
    pendingForDevice?.delete(observationId);
    if (pendingForDevice?.size === 0) {
      this.pendingObservationWaiters.delete(deviceId);
    }
    for (const resolve of waiters) {
      resolve();
    }
  }

  private isClearedObservation(deviceId: string, observationId: string): boolean {
    const clearedForDevice = this.clearedObservationIds.get(deviceId);
    const clearedAt = clearedForDevice?.get(observationId);
    if (clearedForDevice === undefined || clearedAt === undefined) {
      return false;
    }
    if (this.timer.now() - clearedAt > OBSERVE_RESULT_CACHE_TTL_MS) {
      // A capture job cannot call back this late; the fence has done its job.
      this.clearObservationTombstone(deviceId, observationId);
      return false;
    }
    return true;
  }

  private clearObservationTombstone(deviceId: string, observationId: string): void {
    const clearedForDevice = this.clearedObservationIds.get(deviceId);
    if (!clearedForDevice) {
      return;
    }
    clearedForDevice.delete(observationId);
    if (clearedForDevice.size === 0) {
      this.clearedObservationIds.delete(deviceId);
    }
  }

  private markPendingObservationsCleared(deviceId: string): void {
    const pendingObservationIds = this.pendingObservationWaiters.get(deviceId)?.keys() ?? [];
    const clearedForDevice = this.clearedObservationIds.get(deviceId) ?? new Map<string, number>();
    this.retireExpiredTombstones(deviceId, clearedForDevice);
    const now = this.timer.now();
    for (const observationId of pendingObservationIds) {
      // Re-insert so a re-cleared id moves to the newest end of the eviction order.
      clearedForDevice.delete(observationId);
      clearedForDevice.set(observationId, now);
    }
    while (clearedForDevice.size > MAX_CLEARED_OBSERVATION_TOMBSTONES_PER_DEVICE) {
      const oldestObservationId = clearedForDevice.keys().next().value;
      if (oldestObservationId === undefined) {
        break;
      }
      clearedForDevice.delete(oldestObservationId);
    }
    if (clearedForDevice.size === 0) {
      this.clearedObservationIds.delete(deviceId);
      return;
    }
    this.clearedObservationIds.set(deviceId, clearedForDevice);
  }

  private retireExpiredTombstones(deviceId: string, clearedForDevice: Map<string, number>): void {
    const now = this.timer.now();
    for (const [observationId, clearedAt] of [...clearedForDevice.entries()]) {
      if (now - clearedAt > OBSERVE_RESULT_CACHE_TTL_MS) {
        clearedForDevice.delete(observationId);
      }
    }
    if (clearedForDevice.size === 0) {
      this.clearedObservationIds.delete(deviceId);
    }
  }

  private completeAllObservationsForDevice(deviceId: string): void {
    const pendingForDevice = this.pendingObservationWaiters.get(deviceId);
    if (!pendingForDevice) {
      return;
    }
    for (const observationId of [...pendingForDevice.keys()]) {
      this.completeObservation(deviceId, observationId);
    }
  }
}

let instance: ScreenshotStateStore = new InMemoryScreenshotStateStore();

/**
 * Get the process-wide screenshot state store. Server resource handlers and
 * the observe recorder share this instance so reads remain coherent without
 * passing the store through every call site.
 */
export function getScreenshotStateStore(): ScreenshotStateStore {
  return instance;
}

/**
 * Replace the active screenshot state store. Tests should call this to swap
 * in a `FakeScreenshotStateStore` and remember to call
 * `resetScreenshotStateStore` in their teardown.
 */
export function setScreenshotStateStore(store: ScreenshotStateStore): void {
  instance = store;
}

/**
 * Reset to a fresh `InMemoryScreenshotStateStore` backed by `defaultTimer`.
 */
export function resetScreenshotStateStore(): void {
  instance = new InMemoryScreenshotStateStore();
}
