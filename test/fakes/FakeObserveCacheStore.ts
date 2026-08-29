import type { ObserveResult } from "../../src/models";
import type { ObserveResultCacheStore } from "../../src/features/observe/cache/ObserveResultCacheStore";
import { Timer, defaultTimer } from "../../src/utils/SystemTimer";

/**
 * Five-minute TTL — matches FileSystemObserveCacheStore.
 */
const TTL_MS = 5 * 60 * 1000;

interface FakeCacheEntry {
  deviceId: string;
  timestamp: number;
  observeResult: ObserveResult;
}

/**
 * In-memory-only fake implementation of {@link ObserveResultCacheStore}.
 *
 * No disk I/O — disk reads/writes are simulated by the same in-memory map
 * used for the memory cache. Useful for tests that want to verify cache
 * behaviour without filesystem coupling.
 */
export class FakeObserveCacheStore implements ObserveResultCacheStore {
  private readonly entries: Map<string, FakeCacheEntry> = new Map();
  private readonly timer: Timer;
  private globalGeneration: number = 0;
  private readonly deviceGeneration: Map<string, number> = new Map();

  /**
   * Test seam: invoked with `(deviceId, generation)` each time
   * {@link currentGeneration} is read. Lets a test simulate a concurrent
   * invalidation landing the instant an observation captures its generation
   * (issue #5884). Defaults to a no-op.
   */
  onCurrentGeneration?: (deviceId: string, generation: number) => void;

  constructor(timer: Timer = defaultTimer) {
    this.timer = timer;
  }

  currentGeneration(deviceId: string): number {
    const generation = this.globalGeneration + (this.deviceGeneration.get(deviceId) ?? 0);
    this.onCurrentGeneration?.(deviceId, generation);
    return generation;
  }

  async put(deviceId: string, result: ObserveResult, generation?: number): Promise<void> {
    if (generation !== undefined && generation !== this.rawGeneration(deviceId)) {
      return;
    }
    const timestamp = this.timer.now();
    this.entries.set(`${deviceId}:${timestamp}`, {
      deviceId,
      timestamp,
      observeResult: result,
    });
  }

  /** Generation without firing {@link onCurrentGeneration} — used by put's fence. */
  private rawGeneration(deviceId: string): number {
    return this.globalGeneration + (this.deviceGeneration.get(deviceId) ?? 0);
  }

  async getMostRecent(deviceId: string): Promise<ObserveResult | undefined> {
    return this.findMostRecent(deviceId);
  }

  getRecentInMemory(): ObserveResult | undefined {
    return this.findMostRecent();
  }

  getRecentInMemoryForDevice(deviceId: string): ObserveResult | undefined {
    return this.findMostRecent(deviceId);
  }

  clear(deviceId?: string): void {
    if (!deviceId) {
      this.globalGeneration += 1;
      this.entries.clear();
      return;
    }
    this.deviceGeneration.set(deviceId, (this.deviceGeneration.get(deviceId) ?? 0) + 1);
    for (const [key, entry] of this.entries.entries()) {
      if (entry.deviceId === deviceId) {
        this.entries.delete(key);
      }
    }
  }

  /** Test helper: number of currently-cached entries (regardless of TTL). */
  getEntryCount(): number {
    return this.entries.size;
  }

  /** Test helper: snapshot of every entry currently held. */
  getAllEntries(): Array<{ deviceId: string; timestamp: number; observeResult: ObserveResult }> {
    return Array.from(this.entries.values()).map((entry) => ({
      deviceId: entry.deviceId,
      timestamp: entry.timestamp,
      observeResult: entry.observeResult,
    }));
  }

  private findMostRecent(deviceId?: string): ObserveResult | undefined {
    if (this.entries.size === 0) {
      return undefined;
    }
    const now = this.timer.now();
    const expiredKeys: string[] = [];
    let mostRecent: FakeCacheEntry | undefined;
    for (const [key, entry] of this.entries.entries()) {
      const age = now - entry.timestamp;
      if (age >= TTL_MS) {
        expiredKeys.push(key);
        continue;
      }
      if (deviceId && entry.deviceId !== deviceId) {
        continue;
      }
      if (!mostRecent || entry.timestamp > mostRecent.timestamp) {
        mostRecent = entry;
      }
    }
    for (const key of expiredKeys) {
      this.entries.delete(key);
    }
    return mostRecent?.observeResult;
  }
}
