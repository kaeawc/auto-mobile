import type { Timer } from "../../../utils/SystemTimer";
import { defaultTimer } from "../../../utils/SystemTimer";

/**
 * TTL for cached per-device screenshot state. Mirrors
 * `RealObserveScreen.OBSERVE_RESULT_CACHE_TTL_MS` so reads of the most-recent
 * screenshot state stay aligned with the observe result cache.
 */
export const OBSERVE_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;

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
  getPath(deviceId?: string): string | undefined;
  getError(deviceId?: string): string | undefined;
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

  getPath(deviceId?: string): string | undefined {
    const state = this.findLatest(deviceId);
    return state?.path ?? undefined;
  }

  getError(deviceId?: string): string | undefined {
    const state = this.findLatest(deviceId);
    return state?.error ?? undefined;
  }

  clear(deviceId?: string): void {
    if (deviceId) {
      this.states.delete(deviceId);
    } else {
      this.states.clear();
    }
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
