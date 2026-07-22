import { AdbClientFactory, defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice, ExecResult } from "../../models";
import * as fs from "fs/promises";
import * as path from "path";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { getTempDir, TEMP_SUBDIRS } from "../../utils/tempDir";
import type { DumpsysWindow } from "./interfaces/DumpsysWindow";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { logger as defaultLogger, type Logger } from "../../utils/logger";

export class GetDumpsysWindow implements DumpsysWindow {
  private adb: AdbExecutor;
  private readonly device: BootedDevice;
  private timer: Timer;
  private logger: Logger;
  private static memoryCache = new Map<string, { data: ExecResult; timestamp: number }>();
  private static readonly CACHE_TTL_MS = 30000; // 30 seconds
  private readonly cacheDir: string;
  private readonly cacheFilePath: string;

  /**
   * Create a GetDumpsysWindow instance
   * @param device - Device to run ADB commands against
   * @param adbFactory - Factory for creating AdbClient instances
   * @param timer - Injected timer
   * @param logger - Injected logger. Tests that assert on emitted diagnostics must
   *   pass a fake: patching the shared `logger` singleton instead makes the
   *   assertion race every other test that logs concurrently (issue #4134).
   */
  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    timer: Timer = defaultTimer,
    logger: Logger = defaultLogger
  ) {
    this.device = device;
    this.adb = adbFactory.create(device);
    this.cacheDir = getTempDir(TEMP_SUBDIRS.CACHE);
    this.cacheFilePath = path.join(this.cacheDir, `dumpsys-window-${device.deviceId}.json`);
    this.timer = timer;
    this.logger = logger;
  }

  /**
   * Get cached dumpsys window data, using memory cache first, then disk cache
   * @param perf - Optional performance tracker
   * @returns Promise with cached rotation value or executes fresh command
   */
  public async execute(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal
  ): Promise<ExecResult> {
    // Check memory cache first
    const memoryCached = GetDumpsysWindow.memoryCache.get(this.device.deviceId);
    if (memoryCached && this.isCacheValid(memoryCached.timestamp)) {
      return memoryCached.data;
    }

    // Check disk cache
    try {
      const diskCached = await perf.track("loadDiskCache", () => this.loadFromDiskCache());
      if (diskCached && this.isCacheValid(diskCached.timestamp)) {
        // Update memory cache with disk data
        GetDumpsysWindow.memoryCache.set(this.device.deviceId, diskCached);
        return diskCached.data;
      }
    } catch (error) {
      // Disk cache is opportunistic; a cache read failure should fall through to ADB refresh.
      this.logger.debug(`Failed to load dumpsys window disk cache for device ${this.device.deviceId}: ${error instanceof Error ? error.message : String(error)}`, error);
    }

    // No valid cache found, refresh and return
    return await this.refresh(perf, signal);
  }

  /**
   * Refresh dumpsys window data and update both memory and disk cache
   * @param perf - Optional performance tracker
   * @returns Promise with fresh rotation value
   */
  public async refresh(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal
  ): Promise<ExecResult> {
    const result = await perf.track("adbDumpsysWindow", () =>
      this.adb.executeCommand("shell dumpsys window", undefined, undefined, undefined, signal)
    );
    const timestamp = this.timer.now();
    const cacheEntry = { data: result, timestamp };

    // Update memory cache
    GetDumpsysWindow.memoryCache.set(this.device.deviceId, cacheEntry);

    // Update disk cache
    try {
      await perf.track("saveDiskCache", () => this.saveToDiskCache(cacheEntry));
    } catch (error) {
      // Disk cache write failed, but we still return the result
      this.logger.warn(`Failed to write disk cache for device ${this.device.deviceId}:`, error);
    }

    return result;
  }

  private isCacheValid(timestamp: number): boolean {
    return this.timer.now() - timestamp < GetDumpsysWindow.CACHE_TTL_MS;
  }

  private async loadFromDiskCache(): Promise<{ data: ExecResult; timestamp: number } | null> {
    try {
      const cacheData = await fs.readFile(this.cacheFilePath, "utf-8");
      return JSON.parse(cacheData);
    } catch (error) {
      // Disk cache is opportunistic; callers can refresh from ADB when no cache is available.
      this.logger.debug(`Failed to read dumpsys window disk cache for device ${this.device.deviceId}: ${error instanceof Error ? error.message : String(error)}`, error);
      return null;
    }
  }

  private async saveToDiskCache(cacheEntry: { data: ExecResult; timestamp: number }): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(this.cacheFilePath, JSON.stringify(cacheEntry), "utf-8");
  }
}
