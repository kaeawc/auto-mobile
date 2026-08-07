import { mkdirSync, readdirSync } from "node:fs";
import path from "path";
import { readdirAsync, readFileAsync, statAsync, unlinkAsync, writeFileAsync } from "../../../utils/io";
import { logger } from "../../../utils/logger";
import { getTempDir, TEMP_SUBDIRS } from "../../../utils/tempDir";
import { Timer, defaultTimer } from "../../../utils/SystemTimer";
import type { ObserveResult } from "../../../models";
import type { ObserveResultCacheStore } from "./ObserveResultCacheStore";

/**
 * Cached entry held in memory.
 * Mirrors the shape previously kept in `RealObserveScreen.observeResultCache`.
 */
interface ObserveResultCacheEntry {
  timestamp: number;
  deviceId: string;
  observeResult: ObserveResult;
}

/**
 * Migrate an observation written by a pre-#5074 daemon. Back then `layoutWarnings`
 * was a `LayoutWarning[]` with a sibling `layoutWarningsTruncated` number; it is
 * now the `{ scope, total?, warnings }` envelope. After an in-place upgrade a
 * legacy-shaped entry can still be within the cache TTL, and downstream code
 * dereferences `layoutWarnings.warnings` — so normalize it here at the disk-load
 * boundary before it warms the in-memory cache or is served to a resource.
 */
export function normalizeCachedObserveResult(parsed: unknown): ObserveResult {
  // Mutate through a Record view, but return the original `unknown` value cast to
  // ObserveResult: `unknown -> ObserveResult` is a single legal assertion, whereas
  // `Record<string, unknown> -> ObserveResult` is a TS2352 insufficient-overlap
  // error (and `as unknown as` would trip the no-unknown-cast lint).
  const record = parsed as Record<string, unknown>;
  const legacy = record.layoutWarnings;
  if (Array.isArray(legacy)) {
    const truncated = record.layoutWarningsTruncated;
    const total = typeof truncated === "number" ? truncated : undefined;
    record.layoutWarnings = total !== undefined
      ? { scope: "truncated", total, warnings: legacy }
      : { scope: "full", warnings: legacy };
    delete record.layoutWarningsTruncated;
  }
  return parsed as ObserveResult;
}

/**
 * Five-minute TTL applied to both in-memory and on-disk cache entries.
 * Preserves the original {@link RealObserveScreen} behaviour.
 */
export const OBSERVE_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * File-system backed implementation of {@link ObserveResultCacheStore}.
 *
 * Behaviour parity with the previous `RealObserveScreen` static cache:
 * - In-memory map keyed by `${deviceId}:${timestamp}`.
 * - On-disk files named `observe_${sanitizedDeviceId}_${timestamp}.json`.
 * - Cache directory is `getTempDir(TEMP_SUBDIRS.OBSERVE_RESULTS)`.
 * - 5 minute TTL; expired entries are evicted from memory lazily on read.
 */
export class FileSystemObserveCacheStore implements ObserveResultCacheStore {
  private readonly cache: Map<string, ObserveResultCacheEntry> = new Map();
  private readonly cacheDir: string;
  private readonly timer: Timer;
  private pendingDiskCleanup: Promise<void> = Promise.resolve();

  constructor(timer: Timer = defaultTimer, cacheDir?: string) {
    this.timer = timer;
    this.cacheDir = cacheDir ?? getTempDir(TEMP_SUBDIRS.OBSERVE_RESULTS);
    this.ensureCacheDirExists();
  }

  private ensureCacheDirExists(): void {
    mkdirSync(this.cacheDir, { recursive: true });
  }

  async put(deviceId: string, result: ObserveResult): Promise<void> {
    const timestamp = this.timer.now();
    const cacheKey = `${deviceId}:${timestamp}`;
    try {
      logger.debug(`[OBSERVE_CACHE] Caching observe result for device ${deviceId} with timestamp ${timestamp}`);
      await this.pendingDiskCleanup;
      this.cache.set(cacheKey, { timestamp, deviceId, observeResult: result });
      await this.saveObserveResultToDisk(cacheKey, result);
      logger.debug(`[OBSERVE_CACHE] Successfully cached observe result, in-memory cache size: ${this.cache.size}`);
    } catch (error) {
      logger.warn(`[OBSERVE_CACHE] Error caching observe result: ${error}`);
    }
  }

