import type { ScreenshotStateStore } from "../../src/features/observe/screenshot/ScreenshotStateRegistry";

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
  private currentTime: number = 0;

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
