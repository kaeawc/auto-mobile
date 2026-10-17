import {
  MAX_OBSERVATION_SCREENSHOT_STATES_PER_DEVICE,
  OBSERVE_RESULT_CACHE_TTL_MS,
  type ScreenshotStateStore,
} from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import type { Timer } from "../../src/utils/SystemTimer";

interface FakeScreenshotState {
  imageSize?: { width: number; height: number };
  path: string | null;
  error: string | null;
  timestamp: number;
}

/**
 * Test fake for `ScreenshotStateStore`, held to the same behavioural contract as the
 * production store (test/contracts/ScreenshotStateStoreContract.ts): timestamps come from the
 * injected timer, state expires after the cache TTL, observation state is capped per device,
 * and writes for an observation that was pending when its device was cleared are ignored.
 * `setNow` overrides the timer for tests that script timestamps directly.
 */
export class FakeScreenshotStateStore implements ScreenshotStateStore {
  private states: Map<string, FakeScreenshotState> = new Map();
  private observationStates: Map<string, Map<string, FakeScreenshotState>> = new Map();
  private pendingObservations: Set<string> = new Set();
  private pendingObservationWaiters: Map<string, Set<() => void>> = new Map();
  private clearedObservations: Map<string, number> = new Map();
  private nowOverride: number | undefined;

  constructor(private readonly timer: Timer) {}

  setNow(time: number): void {
    this.nowOverride = time;
  }

  private now(): number {
    return this.nowOverride ?? this.timer.now();
  }

  update(deviceId: string, path?: string, error?: string): void {
    this.states.set(deviceId, {
      path: path ?? null,
      error: error ?? null,
      timestamp: this.now(),
    });
  }