  async getMostRecent(deviceId: string): Promise<ObserveResult | undefined> {
    const memoryResult = this.checkInMemory(deviceId);
    if (memoryResult) {
      return memoryResult;
    }
    return await this.checkDisk(deviceId);
  }

  getRecentInMemory(): ObserveResult | undefined {
    return this.findMostRecentInMemory();
  }

  getRecentInMemoryForDevice(deviceId: string): ObserveResult | undefined {
    return this.findMostRecentInMemory(deviceId);
  }

  clear(deviceId?: string): void {
    if (deviceId) {
      for (const [key, entry] of this.cache.entries()) {
        if (entry.deviceId === deviceId) {
          this.cache.delete(key);
        }
      }
      this.deleteDiskFilesForDevice(deviceId);
    } else {
      this.cache.clear();
      this.deleteAllDiskFiles();
    }
  }

  /**
   * Walk the cache map once: evict expired entries and return the most-recent
   * live entry, optionally filtered to a device. Uses `>=` for tie-breaks so
   * the latest insertion wins when wall-clock resolution collides with two
   * adjacent puts.
   */
  private collectLiveMostRecent(deviceId?: string, verboseLog: boolean = false): ObserveResultCacheEntry | undefined {
    if (this.cache.size === 0) {
      return undefined;
    }

    const now = this.timer.now();
    const expiredKeys: string[] = [];
    let mostRecentEntry: ObserveResultCacheEntry | undefined;

    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age >= OBSERVE_RESULT_CACHE_TTL_MS) {
        expiredKeys.push(key);
        if (verboseLog) {
          logger.debug(`[OBSERVE_CACHE] Removing expired cache entry: ${key} (age: ${age}ms > TTL: ${OBSERVE_RESULT_CACHE_TTL_MS}ms)`);
        }
        continue;
      }
      if (deviceId && entry.deviceId !== deviceId) {
        continue;
      }
      if (!mostRecentEntry || entry.timestamp >= mostRecentEntry.timestamp) {
        mostRecentEntry = entry;
      }
    }

    for (const key of expiredKeys) {
      this.cache.delete(key);
    }

    return mostRecentEntry;
  }

  private findMostRecentInMemory(deviceId?: string): ObserveResult | undefined {
    return this.collectLiveMostRecent(deviceId)?.observeResult;
  }

  private checkInMemory(deviceId: string): ObserveResult | undefined {
    const cacheSize = this.cache.size;
    logger.debug(`[OBSERVE_CACHE] Checking in-memory cache for device ${deviceId}, size: ${cacheSize}`);
    if (cacheSize === 0) {
      logger.debug("[OBSERVE_CACHE] In-memory cache is empty");
      return undefined;
    }

    const entry = this.collectLiveMostRecent(deviceId, true);
    if (entry) {
      const age = this.timer.now() - entry.timestamp;
      logger.debug(`[OBSERVE_CACHE] Found most recent in-memory result for device ${deviceId} (age: ${age}ms)`);
      return entry.observeResult;
    }

    logger.debug(`[OBSERVE_CACHE] No valid entries in in-memory cache for device ${deviceId}`);
    return undefined;
  }

  private async checkDisk(deviceId: string): Promise<ObserveResult | undefined> {
    logger.debug("[OBSERVE_CACHE] Checking disk cache");
    try {
      const devicePrefix = `observe_${this.sanitizeDeviceId(deviceId)}_`;
      const files = await readdirAsync(this.cacheDir);
      const jsonFiles = files.filter(file => file.endsWith(".json") && file.startsWith(devicePrefix));

      if (jsonFiles.length === 0) {
        logger.debug("[OBSERVE_CACHE] No observe result files found in disk cache");
        return undefined;
      }

      const now = this.timer.now();
      let mostRecentFile: { path: string; mtime: number } | undefined;

      for (const file of jsonFiles) {
        const filePath = path.join(this.cacheDir, file);
        const stats = await statAsync(filePath);
        const age = now - stats.mtime.getTime();

        if (age < OBSERVE_RESULT_CACHE_TTL_MS) {
          if (!mostRecentFile || stats.mtime.getTime() > mostRecentFile.mtime) {
            mostRecentFile = { path: filePath, mtime: stats.mtime.getTime() };
          }
        } else {
          logger.debug(`[OBSERVE_CACHE] Disk cache file expired: ${file} (age: ${age}ms > TTL: ${OBSERVE_RESULT_CACHE_TTL_MS}ms)`);
        }
      }

      if (!mostRecentFile) {
        logger.debug("[OBSERVE_CACHE] No valid files in disk cache");
        return undefined;
      }

      const age = now - mostRecentFile.mtime;
      logger.debug(`[OBSERVE_CACHE] Loading most recent disk cache file (age: ${age}ms)`);

      const cacheData = await readFileAsync(mostRecentFile.path, "utf8");
      const cachedResult = normalizeCachedObserveResult(JSON.parse(cacheData));

      // Warm the in-memory cache so subsequent reads avoid the disk round-trip.
      const cacheKey = `${deviceId}:${mostRecentFile.mtime}`;
      this.cache.set(cacheKey, {
        timestamp: mostRecentFile.mtime,
        deviceId,
        observeResult: cachedResult,
      });
      logger.debug(`[OBSERVE_CACHE] Updated in-memory cache from disk cache`);
      return cachedResult;
    } catch (error) {
      logger.warn(`[OBSERVE_CACHE] Error checking disk cache: ${error}`);
      return undefined;
    }
  }

  private async saveObserveResultToDisk(cacheKey: string, observeResult: ObserveResult): Promise<void> {
    try {
      const filename = `observe_${cacheKey.replace(/:/g, "_")}.json`;
      const filePath = path.join(this.cacheDir, filename);
      await writeFileAsync(filePath, JSON.stringify(observeResult, null, 2));
      logger.debug(`[OBSERVE_CACHE] Saved observe result to disk: ${filename}`);
    } catch (error) {
      logger.warn(`[OBSERVE_CACHE] Failed to save observe result to disk: ${error}`);
    }
  }

  private sanitizeDeviceId(deviceId: string): string {
    return deviceId.replace(/:/g, "_");
  }

  private deleteDiskFilesForDevice(deviceId: string): void {
    const devicePrefix = `observe_${this.sanitizeDeviceId(deviceId)}_`;
    this.deleteDiskFilesMatching(filename => filename.endsWith(".json") && filename.startsWith(devicePrefix));
  }

  private deleteAllDiskFiles(): void {
    this.deleteDiskFilesMatching(filename => filename.endsWith(".json") && filename.startsWith("observe_"));
  }

  private deleteDiskFilesMatching(predicate: (filename: string) => boolean): void {
    // Snapshot the file list synchronously before returning so a put() that
    // races immediately after clear() cannot have its fresh file caught up in
    // the deletion. New files written after clear() returns are not in the
    // snapshot.
    let matches: string[];
    try {
      matches = readdirSync(this.cacheDir).filter(predicate);
    } catch (error) {
      logger.warn(`[OBSERVE_CACHE] Failed to enumerate cache directory for cleanup: ${error}`);
      return;
    }

    if (matches.length === 0) {
      return;
    }

    const cleanup = Promise.all(
      matches.map(async file => {
        try {
          await unlinkAsync(path.join(this.cacheDir, file));
        } catch (error) {
          logger.warn(`[OBSERVE_CACHE] Failed to delete cache file ${file}: ${error}`);
        }
      })
    ).then(() => {});
    this.pendingDiskCleanup = this.pendingDiskCleanup.then(() => cleanup);
  }
}
