import type { ScreenshotStateStore } from "../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";

interface FakeScreenshotState {
  path: string | null;
  error: string | null;
  timestamp: number;
}

/**
 * Test fake for `ScreenshotStateStore`. Backed by a plain `Map`; no TTL
 * eviction so tests have full control. Use `setNow` to control the timestamp
 * recorded on `update`.
 */
export class FakeScreenshotStateStore implements ScreenshotStateStore {
  private states: Map<string, FakeScreenshotState> = new Map();
  private observationStates: Map<string, Map<string, FakeScreenshotState>> = new Map();
  private pendingObservations: Set<string> = new Set();
  private pendingObservationWaiters: Map<string, Set<() => void>> = new Map();
  private currentTime: number = 0;

  constructor(private readonly timer: Timer = defaultTimer) {}

  setNow(time: number): void {
    this.currentTime = time;
  }

  update(deviceId: string, path?: string, error?: string): void {
    this.states.set(deviceId, {
      path: path ?? null,
      error: error ?? null,
      timestamp: this.currentTime,
    });
  }

  updateForObservation(
    deviceId: string,
    observationId: string,
    path?: string,
    error?: string,
  ): void {
    const states = this.observationStates.get(deviceId) ?? new Map<string, FakeScreenshotState>();
    states.delete(observationId);
    states.set(observationId, {
      path: path ?? null,
      error: error ?? null,
      timestamp: this.currentTime,
    });
    this.observationStates.set(deviceId, states);
    this.completeObservation(deviceId, observationId);
  }

  beginObservation(deviceId: string, observationId: string): void {
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

  getPath(deviceId?: string): string | undefined {
    const state = this.findLatest(deviceId);
    return state?.path ?? undefined;
  }

  getError(deviceId?: string): string | undefined {
    const state = this.findLatest(deviceId);
    return state?.error ?? undefined;
  }

  getPathForObservation(deviceId: string, observationId: string): string | undefined {
    return this.observationStates.get(deviceId)?.get(observationId)?.path ?? undefined;
  }

  getErrorForObservation(deviceId: string, observationId: string): string | undefined {
    return this.observationStates.get(deviceId)?.get(observationId)?.error ?? undefined;
  }

  clear(deviceId?: string): void {
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

  private findLatest(deviceId?: string): FakeScreenshotState | undefined {
    if (deviceId) {
      return this.states.get(deviceId);
    }
    let mostRecent: FakeScreenshotState | undefined;
    for (const state of this.states.values()) {
      if (!mostRecent || state.timestamp > mostRecent.timestamp) {
        mostRecent = state;
      }
    }
    return mostRecent;
  }
}
