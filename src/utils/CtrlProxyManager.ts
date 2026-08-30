import { errorMessage } from "./describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "./android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "./android-cmdline-tools/interfaces/AdbExecutor";
import { logger } from "./logger";
import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import { ActionableError, BootedDevice } from "../models";
import { requireBootedDevice } from "./requireBootedDevice";
import {
  isExplicitPin,
  isPinnedVersionKnown,
  resolveApkChecksum,
  resolveApkUrl,
  resolvePinnedVersion,
} from "../constants/release";
import AdmZip from "adm-zip";
import crypto from "crypto";
import os from "os";
import { accessibilityDetector } from "./AccessibilityDetector";
import type { AccessibilityDetector } from "./interfaces/AccessibilityDetector";
import {
  NoOpPerformanceTracker,
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "./PerformanceTracker";
import { Timer, defaultTimer } from "./SystemTimer";
import { type FileDownloader, DefaultFileDownloader } from "./FileDownloader";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "./ChecksumCalculator";
import type { ProxyManager, ProxySetupResult } from "./interfaces/ProxyManager";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "./workingDirectory";
import { getTempDir } from "./tempDir";
import {
  type AndroidPrerequisiteDetector,
  DefaultAndroidPrerequisiteDetector,
} from "./android-cmdline-tools/AndroidPrerequisiteDetector";

export const MAX_STALE_PREFETCH_DIRS_PER_STARTUP = 20;
export const STALE_PREFETCH_SWEEP_DEADLINE_MS = 5_000;

/**
 * Android-specific accessibility-service lifecycle, extending the
 * platform-agnostic {@link ProxyManager}.
 */
export interface CtrlProxyManager extends ProxyManager {
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;
  isEnabled(): Promise<boolean>;
  isEnabledForUser(userId: number): Promise<boolean>;
  getInstalledApkSha256(): Promise<string | null>;
  isVersionCompatible(): Promise<boolean>;
  ensureCompatibleVersion(
    options?: AccessibilityVersionCheckOptions,
  ): Promise<AccessibilityVersionCheckResult>;
  downloadApk(): Promise<string>;
  install(apkPath: string): Promise<void>;
  enable(): Promise<void>;
  enableForUser(userId: number): Promise<void>;
  cleanupApk(apkPath: string): Promise<void>;
}

interface AccessibilityVersionCheckResult {
  status:
    | "skipped"
    | "not_installed"
    | "compatible"
    | "upgraded"
    | "installed"
    | "reinstalled"
    | "failed";
  expectedSha256?: string;
  installedSha256?: string | null;
  installedShaSource?: "device" | "host" | "none";
  installedApkPath?: string | null;
  attemptedDownload?: boolean;
  attemptedInstall?: boolean;
  attemptedReinstall?: boolean;
  downloadUnavailable?: boolean;
  acceptedPreinstalled?: boolean;
  error?: string;
  upgradeError?: string;
  reinstallError?: string;
}

interface AccessibilityVersionCheckOptions {
  allowDownloadWhenInstalled?: boolean;
  bypassVersionCheckCache?: boolean;
}

interface ToggleCapabilities {
  supportsSettingsToggle: boolean;
  deviceType: "emulator" | "physical";
  apiLevel: number | null;
  reason?: string;
}

type InstalledApkSha256Result = {
  sha256: string | null;
  source: "device" | "host" | "none";
  apkPath?: string;
  error?: string;
};

export class AndroidCtrlProxyManager implements CtrlProxyManager {
  private readonly device: BootedDevice;
  private adb: AdbExecutor;
  public static readonly PACKAGE = "dev.jasonpearson.automobile.ctrlproxy";
  public static readonly ACTIVITY = "dev.jasonpearson.automobile.ctrlproxy.MainActivity";
  /** Package name used before the rename to CtrlProxy — uninstalled opportunistically on device setup */
  private static readonly LEGACY_PACKAGE = "dev.jasonpearson.automobile.accessibilityservice";

  // Static cache for service availability
  private cachedAvailability: { isAvailable: boolean; timestamp: number } | null = null;
  private static readonly AVAILABILITY_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private cachedVersionCheck: {
    result: AccessibilityVersionCheckResult;
    timestamp: number;
  } | null = null;
  private static readonly VERSION_CHECK_CACHE_TTL = 60 * 1000; // 1 minute

  // Static caches for individual status checks
  private cachedInstallation: { isInstalled: boolean; timestamp: number } | null = null;
  private cachedEnabled: { isEnabled: boolean; timestamp: number } | null = null;
  private static readonly STATUS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  // Cache for toggle capabilities (settings permissions don't change during session)
  private cachedToggleCapabilities: ToggleCapabilities | null = null;

  private attemptedAutomatedSetup: boolean = false;
  private static instances: Map<string, AndroidCtrlProxyManager> = new Map();
  private static expectedChecksumOverride: string | null = null;
  private static accessibilityDetectorOverride: AccessibilityDetector | null = null;

  // Static prefetch state for APK download optimization
  private static prefetchPromise: Promise<string | null> | null = null;
  private static prefetchedApkPath: string | null = null;
  private static prefetchError: Error | null = null;

  // Static factory for creating ADB clients
  private static adbFactory: AdbClientFactory = defaultAdbClientFactory;

  private timer: Timer;

  // Shared utilities for download and checksum
  private readonly fileDownloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private static readonly defaultFileDownloader: FileDownloader = new DefaultFileDownloader();
  private static readonly defaultChecksumCalculator: ChecksumCalculator =
    new DefaultChecksumCalculator();

  // Gate that decides whether the startup APK prefetch should run at all (#4404).
  private static androidPrerequisiteDetector: AndroidPrerequisiteDetector =
    new DefaultAndroidPrerequisiteDetector();
  // Test seam for the static prefetch's downloader; null uses defaultFileDownloader.
  private static prefetchFileDownloaderOverride: FileDownloader | null = null;
  private static prefetchCacheDirOverride: string | null = null;

  private constructor(
    device: BootedDevice,
    adb: AdbExecutor,
    timer: Timer = defaultTimer,
    fileDownloader: FileDownloader = AndroidCtrlProxyManager.defaultFileDownloader,
    checksumCalculator: ChecksumCalculator = AndroidCtrlProxyManager.defaultChecksumCalculator,
  ) {
    // home should either be process.env.HOME or bash resolution of home for current user
    const homeDir = process.env.HOME || require("os").homedir();
    if (!homeDir) {
      throw new Error("Home directory for current user not found");
    }
    this.device = device;
    this.adb = adb;
    this.timer = timer;
    this.fileDownloader = fileDownloader;
    this.checksumCalculator = checksumCalculator;
  }

  public static getInstance(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
  ): AndroidCtrlProxyManager {
    requireBootedDevice(device, "AndroidCtrlProxyManager.getInstance");
    if (!AndroidCtrlProxyManager.instances.has(device.deviceId)) {
      let adb: AdbExecutor;
      let factory: AdbClientFactory;
      // Detect if the argument is a factory (has create method) or an executor
      if (
        adbFactoryOrExecutor &&
        typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
      ) {
        factory = adbFactoryOrExecutor as AdbClientFactory;
        adb = factory.create(device);
      } else if (adbFactoryOrExecutor) {
        // Legacy path: wrap the executor in a factory for downstream dependencies
        const executor = adbFactoryOrExecutor as AdbExecutor;
        adb = executor;
        factory = { create: () => executor };
      } else {
        factory = defaultAdbClientFactory;
        adb = factory.create(device);
      }
      AndroidCtrlProxyManager.adbFactory = factory;
      AndroidCtrlProxyManager.instances.set(
        device.deviceId,
        new AndroidCtrlProxyManager(device, adb),
      );
    }
    return AndroidCtrlProxyManager.instances.get(device.deviceId)!;
  }

  public static createForTestingWithDeps(
    device: BootedDevice,
    adb: AdbExecutor,
    timer: Timer = defaultTimer,
    fileDownloader: FileDownloader = AndroidCtrlProxyManager.defaultFileDownloader,
    checksumCalculator: ChecksumCalculator = AndroidCtrlProxyManager.defaultChecksumCalculator,
  ): AndroidCtrlProxyManager {
    requireBootedDevice(device, "AndroidCtrlProxyManager.createForTestingWithDeps");
    return new AndroidCtrlProxyManager(device, adb, timer, fileDownloader, checksumCalculator);
  }

  /**
   * Reset all instances (for testing)
   */
  public static resetInstances(): void {
    AndroidCtrlProxyManager.instances.clear();
  }

  /**
   * Prefetch the accessibility service APK asynchronously.
   * Call this at server startup to warm the cache before first device connection.
   * This is a no-op if prefetch is already in progress or completed.
   */
  public static prefetchApk(): Promise<string | null> {
    // Skip if already prefetching or prefetched
    if (AndroidCtrlProxyManager.prefetchPromise !== null) {
      logger.info("[CTRL_PROXY] APK prefetch already initiated, skipping");
      return AndroidCtrlProxyManager.prefetchPromise;
    }

    // Skip if there's an override path (local APK)
    const overridePath = process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH?.trim();
    if (overridePath && overridePath.length > 0) {
      logger.info("[CTRL_PROXY] Using local APK override, skipping prefetch");
      return Promise.resolve(null);
    }

    logger.info("[CTRL_PROXY] Starting APK prefetch");
    const startTime = defaultTimer.now();
    AndroidCtrlProxyManager.prefetchError = null;

    AndroidCtrlProxyManager.prefetchPromise = AndroidCtrlProxyManager.doPrefetch()
      .then((apkPath) => {
        const duration = defaultTimer.now() - startTime;
        if (apkPath) {
          AndroidCtrlProxyManager.prefetchedApkPath = apkPath;
          logger.info(`[CTRL_PROXY] APK prefetch completed in ${duration}ms`, { path: apkPath });
        }
        return apkPath;
      })
      .catch((error) => {
        const duration = defaultTimer.now() - startTime;
        AndroidCtrlProxyManager.prefetchError =
          error instanceof Error ? error : new Error(String(error));
        logger.warn(`[CTRL_PROXY] APK prefetch failed after ${duration}ms`, {
          error: AndroidCtrlProxyManager.prefetchError.message,
        });
        AndroidCtrlProxyManager.prefetchPromise = null;
        return null;
      });
    return AndroidCtrlProxyManager.prefetchPromise;
  }

  /**
   * Internal prefetch implementation
   */
  private static async doPrefetch(): Promise<string | null> {
    // Skip cleanly in environments that cannot consume the APK. Without ADB (and
    // the SDK tooling behind it) no Android device work is possible, so there is
    // no reason to download and verify the APK during startup (#4404). Returning
    // null (not throwing) keeps the daemon healthy and non-Android workflows intact.
    if (!(await AndroidCtrlProxyManager.androidPrerequisiteDetector.hasAndroidPrerequisites())) {
      logger.info(
        "[CTRL_PROXY] Prefetch skipped: Android prerequisites (adb/SDK) not detected; " +
          "the APK is only needed for Android device work",
      );
      return null;
    }

    // Fail closed before touching the network: don't background-download and cache
    // an unverifiable APK for an unknown explicit pin (#2746). Skipping (not
    // throwing) keeps daemon startup alive; the install path still fails closed.
    if (AndroidCtrlProxyManager.isPinnedVersionUnverifiable()) {
      logger.warn(
        `[CTRL_PROXY] Prefetch skipped: AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the ` +
          `release checksum registry, so the APK cannot be integrity-verified`,
      );
      return null;
    }

    const apkUrl = resolveApkUrl();
    const expectedChecksum =
      AndroidCtrlProxyManager.expectedChecksumOverride ?? resolveApkChecksum();
    const cacheKey = crypto
      .createHash("sha256")
      .update(`${apkUrl}\n${expectedChecksum.toLowerCase()}`)
      .digest("hex");
    const cachePath = path.join(
      AndroidCtrlProxyManager.prefetchCacheDirOverride ?? getTempDir("cache/ctrl-proxy"),
      `control-proxy-${cacheKey}.apk`,
    );
    const cacheDir = path.dirname(cachePath);

    await fs.mkdir(cacheDir, { recursive: true });
    await AndroidCtrlProxyManager.sweepStalePrefetchDirsOnStartup(cacheDir);
    if (await AndroidCtrlProxyManager.isValidPrefetchCache(cachePath, expectedChecksum)) {
      logger.info("[CTRL_PROXY] Prefetch: reused cached APK", { path: cachePath });
      return cachePath;
    }

    const tempDir = await fs.mkdtemp(path.join(cacheDir, "auto-mobile-prefetch-"));
    const apkPath = path.join(tempDir, "control-proxy.apk");

    try {
      // Download the APK (URL honors AUTOMOBILE_VERSION + AUTOMOBILE_ASSET_BASE_URL)
      logger.info("[CTRL_PROXY] Prefetch: downloading APK", { url: apkUrl, destination: apkPath });
      const downloader =
        AndroidCtrlProxyManager.prefetchFileDownloaderOverride ??
        AndroidCtrlProxyManager.defaultFileDownloader;
      await downloader.download(apkUrl, apkPath);

      const size = await AndroidCtrlProxyManager.verifyPrefetchedApk(apkPath, expectedChecksum);
      const publishedPath = await AndroidCtrlProxyManager.publishPrefetchedApk(
        apkPath,
        cachePath,
        expectedChecksum,
      );
      logger.info("[CTRL_PROXY] Prefetch: APK ready", { path: publishedPath, size });
      return publishedPath;
    } catch (error) {
      throw error;
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // A failed staging cleanup is safe to defer to the startup stale sweep.
        logger.debug(
          `[CTRL_PROXY] Failed to remove prefetch staging directory ${tempDir}: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
    }
  }

  private static async verifyPrefetchedApk(
    apkPath: string,
    expectedChecksum: string,
  ): Promise<number> {
    const stats = await fs.stat(apkPath);
    if (stats.size < 10000) {
      throw new Error(`Prefetched APK is too small (${stats.size} bytes), likely invalid`);
    }
    AndroidCtrlProxyManager.verifyApkIntegrityStatic(apkPath);
    if (expectedChecksum.length === 0) {
      return stats.size;
    }
    const { checksum: actualChecksum } =
      await AndroidCtrlProxyManager.defaultChecksumCalculator.computeFileSha256(apkPath);
    if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
      throw new Error(
        `APK checksum verification failed. Expected: ${expectedChecksum}, Got: ${actualChecksum}`,
      );
    }
    logger.info("[CTRL_PROXY] Prefetch: checksum verified", { checksum: actualChecksum });
    return stats.size;
  }

  private static async publishPrefetchedApk(
    apkPath: string,
    cachePath: string,
    expectedChecksum: string,
  ): Promise<string> {
    try {
      await fs.rename(apkPath, cachePath);
      return cachePath;
    } catch (error) {
      // Another daemon can win publication while this download was in flight.
      if (await AndroidCtrlProxyManager.isValidPrefetchCache(cachePath, expectedChecksum)) {
        logger.info("[CTRL_PROXY] Prefetch: reused concurrently published APK", {
          path: cachePath,
        });
        return cachePath;
      }
      throw error;
    }
  }

  private static async isValidPrefetchCache(
    cachePath: string,
    expectedChecksum: string,
  ): Promise<boolean> {
    try {
      const stats = await fs.stat(cachePath);
      if (stats.size < 10000) {
        throw new Error(`cached APK is too small (${stats.size} bytes)`);
      }
      AndroidCtrlProxyManager.verifyApkIntegrityStatic(cachePath);
      if (expectedChecksum.length > 0) {
        const { checksum } =
          await AndroidCtrlProxyManager.defaultChecksumCalculator.computeFileSha256(cachePath);
        if (checksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
          throw new Error("cached APK checksum does not match the expected release");
        }
      }
      return true;
    } catch (error) {
      // Invalid or missing cache entries are expected during refresh and can be replaced.
      logger.debug(`[CTRL_PROXY] Prefetch cache miss for ${cachePath}: ${errorMessage(error)}`);
      try {
        await fs.rm(cachePath, { force: true });
      } catch (cleanupError) {
        // Cache cleanup is best-effort; the download can still publish a replacement.
        logger.debug(
          `[CTRL_PROXY] Failed to remove invalid prefetch cache ${cachePath}: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
      return false;
    }
  }

  /**
   * Get the prefetched APK path, waiting for prefetch to complete if in progress.
   * Returns null if prefetch failed or was not initiated.
   */
  public static async getPrefetchedApkPath(): Promise<string | null> {
    if (AndroidCtrlProxyManager.prefetchPromise === null) {
      return null;
    }

    try {
      await AndroidCtrlProxyManager.prefetchPromise;
      return AndroidCtrlProxyManager.prefetchedApkPath;
    } catch (error) {
      // APK prefetch is an optimization; callers can proceed without a prefetched APK.
      logger.debug(`[CTRL_PROXY] Prefetched APK unavailable: ${errorMessage(error)}`, error);
      return null;
    }
  }

  /**
   * Consume the prefetched APK path by copying it to a new location.
   * This allows multiple devices to use the prefetched APK.
   * Returns null if no prefetched APK is available.
   */
  public static async consumePrefetchedApk(destinationPath: string): Promise<boolean> {
    const prefetchedPath = await AndroidCtrlProxyManager.getPrefetchedApkPath();
    if (!prefetchedPath) {
      return false;
    }

    try {
      // Ensure destination directory exists
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(prefetchedPath, destinationPath);
      logger.info("[CTRL_PROXY] Copied prefetched APK", {
        source: prefetchedPath,
        destination: destinationPath,
      });
      return true;
    } catch (error) {
      logger.warn("[CTRL_PROXY] Failed to copy prefetched APK", {
        error: errorMessage(error),
      });
      return false;
    }
  }

  /**
   * Consume only an already-completed prefetch. Unlike consumePrefetchedApk(),
   * this never waits for an in-progress network download.
   */
  private static async consumeCompletedPrefetchedApk(destinationPath: string): Promise<boolean> {
    if (!AndroidCtrlProxyManager.prefetchedApkPath) {
      return false;
    }

    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(AndroidCtrlProxyManager.prefetchedApkPath, destinationPath);
      logger.info("[CTRL_PROXY] Copied completed prefetched APK", {
        source: AndroidCtrlProxyManager.prefetchedApkPath,
        destination: destinationPath,
      });
      return true;
    } catch (error) {
      logger.warn("[CTRL_PROXY] Failed to copy completed prefetched APK", {
        error: errorMessage(error),
      });
      return false;
    }
  }

  /**
   * Clean up the prefetched APK file
   */
  public static async cleanupPrefetchedApk(): Promise<void> {
    // Published cache assets are reusable across daemon lifecycles; only reset
    // process-local references here. Staging directories are cleaned by doPrefetch.
    const prefetchedApkPath = AndroidCtrlProxyManager.prefetchedApkPath;
    AndroidCtrlProxyManager.prefetchedApkPath = null;
    AndroidCtrlProxyManager.prefetchPromise = null;
    AndroidCtrlProxyManager.prefetchError = null;
    const prefetchDir = prefetchedApkPath && path.dirname(prefetchedApkPath);
    if (
      prefetchDir &&
      path.dirname(prefetchDir) === os.tmpdir() &&
      path.basename(prefetchDir).startsWith(AndroidCtrlProxyManager.PREFETCH_DIR_PREFIX)
    ) {
      try {
        await fs.rm(prefetchDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn("[CTRL_PROXY] Failed to clean up legacy prefetched APK", {
          error: errorMessage(error),
        });
      }
    }
  }

  public static setPrefetchCacheDirForTesting(cacheDir: string | null): void {
    AndroidCtrlProxyManager.prefetchCacheDirOverride = cacheDir;
  }

  /** Prefix shared by every prefetch scratch dir, including the `-upgrade-` variant. */
  private static readonly PREFETCH_DIR_PREFIX = "auto-mobile-prefetch-";
  /**
   * Only prefetch dirs older than this are swept, so an in-flight prefetch
   * (this process's or a concurrent one's) is never removed. Matches the
   * `-mmin +60` guard from the issue's workaround (#4334).
   */
  private static readonly STALE_PREFETCH_MAX_AGE_MS = 60 * 60 * 1000;

  /**
   * Best-effort startup sweep for orphaned `auto-mobile-prefetch-*` scratch
   * directories. Successful prefetched APKs are published outside their staging
   * directory into the reusable cache. A process that is SIGKILLed or crashes
   * can still leave its staging dir behind, so this reclaims those artifacts
   * without touching the published cache asset (#4334).
   */
  public static async sweepStalePrefetchDirsOnStartup(
    tempRoot: string = os.tmpdir(),
    timer: Timer = defaultTimer,
  ): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(tempRoot, { withFileTypes: true });
    } catch (error) {
      // A missing/unreadable temp root is expected on some hosts; nothing to sweep.
      logger.debug(`[CTRL_PROXY] Prefetch sweep skipped: cannot read ${tempRoot}: ${error}`);
      return;
    }

    const candidates = entries.filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(AndroidCtrlProxyManager.PREFETCH_DIR_PREFIX),
    );
    const now = timer.now();
    const deadline = now + STALE_PREFETCH_SWEEP_DEADLINE_MS;
    let reclaimed = 0;
    for (const [index, entry] of candidates.entries()) {
      if (timer.now() >= deadline) {
        AndroidCtrlProxyManager.logPrefetchSweepDeadline();
        return;
      }
      const dir = path.join(tempRoot, entry.name);
      const result = await AndroidCtrlProxyManager.reclaimStalePrefetchDir(
        dir,
        now,
        deadline,
        timer,
      );
      if (result === "deadline_exhausted") {
        AndroidCtrlProxyManager.logPrefetchSweepDeadline();
        return;
      }
      if (result !== "reclaimed") {
        continue;
      }
      reclaimed++;
      if (reclaimed === MAX_STALE_PREFETCH_DIRS_PER_STARTUP) {
        AndroidCtrlProxyManager.logSkippedPrefetchCandidates(candidates.length - index - 1);
        break;
      }
    }

    if (reclaimed > 0) {
      logger.info(`[CTRL_PROXY] Swept ${reclaimed} stale prefetch dir(s) from ${tempRoot}`);
    }
  }

  private static async reclaimStalePrefetchDir(
    dir: string,
    now: number,
    deadline: number,
    timer: Timer,
  ): Promise<"reclaimed" | "not_stale" | "deadline_exhausted"> {
    try {
      const stats = await fs.stat(dir);
      if (timer.now() >= deadline) {
        return "deadline_exhausted";
      }
      if (now - stats.mtimeMs < AndroidCtrlProxyManager.STALE_PREFETCH_MAX_AGE_MS) {
        return "not_stale";
      }
      await fs.rm(dir, { recursive: true, force: true });
      return "reclaimed";
    } catch (error) {
      // Per-entry best-effort: a concurrent process may remove the same dir,
      // or it may vanish mid-sweep. Skip it and keep going.
      logger.debug(`[CTRL_PROXY] Failed to inspect stale prefetch dir ${dir}: ${error}`);
      return "not_stale";
    }
  }

  private static logPrefetchSweepDeadline(): void {
    logger.warn(
      `[CTRL_PROXY] Prefetch sweep timed out after ${STALE_PREFETCH_SWEEP_DEADLINE_MS}ms ` +
        `while inspecting stale prefetch directories`,
    );
  }

  private static logSkippedPrefetchCandidates(skippedCandidateCount: number): void {
    if (skippedCandidateCount > 0) {
      logger.warn(
        `[CTRL_PROXY] Prefetch sweep skipped ${skippedCandidateCount} uninspected prefetch dir candidate(s) after ` +
          `reaching the ${MAX_STALE_PREFETCH_DIRS_PER_STARTUP}-directory startup cap`,
      );
    }
  }

  /**
   * Static APK integrity verification for prefetch
   */
  private static verifyApkIntegrityStatic(apkPath: string): void {
    try {
      const zip = new AdmZip(apkPath);
      const entries = zip.getEntries();
      const hasManifest = entries.some((entry) => entry.entryName === "AndroidManifest.xml");
      if (!hasManifest) {
        throw new Error("AndroidManifest.xml missing");
      }
    } catch (error) {
      throw new Error(`APK integrity check failed: ${errorMessage(error)}`);
    }
  }

  public static setExpectedChecksumForTesting(checksum: string | null): void {
    AndroidCtrlProxyManager.expectedChecksumOverride = checksum;
  }

  public static setAccessibilityDetectorForTesting(detector: AccessibilityDetector | null): void {
    AndroidCtrlProxyManager.accessibilityDetectorOverride = detector;
  }

  /** Override the Android-prerequisite gate for the prefetch (#4404). Null restores the default detector. */
  public static setAndroidPrerequisiteDetectorForTesting(
    detector: AndroidPrerequisiteDetector | null,
  ): void {
    AndroidCtrlProxyManager.androidPrerequisiteDetector =
      detector ?? new DefaultAndroidPrerequisiteDetector();
  }

  /** Override the downloader used by the static prefetch (#4404). Null restores the default. */
  public static setPrefetchFileDownloaderForTesting(downloader: FileDownloader | null): void {
    AndroidCtrlProxyManager.prefetchFileDownloaderOverride = downloader;
  }

  private getAccessibilityDetector(): AccessibilityDetector {
    return AndroidCtrlProxyManager.accessibilityDetectorOverride || accessibilityDetector;
  }

  /**
   * Clear the cached availability status.
   *
   * Issue #4192: this is the single choke point for "our cached view of the
   * accessibility service is stale". It also invalidates the AccessibilityDetector
   * cache, so `observe` cannot keep reporting the pre-mutation state. Every
   * mutation path (enable/disable/enableForUser, install/upgrade, setup reset)
   * routes through here — do not re-add per-call-site invalidation.
   */
  public clearAvailabilityCache(): void {
    this.clearServiceAvailabilityCache();
    this.cachedToggleCapabilities = null;
    this.cachedVersionCheck = null;
    logger.info("[CTRL_PROXY] Cleared all availability caches");
  }

  /**
   * Reset the setup state to allow a fresh setup attempt.
   * Call this when observe detects accessibilityState.enabled: false
   * to force a full re-setup on the next attempt.
   */
  public resetSetupState(): void {
    this.attemptedAutomatedSetup = false;
    this.clearAvailabilityCache();
    logger.info("[CTRL_PROXY] Reset setup state - next setup will be a full attempt");
  }

  /**
   * Check if Accessibility Service is installed on the device
   */
  async isInstalled(): Promise<boolean> {
    // Check cache first
    if (this.cachedInstallation && this.cachedInstallation.isInstalled) {
      const cacheAge = this.timer.now() - this.cachedInstallation.timestamp;
      if (cacheAge < AndroidCtrlProxyManager.STATUS_CACHE_TTL) {
        logger.debug(
          `[CTRL_PROXY] Using cached installation status (age: ${cacheAge}ms): ${this.cachedInstallation.isInstalled ? "installed" : "not installed"}`,
        );
        return this.cachedInstallation.isInstalled;
      } else {
        this.cachedInstallation = null;
      }
    }

    try {
      logger.debug("[CTRL_PROXY] Checking if accessibility service is installed");
      const result = await this.adb.executeCommand(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.PACKAGE}`,
        undefined,
        undefined,
        true,
      );
      const isInstalled = result.stdout.includes(AndroidCtrlProxyManager.PACKAGE);

      // Cache the result
      this.cachedInstallation = {
        isInstalled,
        timestamp: this.timer.now(),
      };

      logger.debug(
        `[CTRL_PROXY] Service installation status: ${isInstalled ? "installed" : "not installed"} (cached for ${AndroidCtrlProxyManager.STATUS_CACHE_TTL / 1000 / 60} minutes)`,
      );
      return isInstalled;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error checking installation status: ${error}`);
      return false;
    }
  }

  /**
   * Check if Accessibility Service is enabled as an input method
   */
  async isEnabled(): Promise<boolean> {
    // Check cache first
    if (this.cachedEnabled && this.cachedEnabled.isEnabled) {
      const cacheAge = this.timer.now() - this.cachedEnabled.timestamp;
      if (cacheAge < AndroidCtrlProxyManager.STATUS_CACHE_TTL) {
        logger.debug(
          `[CTRL_PROXY] Using cached enabled status (age: ${cacheAge}ms): ${this.cachedEnabled.isEnabled ? "enabled" : "disabled"}`,
        );
        return this.cachedEnabled.isEnabled;
      } else {
        this.cachedEnabled = null;
      }
    }

    try {
      logger.debug("[CTRL_PROXY] Checking if accessibility service is enabled");
      const result = await this.adb.executeCommand(
        "shell settings get secure enabled_accessibility_services",
      );
      const isEnabled = result.stdout.includes(AndroidCtrlProxyManager.PACKAGE);

      // Cache the result
      this.cachedEnabled = {
        isEnabled,
        timestamp: this.timer.now(),
      };

      logger.debug(
        `[CTRL_PROXY] Service enabled status: ${isEnabled ? "enabled" : "disabled"} (cached for ${AndroidCtrlProxyManager.STATUS_CACHE_TTL / 1000 / 60} minutes)`,
      );
      return isEnabled;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error checking enabled status: ${error}`);
      return false;
    }
  }

  /**
   * Check if Accessibility Service is enabled for a specific user profile
   * @param userId - The Android user ID to check (e.g., 10 for work profile)
   */
  async isEnabledForUser(userId: number): Promise<boolean> {
    try {
      logger.debug(`[CTRL_PROXY] Checking if accessibility service is enabled for user ${userId}`);
      const result = await this.adb.executeCommand(
        `shell settings --user ${userId} get secure enabled_accessibility_services`,
      );
      const isEnabled = result.stdout.includes(AndroidCtrlProxyManager.PACKAGE);
      logger.debug(
        `[CTRL_PROXY] Service enabled status for user ${userId}: ${isEnabled ? "enabled" : "disabled"}`,
      );
      return isEnabled;
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Error checking enabled status for user ${userId}: ${error}`);
      return false;
    }
  }

  /**
   * Check if the accessibility service is both installed and enabled
   * @returns Promise<boolean> - True if available for use, false otherwise
   */
  async isAvailable(): Promise<boolean> {
    const startTime = this.timer.now();

    // Check cache first
    if (this.cachedAvailability && this.cachedAvailability.isAvailable) {
      const cacheAge = this.timer.now() - this.cachedAvailability.timestamp;
      if (cacheAge < AndroidCtrlProxyManager.AVAILABILITY_CACHE_TTL) {
        logger.debug(
          `[CTRL_PROXY] Using cached overall availability (age: ${cacheAge}ms): ${this.cachedAvailability.isAvailable}`,
        );
        return this.cachedAvailability.isAvailable;
      } else {
        this.cachedAvailability = null;
      }
    }

    logger.debug(`[CTRL_PROXY] Checking availability (no cached result available)`);

    try {
      // Check installation and enabled status in parallel for better performance
      const [installed, enabled] = await Promise.all([this.isInstalled(), this.isEnabled()]);

      const available = installed && enabled;
      const duration = this.timer.now() - startTime;

      // Cache the result
      this.cachedAvailability = {
        isAvailable: available,
        timestamp: this.timer.now(),
      };

      logger.debug(
        `[CTRL_PROXY] Availability check completed in ${duration}ms - Available: ${available} (cached for ${AndroidCtrlProxyManager.AVAILABILITY_CACHE_TTL / 1000 / 60} minutes)`,
      );
      return available;
    } catch (error) {
      const duration = this.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Availability check failed after ${duration}ms: ${error}`);

      // Clear cache on error
      this.cachedAvailability = null;

      return false;
    }
  }

  /**
   * Get SHA256 of installed accessibility service APK.
   */
  async getInstalledApkSha256(): Promise<string | null> {
    const result = await this.getInstalledApkSha256WithDetails();
    return result.sha256;
  }

  /**
   * Check if installed APK SHA256 matches expected release checksum.
   */
  async isVersionCompatible(): Promise<boolean> {
    const expectedSha = this.getExpectedChecksum();
    if (expectedSha.length === 0) {
      logger.warn("[CTRL_PROXY] Version check skipped (no checksum provided)");
      return true;
    }

    const installedSha = await this.getInstalledApkSha256();
    if (!installedSha) {
      return false;
    }

    return installedSha.toLowerCase() === expectedSha.toLowerCase();
  }

  /**
   * Ensure installed accessibility service version matches expected checksum.
   */
  async ensureCompatibleVersion(
    options: AccessibilityVersionCheckOptions = {},
  ): Promise<AccessibilityVersionCheckResult> {
    const perf = createGlobalPerformanceTracker();

    // Fail closed before any readiness shortcut (skipped/acceptedPreinstalled) can
    // accept an unverifiable APK for an unknown explicit pin (#2746).
    this.assertPinnedVersionVerifiable();

    if (!options.bypassVersionCheckCache && !options.allowDownloadWhenInstalled) {
      const cachedResult = this.getCachedVersionCheckResult();
      if (cachedResult) {
        return cachedResult;
      }
    }

    this.clearServiceAvailabilityCache();
    perf.startOperation("uninstallLegacy");
    await this.uninstallLegacyPackageIfPresent();
    perf.endOperation("uninstallLegacy");

    const expectedSha = this.getExpectedChecksum();
    if (expectedSha.length === 0) {
      if (options.allowDownloadWhenInstalled) {
        logger.warn(
          "[CTRL_PROXY] Version checksum unavailable; explicit update will install APK without checksum comparison",
        );
      } else {
        return this.cacheVersionCheckResult({
          status: "skipped",
          expectedSha256: expectedSha,
        });
      }
    }

    perf.startOperation("checkInstalled");
    const isInstalled = await this.isInstalled();
    perf.endOperation("checkInstalled");

    if (
      isInstalled &&
      this.shouldSkipDownloadIfInstalled() &&
      !AndroidCtrlProxyManager.isKnownExplicitPinConfigured() &&
      !options.allowDownloadWhenInstalled
    ) {
      logger.warn("[CTRL_PROXY] Skipping APK download/version check (preinstalled APK allowed)");
      return this.cacheVersionCheckResult({
        status: "skipped",
        expectedSha256: expectedSha,
      });
    }

    const result: AccessibilityVersionCheckResult = {
      status: "compatible",
      expectedSha256: expectedSha,
    };

    let needsReinstallDueToUnknownSha = false;

    if (isInstalled) {
      perf.startOperation("getChecksum");
      const installedShaResult = await this.getInstalledApkSha256WithDetails();
      perf.endOperation("getChecksum");
      result.installedSha256 = installedShaResult.sha256;
      result.installedShaSource = installedShaResult.source;
      result.installedApkPath = installedShaResult.apkPath;

      const installedSha = installedShaResult.sha256;
      needsReinstallDueToUnknownSha = expectedSha.length > 0 && !installedSha;

      if (expectedSha.length > 0 && !installedSha && installedShaResult.error) {
        logger.warn("[CTRL_PROXY] Unable to determine installed APK checksum, forcing reinstall", {
          error: installedShaResult.error,
        });
      }

      if (
        expectedSha.length > 0 &&
        installedSha &&
        installedSha.toLowerCase() === expectedSha.toLowerCase()
      ) {
        return this.cacheVersionCheckResult(result);
      }

      if (
        expectedSha.length > 0 &&
        !options.allowDownloadWhenInstalled &&
        !this.getApkPathOverride()
      ) {
        const prefetchedUpgradeResult = await this.tryUpgradeFromCompletedPrefetch(result, perf);
        if (prefetchedUpgradeResult) {
          return this.cacheVersionCheckResult(prefetchedUpgradeResult);
        }

        if (AndroidCtrlProxyManager.isKnownExplicitPinConfigured()) {
          throw AndroidCtrlProxyManager.createKnownPinMismatchError(expectedSha, installedSha);
        }

        logger.warn(
          "[CTRL_PROXY] Installed APK SHA differs from expected release; accepting preinstalled CtrlProxy for nonblocking readiness",
          {
            expected: expectedSha,
            actual: installedSha,
          },
        );
        this.queueBackgroundApkRefresh();
        return this.cacheVersionCheckResult({
          ...result,
          status: "skipped",
          attemptedDownload: false,
          acceptedPreinstalled: true,
        });
      }

      if (needsReinstallDueToUnknownSha) {
        logger.warn("[CTRL_PROXY] Installed APK checksum unavailable, forcing reinstall");
      } else {
        logger.info("[CTRL_PROXY] Installed APK SHA mismatch, attempting upgrade", {
          expected: expectedSha,
          actual: installedSha,
        });
      }
    } else {
      logger.info("[CTRL_PROXY] Service not installed, downloading and installing");
    }

    let apkPath: string | null = null;
    try {
      result.attemptedDownload = true;
      perf.startOperation("downloadApk");
      apkPath = await this.downloadApk();
      perf.endOperation("downloadApk");

      return await this.installDownloadedApk(
        apkPath,
        result,
        isInstalled,
        needsReinstallDueToUnknownSha,
        perf,
      );
    } catch (error) {
      const message = errorMessage(error);
      const downloadUnavailable = this.isNetworkError(message);
      const failedResult: AccessibilityVersionCheckResult = {
        ...result,
        status: "failed",
        downloadUnavailable,
        error: downloadUnavailable
          ? "Unable to download the latest accessibility service APK while offline. Connect to the internet and retry."
          : message,
      };
      return options.allowDownloadWhenInstalled
        ? failedResult
        : this.cacheVersionCheckResult(failedResult);
    } finally {
      if (apkPath) {
        await this.cleanupApk(apkPath);
      }
    }
  }

  private async tryUpgradeFromCompletedPrefetch(
    result: AccessibilityVersionCheckResult,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult | null> {
    if (!AndroidCtrlProxyManager.prefetchedApkPath) {
      return null;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-prefetch-upgrade-"));
    const apkPath = path.join(tempDir, "control-proxy.apk");

    try {
      const usedPrefetch = await AndroidCtrlProxyManager.consumeCompletedPrefetchedApk(apkPath);
      if (!usedPrefetch) {
        return null;
      }

      const upgradeResult = await this.installDownloadedApk(
        apkPath,
        {
          ...result,
          attemptedDownload: false,
        },
        true,
        false,
        perf,
      );

      if (upgradeResult.status !== "failed") {
        return upgradeResult;
      }

      this.clearServiceAvailabilityCache();
      const stillInstalled = await this.isInstalled();
      if (!stillInstalled) {
        logger.warn(
          "[CTRL_PROXY] Completed prefetched APK install failed and existing CtrlProxy is no longer installed",
          {
            error:
              upgradeResult.error || upgradeResult.upgradeError || upgradeResult.reinstallError,
          },
        );
        return upgradeResult;
      }

      logger.warn(
        "[CTRL_PROXY] Completed prefetched APK install failed; verified existing CtrlProxy remains installed for readiness",
        {
          error: upgradeResult.error || upgradeResult.upgradeError || upgradeResult.reinstallError,
        },
      );
      if (AndroidCtrlProxyManager.isKnownExplicitPinConfigured()) {
        throw AndroidCtrlProxyManager.createKnownPinMismatchError(
          result.expectedSha256 ?? "",
          result.installedSha256,
        );
      }
      return {
        ...upgradeResult,
        status: "skipped",
        acceptedPreinstalled: true,
      };
    } finally {
      await this.cleanupApk(apkPath);
    }
  }

  private async installDownloadedApk(
    apkPath: string,
    result: AccessibilityVersionCheckResult,
    isInstalled: boolean,
    needsReinstallDueToUnknownSha: boolean,
    perf: PerformanceTracker,
  ): Promise<AccessibilityVersionCheckResult> {
    if (isInstalled && !needsReinstallDueToUnknownSha) {
      try {
        result.attemptedInstall = true;
        perf.startOperation("installApk");
        await this.adb.executeCommand(`install -r -d "${apkPath}"`);
        perf.endOperation("installApk");
        logger.info("[CTRL_PROXY] APK upgraded successfully");
        this.clearAvailabilityCache();
        return {
          ...result,
          status: "upgraded",
        };
      } catch (upgradeError) {
        perf.endOperation("installApk");
        const upgradeMessage = errorMessage(upgradeError);
        logger.warn("[CTRL_PROXY] Upgrade failed, attempting reinstall", { error: upgradeMessage });
        result.upgradeError = upgradeMessage;
      }
    }

    try {
      result.attemptedReinstall = true;
      if (isInstalled) {
        await this.adb.executeCommand(`shell pm uninstall ${AndroidCtrlProxyManager.PACKAGE}`);
      }
      perf.startOperation("installApk");
      await this.install(apkPath);
      perf.endOperation("installApk");
      await this.enable();
      logger.info(
        `[CTRL_PROXY] APK ${isInstalled ? "reinstalled" : "installed"} and service enabled`,
      );
      this.clearAvailabilityCache();
      return {
        ...result,
        status: isInstalled ? "reinstalled" : "installed",
      };
    } catch (reinstallError) {
      const reinstallMessage = errorMessage(reinstallError);
      logger.warn(`[CTRL_PROXY] APK reinstall failed: ${reinstallMessage}`, reinstallError);
      this.clearServiceAvailabilityCache();
      return {
        ...result,
        status: "failed",
        reinstallError: reinstallMessage,
      };
    }
  }

  /**
   * Download APK
   */
  async downloadApk(): Promise<string> {
    // Defense-in-depth for direct callers: fail closed on an unverifiable pin
    // before touching the filesystem or network (#2746).
    this.assertPinnedVersionVerifiable();
    const perf = createGlobalPerformanceTracker();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-"));
    const apkPath = path.join(tempDir, "control-proxy.apk");

    try {
      const overridePath = this.getApkPathOverride();
      perf.startOperation("httpDownload");
      if (overridePath) {
        logger.info("Using local accessibility service APK", { path: overridePath });
        const stats = await fs.stat(overridePath);
        if (!stats.isFile()) {
          throw new Error(`Accessibility APK override is not a file: ${overridePath}`);
        }
        await fs.copyFile(overridePath, apkPath);
      } else {
        // Try to use prefetched APK first (already downloaded and validated at server startup)
        const usedPrefetch = await AndroidCtrlProxyManager.consumePrefetchedApk(apkPath);
        if (usedPrefetch) {
          logger.info("Using prefetched accessibility service APK", { path: apkPath });
        } else {
          const apkUrl = resolveApkUrl();
          logger.info("Downloading APK", { url: apkUrl, destination: apkPath });
          await this.fileDownloader.download(apkUrl, apkPath);
        }
      }
      perf.endOperation("httpDownload");

      // Verify the file exists and has reasonable size (should be > 10KB)
      const stats = await fs.stat(apkPath);
      if (stats.size < 10000) {
        throw new Error(`Downloaded APK is too small (${stats.size} bytes), likely invalid`);
      }

      this.verifyApkIntegrity(apkPath);

      const expectedChecksum = this.getExpectedChecksum();
      // Perform checksum verification (only if checksum is provided)
      if (expectedChecksum.length > 0) {
        perf.startOperation("checksumVerify");
        const { checksum: actualChecksum, source } =
          await this.checksumCalculator.computeFileSha256(apkPath);
        const normalizedActual = actualChecksum.toLowerCase();
        const normalizedExpected = expectedChecksum.toLowerCase();

        if (normalizedActual !== normalizedExpected) {
          logger.warn("APK checksum verification failed", {
            expected: normalizedExpected,
            actual: normalizedActual,
          });
          throw new Error(
            `APK checksum verification failed. Expected: ${normalizedExpected}, Got: ${normalizedActual}`,
          );
        }

        logger.info("APK checksum verified successfully", { checksum: normalizedActual, source });
        perf.endOperation("checksumVerify");
      } else {
        logger.warn("APK checksum verification SKIPPED - no checksum provided (development mode)", {
          apkUrl: resolveApkUrl(),
        });
      }

      logger.info("APK downloaded successfully", { path: apkPath, size: stats.size });
      return apkPath;
    } catch (error) {
      // Clean up failed download
      try {
        await this.cleanupApk(apkPath);
      } catch (cleanupError) {
        // Failed-download cleanup is best-effort; the original download error still surfaces below.
        logger.debug(
          `[CTRL_PROXY] Failed to clean up incomplete APK download: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }

      throw new Error(`Failed to download APK: ${errorMessage(error)}`);
    }
  }

  private verifyApkIntegrity(apkPath: string): void {
    try {
      const zip = new AdmZip(apkPath);
      const entries = zip.getEntries();
      const hasManifest = entries.some((entry) => entry.entryName === "AndroidManifest.xml");
      if (!hasManifest) {
        throw new Error("AndroidManifest.xml missing");
      }
    } catch (error) {
      throw new Error(`APK integrity check failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Uninstall the legacy accessibility service package if still present on the device.
   * This cleans up the old package name left over from before the rename to CtrlProxy.
   */
  private async uninstallLegacyPackageIfPresent(): Promise<void> {
    try {
      const result = await this.adb.executeCommand(
        `shell pm list packages | grep ${AndroidCtrlProxyManager.LEGACY_PACKAGE}`,
        undefined,
        undefined,
        true,
      );
      if (!result.stdout.includes(AndroidCtrlProxyManager.LEGACY_PACKAGE)) {
        return;
      }
      logger.info(
        `[CTRL_PROXY] Found legacy package ${AndroidCtrlProxyManager.LEGACY_PACKAGE}, uninstalling`,
      );
      await this.adb.executeCommand(`shell pm uninstall ${AndroidCtrlProxyManager.LEGACY_PACKAGE}`);
      logger.info(`[CTRL_PROXY] Legacy package uninstalled`);
    } catch (error) {
      logger.warn(`[CTRL_PROXY] Failed to check/uninstall legacy package: ${error}`);
    }
  }

  /**
   * Install APK
   */
  async install(apkPath: string): Promise<void> {
    try {
      logger.info("Installing APK", { path: apkPath });

      const result = await this.adb.executeCommand(`install "${apkPath}"`);
      const resultString = result.toString().toLowerCase();

      if (resultString.includes("failure") || resultString.includes("error")) {
        throw new Error(`Installation failed: ${result.toString()}`);
      }

      if (!resultString.includes("success")) {
        logger.warn("Installation result unclear", { result: result.toString() });
      }

      logger.info("APK installed successfully");
    } catch (error) {
      throw new Error(`Failed to install APK: ${errorMessage(error)}`);
    }
  }

  /**
   * Enable Accessibility Service via adb settings commands
   */
  async enableViaSettings(): Promise<void> {
    // Check if settings toggle is supported
    const capabilities = await this.getToggleCapabilities();
    if (!capabilities.supportsSettingsToggle) {
      const errorMsg = `Settings-based accessibility toggle is not supported on this device. ${capabilities.reason || ""}`;
      logger.error("[CTRL_PROXY] " + errorMsg, { capabilities });
      throw new Error(errorMsg);
    }

    try {
      logger.info("Enabling Accessibility Service via settings commands");
      const perf = createGlobalPerformanceTracker();

      // Get current enabled services
      perf.startOperation("readCurrentServices");
      const result = await this.adb.executeCommand(
        "shell settings get secure enabled_accessibility_services",
      );
      perf.endOperation("readCurrentServices");
      let currentServices = result.stdout.trim();

      // Issue #384: preserve existing enabled services; settings may return "null" or empty.
      if (currentServices === "null" || currentServices === "") {
        currentServices = "";
      }

      // Build the service component name
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Check if service is already in the list
      perf.startOperation("writeServiceEnabled");
      if (currentServices.includes(serviceComponent)) {
        logger.info("Accessibility Service is already enabled");
      } else {
        // Issue #384: append to the colon-separated list instead of overwriting other services.
        const updatedServices = currentServices
          ? `${currentServices}:${serviceComponent}`
          : serviceComponent;

        // Set updated list
        await this.adb.executeCommand(
          `shell settings put secure enabled_accessibility_services "${updatedServices}"`,
        );
        logger.info("Added AutoMobile service to enabled_accessibility_services");
      }

      // Enable accessibility globally
      await this.adb.executeCommand("shell settings put secure accessibility_enabled 1");
      perf.endOperation("writeServiceEnabled");
      logger.info("Accessibility Service enabled successfully via settings");
    } catch (error) {
      const errorMsg = errorMessage(error);
      const errorLower = errorMsg.toLowerCase();

      // Categorize error types for clearer feedback
      if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
        throw new Error(
          `Permission denied while enabling Accessibility Service. The device may require root access, device owner status, or special shell permissions. Original error: ${errorMsg}`,
        );
      } else if (
        errorLower.includes("device not found") ||
        errorLower.includes("no devices") ||
        errorLower.includes("offline")
      ) {
        throw new Error(
          `Device connection lost while enabling Accessibility Service. Ensure the device is connected and adb is responsive. Original error: ${errorMsg}`,
        );
      } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
        throw new Error(
          `Timeout while enabling Accessibility Service. The device may be unresponsive. Original error: ${errorMsg}`,
        );
      } else {
        throw new Error(
          `Failed to enable Accessibility Service via settings. This may indicate an ADB communication issue or device state problem. Original error: ${errorMsg}`,
        );
      }
    } finally {
      // Issue #4192: clear in `finally` so success, early return, and a partial
      // failure all reconcile our cached view. clearAvailabilityCache also
      // invalidates the accessibility detector cache, so observe cannot keep
      // reporting the pre-mutation state.
      this.clearAvailabilityCache();
    }
  }

  /**
   * Disable Accessibility Service via adb settings commands
   */
  async disableViaSettings(): Promise<void> {
    // Check if settings toggle is supported
    const capabilities = await this.getToggleCapabilities();
    if (!capabilities.supportsSettingsToggle) {
      const errorMsg = `Settings-based accessibility toggle is not supported on this device. ${capabilities.reason || ""}`;
      logger.error("[CTRL_PROXY] " + errorMsg, { capabilities });
      throw new Error(errorMsg);
    }

    try {
      logger.info("Disabling Accessibility Service via settings commands");

      // Get current enabled services
      const result = await this.adb.executeCommand(
        "shell settings get secure enabled_accessibility_services",
      );
      const currentServices = result.stdout.trim();

      // Handle null or empty values
      if (currentServices === "null" || currentServices === "") {
        logger.info("No accessibility services enabled");
        return;
      }

      // Parse service list
      // Issue #384: remove only the AutoMobile entry and preserve all other enabled services.
      const serviceList = currentServices.split(":");

      // Remove AutoMobile service from list
      const filteredServices = serviceList.filter(
        (service) => !service.includes(AndroidCtrlProxyManager.PACKAGE),
      );

      // Check if service was in the list
      if (filteredServices.length === serviceList.length) {
        logger.info("Accessibility Service was not enabled");
      } else {
        // Set updated list
        const updatedServices = filteredServices.join(":");
        await this.adb.executeCommand(
          `shell settings put secure enabled_accessibility_services "${updatedServices}"`,
        );
        logger.info("Removed AutoMobile service from enabled_accessibility_services");

        // Conditionally disable accessibility if no other services remain
        // Edge case: a trailing separator can yield [""]; treat it as no remaining services.
        if (
          filteredServices.length === 0 ||
          (filteredServices.length === 1 && filteredServices[0] === "")
        ) {
          await this.adb.executeCommand("shell settings put secure accessibility_enabled 0");
          logger.info("Disabled accessibility globally (no other services remain)");
        }
      }

      logger.info("Accessibility Service disabled successfully via settings");
    } catch (error) {
      const errorMsg = errorMessage(error);
      const errorLower = errorMsg.toLowerCase();

      // Categorize error types for clearer feedback
      if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
        throw new Error(
          `Permission denied while disabling Accessibility Service. The device may require root access, device owner status, or special shell permissions. Original error: ${errorMsg}`,
        );
      } else if (
        errorLower.includes("device not found") ||
        errorLower.includes("no devices") ||
        errorLower.includes("offline")
      ) {
        throw new Error(
          `Device connection lost while disabling Accessibility Service. Ensure the device is connected and adb is responsive. Original error: ${errorMsg}`,
        );
      } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
        throw new Error(
          `Timeout while disabling Accessibility Service. The device may be unresponsive. Original error: ${errorMsg}`,
        );
      } else {
        throw new Error(
          `Failed to disable Accessibility Service via settings. This may indicate an ADB communication issue or device state problem. Original error: ${errorMsg}`,
        );
      }
    } finally {
      // Issue #4192: the disable path previously invalidated nothing, so observe
      // kept reporting accessibility as available after the service was torn down.
      // `finally` covers the early return (no services enabled) and a partial
      // failure as well as the success path.
      this.clearAvailabilityCache();
    }
  }

  /**
   * Enable Accessibility Service
   */
  async enable(): Promise<void> {
    return this.enableViaSettings();
  }

  /**
   * Enable Accessibility Service for a specific user profile via adb settings commands
   * @param userId - The Android user ID to enable for (e.g., 10 for work profile)
   */
  async enableForUser(userId: number): Promise<void> {
    // Check if settings toggle is supported
    const capabilities = await this.getToggleCapabilities();
    if (!capabilities.supportsSettingsToggle) {
      const errorMsg = `Settings-based accessibility toggle is not supported on this device. ${capabilities.reason || ""}`;
      logger.error("[CTRL_PROXY] " + errorMsg, { capabilities });
      throw new Error(errorMsg);
    }

    try {
      logger.info(
        `[CTRL_PROXY] Enabling Accessibility Service via settings commands for user ${userId}`,
      );

      // Get current enabled services for this user
      const result = await this.adb.executeCommand(
        `shell settings --user ${userId} get secure enabled_accessibility_services`,
      );
      let currentServices = result.stdout.trim();

      // Issue #384: preserve existing enabled services; settings may return "null" or empty.
      if (currentServices === "null" || currentServices === "") {
        currentServices = "";
      }

      // Build the service component name
      const serviceComponent = `${AndroidCtrlProxyManager.PACKAGE}/${AndroidCtrlProxyManager.PACKAGE}.CtrlProxy`;

      // Check if service is already in the list
      if (currentServices.includes(serviceComponent)) {
        logger.info(`[CTRL_PROXY] Accessibility Service is already enabled for user ${userId}`);
      } else {
        // Issue #384: append to the colon-separated list instead of overwriting other services.
        const updatedServices = currentServices
          ? `${currentServices}:${serviceComponent}`
          : serviceComponent;

        // Set updated list
        await this.adb.executeCommand(
          `shell settings --user ${userId} put secure enabled_accessibility_services "${updatedServices}"`,
        );
        logger.info(
          `[CTRL_PROXY] Added AutoMobile service to enabled_accessibility_services for user ${userId}`,
        );
      }

      // Enable accessibility globally for this user
      await this.adb.executeCommand(
        `shell settings --user ${userId} put secure accessibility_enabled 1`,
      );
      logger.info(
        `[CTRL_PROXY] Accessibility Service enabled successfully via settings for user ${userId}`,
      );
    } catch (error) {
      const errorMsg = errorMessage(error);
      const errorLower = errorMsg.toLowerCase();

      // Categorize error types for clearer feedback
      if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
        throw new Error(
          `Permission denied while enabling Accessibility Service for user ${userId}. The device may require root access, device owner status, or special shell permissions. Original error: ${errorMsg}`,
        );
      } else if (
        errorLower.includes("device not found") ||
        errorLower.includes("no devices") ||
        errorLower.includes("offline")
      ) {
        throw new Error(
          `Device connection lost while enabling Accessibility Service for user ${userId}. Ensure the device is connected and adb is responsive. Original error: ${errorMsg}`,
        );
      } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
        throw new Error(
          `Timeout while enabling Accessibility Service for user ${userId}. The device may be unresponsive. Original error: ${errorMsg}`,
        );
      } else {
        throw new Error(
          `Failed to enable Accessibility Service via settings for user ${userId}. This may indicate an ADB communication issue or device state problem. Original error: ${errorMsg}`,
        );
      }
    } finally {
      // Issue #4192: main-user cache only (per-user caching not implemented);
      // `finally` also covers the partial-failure path.
      this.clearAvailabilityCache();
    }
  }

  /**
   * Clean up temporary APK file
   */
  async cleanupApk(apkPath: string): Promise<void> {
    try {
      const tempRoot = path.resolve(os.tmpdir());
      const tempDir = path.resolve(path.dirname(apkPath));
      const tempBase = path.basename(tempDir);
      const relativeTempDir = path.relative(tempRoot, tempDir);
      const isTempDir =
        Boolean(relativeTempDir) &&
        !relativeTempDir.startsWith("..") &&
        !path.isAbsolute(relativeTempDir) &&
        tempBase.startsWith("auto-mobile-");

      await fs.rm(apkPath, { force: true });
      if (isTempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
        logger.info("Temporary APK directory cleaned up", { path: tempDir });
      } else {
        logger.info("Temporary APK file cleaned up", { path: apkPath });
      }
    } catch (error) {
      logger.warn("Failed to clean up temporary APK file", {
        path: apkPath,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Complete setup process for Accessibility Service
   */
  async setup(
    force: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<ProxySetupResult> {
    perf.serial("a11yServiceSetup");
    let apkPath: string | null = null;

    if (this.attemptedAutomatedSetup) {
      try {
        const [installed, enabled] = await perf.track("recheckStatus", async () => {
          return Promise.all([this.isInstalled(), this.isEnabled()]);
        });
        if (installed && enabled) {
          perf.end();
          return {
            success: true,
            message: "Accessibility Service was already installed and has been activated",
            perfTiming: perf.getTimings(),
          };
        }
      } catch (error) {
        logger.warn(`[CTRL_PROXY] Failed to re-check service status: ${error}`);
      }
      perf.end();
      return {
        success: false,
        message: "Setup already attempted",
        perfTiming: perf.getTimings(),
      };
    }

    try {
      const compatibilityResult = await perf.track("ensureCompatibleVersion", () =>
        this.ensureCompatibleVersion(),
      );
      if (compatibilityResult.status === "failed") {
        perf.end();
        return {
          success: false,
          message: "Failed to ensure compatible Accessibility Service version",
          error:
            compatibilityResult.error ||
            compatibilityResult.upgradeError ||
            compatibilityResult.reinstallError,
          perfTiming: perf.getTimings(),
        };
      }
      if (
        compatibilityResult.status === "upgraded" ||
        compatibilityResult.status === "installed" ||
        compatibilityResult.status === "reinstalled"
      ) {
        perf.end();
        return {
          success: true,
          message: "Accessibility Service upgraded to a compatible version",
          perfTiming: perf.getTimings(),
        };
      }

      // Check if already installed and setup (unless force is true)
      const isAlreadyInstalled = await perf.track("checkInstalled", () => this.isInstalled());
      const isAlreadyEnabled = await perf.track("checkEnabled", () => this.isEnabled());
      if (!force && isAlreadyInstalled && isAlreadyEnabled) {
        perf.end();
        return {
          success: true,
          message: "Accessibility Service was already installed and has been activated",
          perfTiming: perf.getTimings(),
        };
      }

      this.attemptedAutomatedSetup = true;
      // Download APK if not installed or force is true
      if (force || !isAlreadyInstalled) {
        apkPath = await perf.track("downloadApk", () => this.downloadApk());
        await perf.track("installApk", () => this.install(apkPath!));
      }

      // Enable if not enabled
      if (!isAlreadyEnabled) {
        await perf.track("enableService", () => this.enable());
      }

      perf.end();
      return {
        success: true,
        message: "Accessibility Service installed and activated successfully",
        perfTiming: perf.getTimings(),
      };
    } catch (error) {
      const errorMsg = errorMessage(error);
      const errorLower = errorMsg.toLowerCase();

      // Provide categorized error messages for better debugging
      let message = "Failed to setup Accessibility Service";
      if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
        message = "Failed to setup Accessibility Service due to permission error";
      } else if (
        errorLower.includes("device not found") ||
        errorLower.includes("no devices") ||
        errorLower.includes("offline")
      ) {
        message = "Failed to setup Accessibility Service due to device connection issue";
      } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
        message = "Failed to setup Accessibility Service due to timeout";
      } else if (
        errorLower.includes("download") ||
        errorLower.includes("network") ||
        errorLower.includes("unreachable")
      ) {
        message = "Failed to setup Accessibility Service due to network/download error";
      } else if (errorLower.includes("not supported")) {
        message =
          "Failed to setup Accessibility Service - settings toggle not supported on this device";
      } else if (errorLower.includes("installation failed") || errorLower.includes("install")) {
        message = "Failed to setup Accessibility Service due to APK installation error";
      }

      perf.end();
      return {
        success: false,
        message,
        error: errorMsg,
        perfTiming: perf.getTimings(),
      };
    } finally {
      // Clean up APK file if it was downloaded
      if (apkPath) {
        await this.cleanupApk(apkPath);
      }
    }
  }

  /**
   * Detect if device is an emulator or physical device
   * Returns [isEmulator, hadError] tuple to track detection success
   */
  private async isEmulator(): Promise<[boolean, boolean]> {
    try {
      const result = await this.adb.executeCommand(
        "shell getprop ro.kernel.qemu",
        undefined,
        undefined,
        true,
      );
      const qemuProp = result.stdout.trim();
      // ro.kernel.qemu is "1" on emulators, empty or "0" on physical devices
      if (qemuProp === "1") {
        return [true, false];
      }

      // Fallback: check ro.product.model for common emulator strings
      const modelResult = await this.adb.executeCommand(
        "shell getprop ro.product.model",
        undefined,
        undefined,
        true,
      );
      const model = modelResult.stdout.trim().toLowerCase();
      return [model.includes("emulator") || model.includes("sdk"), false];
    } catch (error) {
      logger.warn("[CTRL_PROXY] Error detecting device type", { error });
      // Default to physical device on error (more conservative), but mark as errored
      return [false, true];
    }
  }

  /**
   * Get device API level
   * Returns [apiLevel, hadError] tuple to track detection success
   */
  private async getApiLevel(): Promise<[number | null, boolean]> {
    try {
      const result = await this.adb.executeCommand(
        "shell getprop ro.build.version.sdk",
        undefined,
        undefined,
        true,
      );
      const apiLevel = parseInt(result.stdout.trim(), 10);
      return [isNaN(apiLevel) ? null : apiLevel, false];
    } catch (error) {
      logger.warn("[CTRL_PROXY] Error getting API level", { error });
      return [null, true];
    }
  }

  /**
   * Check if the device supports programmatic accessibility toggle via settings commands
   * @returns Promise<boolean> - True if settings-based toggle is supported
   */
  async canUseSettingsToggle(): Promise<boolean> {
    const capabilities = await this.getToggleCapabilities();
    return capabilities.supportsSettingsToggle;
  }

  /**
   * Get detailed capabilities for accessibility service toggling
   * @returns Promise<ToggleCapabilities> - Capability information including device type and reason if unavailable
   */
  async getToggleCapabilities(): Promise<ToggleCapabilities> {
    // Return cached result if available
    if (this.cachedToggleCapabilities) {
      logger.info("[CTRL_PROXY] Using cached toggle capabilities");
      return this.cachedToggleCapabilities;
    }

    logger.info("[CTRL_PROXY] Detecting toggle capabilities");

    const [isEmulator, emulatorDetectionError] = await this.isEmulator();
    const [apiLevel, apiLevelDetectionError] = await this.getApiLevel();
    const deviceType = isEmulator ? "emulator" : "physical";

    let supportsSettingsToggle = false;
    let reason: string | undefined;

    // If we had detection errors, don't make definitive claims about support
    const hadDetectionError = emulatorDetectionError || apiLevelDetectionError;

    if (hadDetectionError) {
      supportsSettingsToggle = false;
      reason = "Unable to detect device capabilities due to transient error. Retry may succeed.";
      logger.warn("[CTRL_PROXY] Detection error - not caching result", {
        emulatorDetectionError,
        apiLevelDetectionError,
      });
    } else if (isEmulator) {
      // Emulators generally support settings-based toggle
      supportsSettingsToggle = true;
      logger.info("[CTRL_PROXY] Emulator detected - settings toggle supported");
    } else {
      // Physical devices may require special permissions
      supportsSettingsToggle = false;
      reason =
        "Physical devices may require root, device owner status, or special shell permissions for programmatic accessibility toggle";
      logger.info("[CTRL_PROXY] Physical device detected - settings toggle may not be supported", {
        reason,
      });
    }

    // Additional API level checks could be added here if needed
    if (!hadDetectionError && apiLevel !== null && apiLevel < 16) {
      supportsSettingsToggle = false;
      reason = `API level ${apiLevel} is too old (requires API 16+)`;
      logger.warn("[CTRL_PROXY] API level too old for settings toggle", { apiLevel });
    }

    const capabilities: ToggleCapabilities = {
      supportsSettingsToggle,
      deviceType,
      apiLevel,
      reason,
    };

    // Only cache if we successfully detected capabilities without errors
    // This prevents transient errors from creating sticky false negatives
    if (!hadDetectionError) {
      this.cachedToggleCapabilities = capabilities;
      logger.info("[CTRL_PROXY] Toggle capabilities detected and cached", capabilities);
    } else {
      logger.info(
        "[CTRL_PROXY] Toggle capabilities detected but not cached due to detection errors",
        capabilities,
      );
    }

    return capabilities;
  }

  private async getInstalledApkSha256WithDetails(): Promise<InstalledApkSha256Result> {
    const apkPath = await this.getInstalledApkPath();
    if (!apkPath) {
      return {
        sha256: null,
        source: "none",
        error: "Installed APK path not found",
      };
    }

    try {
      const shaResult = await this.adb.executeCommand(`shell sha256sum "${apkPath}"`);
      const sha256 = shaResult.stdout.trim().split(/\s+/)[0];
      if (sha256) {
        return {
          sha256,
          source: "device",
          apkPath,
        };
      }
    } catch (error) {
      logger.warn("[CTRL_PROXY] sha256sum unavailable or failed, falling back to host hash", {
        error: errorMessage(error),
      });
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-apk-"));
    const safeDeviceId = (this.device.deviceId || "device").replace(/[^a-zA-Z0-9_.-]/g, "_");
    const localApkPath = path.join(tempDir, `control-proxy-installed-${safeDeviceId}.apk`);

    try {
      await this.adb.executeCommand(`pull "${apkPath}" "${localApkPath}"`);
      const apkBuffer = await fs.readFile(localApkPath);
      const sha256 = crypto.createHash("sha256").update(apkBuffer).digest("hex");
      return {
        sha256,
        source: "host",
        apkPath,
      };
    } catch (error) {
      logger.warn("[CTRL_PROXY] Failed to compute installed APK hash via host fallback", {
        error: errorMessage(error),
      });
      return {
        sha256: null,
        source: "none",
        apkPath,
        error: errorMessage(error),
      };
    } finally {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        // Temp-dir cleanup is best-effort; checksum fallback already completed or returned.
        logger.debug(
          `[CTRL_PROXY] Failed to remove temporary APK hash directory: ${errorMessage(cleanupError)}`,
          cleanupError,
        );
      }
    }
  }

  private async getInstalledApkPath(): Promise<string | null> {
    try {
      const pathResult = await this.adb.executeCommand(
        `shell pm path ${AndroidCtrlProxyManager.PACKAGE}`,
        undefined,
        undefined,
        true,
      );
      const line = pathResult.stdout
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("package:"));

      if (!line) {
        return null;
      }

      return line.replace("package:", "").trim() || null;
    } catch (error) {
      logger.warn("[CTRL_PROXY] Failed to resolve installed APK path", {
        error: errorMessage(error),
      });
      return null;
    }
  }

  private getExpectedChecksum(): string {
    if (this.shouldSkipChecksum()) {
      return "";
    }
    return AndroidCtrlProxyManager.expectedChecksumOverride ?? resolveApkChecksum();
  }

  /**
   * Fail closed when a concrete `AUTOMOBILE_VERSION` is pinned to a version absent
   * from the baked checksum registry: the APK cannot be integrity-verified, so
   * silently downloading it — or accepting an already-installed APK of unknown
   * provenance — defeats the point of pinning (#2746). `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM`
   * (or a local APK path override) is the explicit escape hatch.
   */
  private assertPinnedVersionVerifiable(): void {
    if (AndroidCtrlProxyManager.isPinnedVersionUnverifiable()) {
      throw new ActionableError(
        `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the AutoMobile release ` +
          `checksum registry, so the CtrlProxy APK cannot be integrity-verified. ` +
          `Pin a released version, or set AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1 to override.`,
      );
    }
  }

  private getCachedVersionCheckResult(): AccessibilityVersionCheckResult | null {
    if (!this.cachedVersionCheck) {
      return null;
    }

    const cacheAge = this.timer.now() - this.cachedVersionCheck.timestamp;
    if (cacheAge >= AndroidCtrlProxyManager.VERSION_CHECK_CACHE_TTL) {
      this.cachedVersionCheck = null;
      return null;
    }

    logger.debug(
      `[CTRL_PROXY] Using cached version check result (age: ${cacheAge}ms): ${this.cachedVersionCheck.result.status}`,
    );
    return { ...this.cachedVersionCheck.result };
  }

  private cacheVersionCheckResult(
    result: AccessibilityVersionCheckResult,
  ): AccessibilityVersionCheckResult {
    this.cachedVersionCheck = {
      result: { ...result },
      timestamp: this.timer.now(),
    };
    return result;
  }

  private clearServiceAvailabilityCache(): void {
    this.cachedAvailability = null;
    this.cachedInstallation = null;
    this.cachedEnabled = null;
    // Issue #4192: the detector answers "is accessibility available on this device"
    // from its own cache, so it goes stale for exactly the same reasons these fields
    // do. Invalidating here keeps the two views from diverging silently.
    this.getAccessibilityDetector().invalidateCache(this.device.deviceId);
  }

  private queueBackgroundApkRefresh(): void {
    if (this.fileDownloader !== AndroidCtrlProxyManager.defaultFileDownloader) {
      return;
    }
    void AndroidCtrlProxyManager.prefetchApk();
  }

  private isNetworkError(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("could not resolve host") ||
      normalized.includes("failed to connect") ||
      normalized.includes("network is unreachable") ||
      normalized.includes("connection timed out") ||
      normalized.includes("timed out") ||
      normalized.includes("name lookup timed out") ||
      normalized.includes("temporary failure in name resolution") ||
      normalized.includes("enotfound") ||
      normalized.includes("econnrefused") ||
      normalized.includes("ehostunreach") ||
      normalized.includes("enetunreach") ||
      normalized.includes("etimedout")
    );
  }

  private getApkPathOverride(): string | null {
    const override = process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH;
    if (!override) {
      return null;
    }
    const trimmed = override.trim();
    return trimmed.length > 0 ? resolvePathFromDaemonLaunchWorkingDirectory(trimmed) : null;
  }

  private shouldSkipChecksum(): boolean {
    return AndroidCtrlProxyManager.isChecksumSkipConfigured();
  }

  /**
   * Env-only view of the checksum-skip escape hatches, usable from the static
   * prefetch path (which has no instance). Mirrors {@link shouldSkipChecksum}.
   */
  private static isChecksumSkipConfigured(): boolean {
    // @deprecated AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK - use AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM instead
    const explicitSkip =
      process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM ??
      process.env.AUTO_MOBILE_ACCESSIBILITY_SERVICE_SHA_SKIP_CHECK;
    if (explicitSkip && (explicitSkip === "1" || explicitSkip.toLowerCase() === "true")) {
      return true;
    }
    const apkPathOverride = process.env.AUTOMOBILE_CTRL_PROXY_APK_PATH?.trim();
    return Boolean(apkPathOverride && apkPathOverride.length > 0);
  }

  /**
   * Single source of truth for the fail-closed decision: `AUTOMOBILE_VERSION` names
   * a concrete version absent from the checksum registry, with no escape hatch set,
   * so the APK cannot be integrity-verified (#2746). Consumed by the download/readiness
   * guards, the startup prefetch, `doctor`, and the booted-device compatibility check
   * so they can't drift apart.
   */
  static isPinnedVersionUnverifiable(): boolean {
    if (AndroidCtrlProxyManager.expectedChecksumOverride !== null) {
      return false;
    }
    if (AndroidCtrlProxyManager.isChecksumSkipConfigured()) {
      return false;
    }
    return isExplicitPin() && !isPinnedVersionKnown();
  }

  private static isKnownExplicitPinConfigured(): boolean {
    if (AndroidCtrlProxyManager.isChecksumSkipConfigured()) {
      return false;
    }
    return isExplicitPin() && isPinnedVersionKnown();
  }

  private static createKnownPinMismatchError(
    expectedSha: string,
    installedSha: string | null | undefined,
  ): ActionableError {
    return new ActionableError(
      `Installed CtrlProxy APK SHA differs from expected release checksum for ` +
        `AUTOMOBILE_VERSION=${resolvePinnedVersion()}. Expected: ${expectedSha}, Got: ${installedSha ?? "unknown"}. ` +
        `Install the pinned CtrlProxy APK, restart with a matching daemon, or set ` +
        `AUTOMOBILE_SKIP_ACCESSIBILITY_CHECKSUM=1 to override.`,
    );
  }

  private shouldSkipDownloadIfInstalled(): boolean {
    const skipEnv = process.env.AUTOMOBILE_SKIP_ACCESSIBILITY_DOWNLOAD_IF_INSTALLED;
    return Boolean(skipEnv && (skipEnv === "1" || skipEnv.toLowerCase() === "true"));
  }
}