  updateForObservation(
    deviceId: string,
    observationId: string,
    path?: string,
    error?: string,
    imageSize?: { width: number; height: number },
  ): void {
    if (this.isCleared(deviceId, observationId)) {
      return;
    }
    const states = this.observationStates.get(deviceId) ?? new Map<string, FakeScreenshotState>();
    states.delete(observationId);
    states.set(observationId, {
      path: path ?? null,
      error: error ?? null,
      ...(imageSize ? { imageSize } : {}),
      timestamp: this.now(),
    });
    while (states.size > MAX_OBSERVATION_SCREENSHOT_STATES_PER_DEVICE) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      states.delete(oldest);
    }
    this.observationStates.set(deviceId, states);
    this.completeObservation(deviceId, observationId);
  }

  beginObservation(deviceId: string, observationId: string): void {
    this.clearedObservations.delete(this.observationKey(deviceId, observationId));
    this.pendingObservations.add(this.observationKey(deviceId, observationId));
  }

  waitForObservation(deviceId: string, observationId: string, timeoutMs: number): Promise<void> {
    const key = this.observationKey(deviceId, observationId);
    if (!this.pendingObservations.has(key)) {
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
        this.pendingObservationWaiters.get(key)?.delete(finish);
        if (timeout.id) {
          this.timer.clearTimeout(timeout.id);
        }
        resolve();
      };
      const waiters = this.pendingObservationWaiters.get(key) ?? new Set<() => void>();
      waiters.add(finish);
      this.pendingObservationWaiters.set(key, waiters);
      timeout.id = this.timer.setTimeout(finish, timeoutMs);
    });
  }

  isObservationPending(deviceId: string, observationId: string): boolean {
    return this.pendingObservations.has(this.observationKey(deviceId, observationId));
  }

  endObservation(deviceId: string, observationId: string, reason: string): void {
    if (this.isCleared(deviceId, observationId)) {
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

  getImageSizeForObservation(deviceId: string, observationId: string, path: string) {
    const state = this.findObservation(deviceId, observationId);
    return state?.path === path ? state.imageSize : undefined;
  }

  getErrorForObservation(deviceId: string, observationId: string): string | undefined {
    return this.findObservation(deviceId, observationId)?.error ?? undefined;
  }

  getReferencedScreenshotPaths(): readonly string[] {
    const paths = new Set<string>();
    for (const [deviceId, state] of this.states.entries()) {
      if (this.now() - state.timestamp > OBSERVE_RESULT_CACHE_TTL_MS) {
        this.states.delete(deviceId);
      } else if (state.path) {
        paths.add(state.path);
      }
    }
    for (const [deviceId, states] of this.observationStates.entries()) {
      for (const [observationId, state] of states.entries()) {
        if (this.now() - state.timestamp > OBSERVE_RESULT_CACHE_TTL_MS) {
          states.delete(observationId);
        } else if (state.path) {
          paths.add(state.path);
        }
      }
      if (states.size === 0) {
        this.observationStates.delete(deviceId);
      }
    }
    return [...paths];
  }

  clear(deviceId?: string): void {
    for (const key of this.pendingObservations) {
      if (!deviceId || key.startsWith(`${deviceId}\u0000`)) {
        this.clearedObservations.set(key, this.now());
      }
    }
    if (deviceId) {
      this.states.delete(deviceId);
      this.observationStates.delete(deviceId);
      for (const key of [...this.pendingObservations]) {
        if (key.startsWith(`${deviceId}\u0000`)) {
          const [, observationId] = key.split("\u0000");
          this.completeObservation(deviceId, observationId);
        }
      }
    } else {
      this.states.clear();
      this.observationStates.clear();
      for (const key of [...this.pendingObservations]) {
        const [pendingDeviceId, observationId] = key.split("\u0000");
        this.completeObservation(pendingDeviceId, observationId);
      }
    }
  }

  // Test helpers

  getStateForDevice(deviceId: string): FakeScreenshotState | undefined {
    const state = this.states.get(deviceId);
    return state ? { ...state } : undefined;
  }

  getAllDeviceIds(): string[] {
    return Array.from(this.states.keys());
  }

  getUpdateCount(): number {
    return this.states.size;
  }

  hasPendingObservation(deviceId: string, observationId: string): boolean {
    return this.pendingObservations.has(this.observationKey(deviceId, observationId));
  }

  private observationKey(deviceId: string, observationId: string): string {
    return `${deviceId}\u0000${observationId}`;
  }

  private completeObservation(deviceId: string, observationId: string): void {
    const key = this.observationKey(deviceId, observationId);
    this.pendingObservations.delete(key);
    const waiters = this.pendingObservationWaiters.get(key);
    this.pendingObservationWaiters.delete(key);
    waiters?.forEach((resolve) => resolve());
  }

  private isExpired(state: FakeScreenshotState): boolean {
    return this.now() - state.timestamp > OBSERVE_RESULT_CACHE_TTL_MS;
  }

  private isCleared(deviceId: string, observationId: string): boolean {
    const key = this.observationKey(deviceId, observationId);
    const clearedAt = this.clearedObservations.get(key);
    if (clearedAt === undefined) {
      return false;
    }
    if (this.now() - clearedAt > OBSERVE_RESULT_CACHE_TTL_MS) {
      this.clearedObservations.delete(key);
      return false;
    }
    return true;
  }

  private findObservation(
    deviceId: string,
    observationId: string,
  ): FakeScreenshotState | undefined {
    const states = this.observationStates.get(deviceId);
    const state = states?.get(observationId);
    if (!state) {
      return undefined;
    }
    if (this.isExpired(state)) {
      states?.delete(observationId);
      if (states?.size === 0) {
        this.observationStates.delete(deviceId);
      }
      return undefined;
    }
    return state;
  }

  private findLatest(deviceId?: string): FakeScreenshotState | undefined {
    if (deviceId) {
      const state = this.states.get(deviceId);
      if (state && this.isExpired(state)) {
        this.states.delete(deviceId);
        return undefined;
      }
      return state;
    }
    let mostRecent: FakeScreenshotState | undefined;
    for (const [id, state] of [...this.states.entries()]) {
      if (this.isExpired(state)) {
        this.states.delete(id);
        continue;
      }
      if (!mostRecent || state.timestamp > mostRecent.timestamp) {
        mostRecent = state;
      }
    }
    return mostRecent;
  }
}
