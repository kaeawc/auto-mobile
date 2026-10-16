import AdmZip from "adm-zip";
import crypto from "crypto";
import os from "os";
import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { getTempDir } from "../utils/tempDir";
import { sortedReaddirEntries } from "../utils/io";
import type { FileDownloader } from "../utils/FileDownloader";
import type { ChecksumCalculator } from "../utils/ChecksumCalculator";
import type { AndroidPrerequisiteDetector } from "../utils/android-cmdline-tools/AndroidPrerequisiteDetector";

export const MAX_STALE_PREFETCH_DIRS_PER_STARTUP = 20;
export const STALE_PREFETCH_SWEEP_DEADLINE_MS = 5_000;

/**
 * Process-wide CtrlProxy APK prefetch: one background download shared by every per-device manager,
 * plus the startup sweep of orphaned staging directories.
 */
export interface CtrlProxyApkPrefetcher {
  /** Start (or join) the background prefetch; resolves to the cached APK path or null. */
  prefetch(): Promise<string | null>;
  /** The prefetched APK path, waiting for an in-flight prefetch. Null when none succeeded. */
  getPrefetchedPath(): Promise<string | null>;
  /** Copy the prefetched APK to `destinationPath`, waiting for an in-flight prefetch. */
  consume(destinationPath: string): Promise<boolean>;
  /** Copy only an already-completed prefetch; never waits on the network. */
  consumeCompleted(destinationPath: string): Promise<boolean>;
  /** The completed prefetch path, if any, without waiting. */
  completedPath(): string | null;
  /** Adopt a completed path (or clear it). Seam for tests that stage an APK without a download. */
  adoptCompletedPath(apkPath: string | null): void;
  /** Reset process-local references; published cache assets stay for the next daemon. */
  cleanup(): Promise<void>;
  /** Reclaim orphaned `auto-mobile-prefetch-*` scratch directories (#4334). */
  sweepStaleDirs(tempRoot?: string, timer?: Timer): Promise<void>;
}

export interface CtrlProxyApkPrefetcherDeps {
  downloader: () => FileDownloader;
  checksumCalculator: () => ChecksumCalculator;
  prerequisiteDetector: () => AndroidPrerequisiteDetector;
  /** Cache directory override; null uses the temp-dir default. */
  cacheDirOverride: () => string | null;
  /** Expected checksum override; null resolves the release checksum. */
  expectedChecksumOverride: () => string | null;
  isPinnedVersionUnverifiable: () => boolean;
  describePinnedVersion: () => string;
  resolveApkUrl: () => string;
  resolveApkChecksum: () => string;
  /** Local APK path override (AUTOMOBILE_CTRL_PROXY_APK_PATH); when set, prefetch is skipped. */
  localApkPathOverride: () => string | undefined;
}

export class DefaultCtrlProxyApkPrefetcher implements CtrlProxyApkPrefetcher {
  private prefetchPromise: Promise<string | null> | null = null;
  private prefetchedApkPath: string | null = null;
  private prefetchError: Error | null = null;

  constructor(private readonly deps: CtrlProxyApkPrefetcherDeps) {}

  completedPath(): string | null {
    return this.prefetchedApkPath;
  }

  adoptCompletedPath(apkPath: string | null): void {
    this.prefetchedApkPath = apkPath;
  }

  prefetch(): Promise<string | null> {
    // Skip if already prefetching or prefetched
    if (this.prefetchPromise !== null) {
      logger.info("[CTRL_PROXY] APK prefetch already initiated, skipping");
      return this.prefetchPromise;
    }

    // Skip if there's an override path (local APK)
    const overridePath = this.deps.localApkPathOverride()?.trim();
    if (overridePath && overridePath.length > 0) {
      logger.info("[CTRL_PROXY] Using local APK override, skipping prefetch");
      return Promise.resolve(null);
    }

    logger.info("[CTRL_PROXY] Starting APK prefetch");
    const startTime = defaultTimer.now();
    this.prefetchError = null;

    this.prefetchPromise = this.doPrefetch()
      .then((apkPath) => {
        const duration = defaultTimer.now() - startTime;
        if (apkPath) {
          this.prefetchedApkPath = apkPath;
          logger.info(`[CTRL_PROXY] APK prefetch completed in ${duration}ms`, { path: apkPath });
        }
        return apkPath;
      })
      .catch((error) => {
        const duration = defaultTimer.now() - startTime;
        this.prefetchError = error instanceof Error ? error : new Error(String(error));
        logger.warn(`[CTRL_PROXY] APK prefetch failed after ${duration}ms`, {
          error: this.prefetchError.message,
        });
        this.prefetchPromise = null;
        return null;
      });
    return this.prefetchPromise;
  }

  /**
   * Internal prefetch implementation
   */
  private async doPrefetch(): Promise<string | null> {
    // Skip cleanly in environments that cannot consume the APK. Without ADB (and
    // the SDK tooling behind it) no Android device work is possible, so there is
    // no reason to download and verify the APK during startup (#4404). Returning
    // null (not throwing) keeps the daemon healthy and non-Android workflows intact.
    if (!(await this.deps.prerequisiteDetector().hasAndroidPrerequisites())) {
      logger.info(
        "[CTRL_PROXY] Prefetch skipped: Android prerequisites (adb/SDK) not detected; " +
          "the APK is only needed for Android device work",
      );
      return null;
    }

    // Fail closed before touching the network: don't background-download and cache
    // an unverifiable APK for an unknown explicit pin (#2746). Skipping (not
    // throwing) keeps daemon startup alive; the install path still fails closed.
    if (this.deps.isPinnedVersionUnverifiable()) {
      logger.warn(
        `[CTRL_PROXY] Prefetch skipped: AUTOMOBILE_VERSION=${this.deps.describePinnedVersion()} is not in the ` +
          `release checksum registry, so the APK cannot be integrity-verified`,
      );
      return null;
    }

    const apkUrl = this.deps.resolveApkUrl();
    const expectedChecksum = this.deps.expectedChecksumOverride() ?? this.deps.resolveApkChecksum();
    const cacheKey = crypto
      .createHash("sha256")
      .update(`${apkUrl}\n${expectedChecksum.toLowerCase()}`)
      .digest("hex");
    const cachePath = path.join(
      this.deps.cacheDirOverride() ?? getTempDir("cache/ctrl-proxy"),
      `control-proxy-${cacheKey}.apk`,
    );
    const cacheDir = path.dirname(cachePath);

    await fs.mkdir(cacheDir, { recursive: true });
    await this.sweepStaleDirs(cacheDir);
    if (await this.isValidPrefetchCache(cachePath, expectedChecksum)) {
      logger.info("[CTRL_PROXY] Prefetch: reused cached APK", { path: cachePath });
      return cachePath;
    }

    const tempDir = await fs.mkdtemp(path.join(cacheDir, "auto-mobile-prefetch-"));
    const apkPath = path.join(tempDir, "control-proxy.apk");

    try {
      // Download the APK (URL honors AUTOMOBILE_VERSION + AUTOMOBILE_ASSET_BASE_URL)
      logger.info("[CTRL_PROXY] Prefetch: downloading APK", { url: apkUrl, destination: apkPath });
      const downloader = this.deps.downloader();
      await downloader.download(apkUrl, apkPath);

      const size = await this.verifyPrefetchedApk(apkPath, expectedChecksum);
      const publishedPath = await this.publishPrefetchedApk(apkPath, cachePath, expectedChecksum);
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

  private async verifyPrefetchedApk(apkPath: string, expectedChecksum: string): Promise<number> {
    const stats = await fs.stat(apkPath);
    if (stats.size < 10000) {
      throw new Error(`Prefetched APK is too small (${stats.size} bytes), likely invalid`);
    }
    this.verifyApkIntegrityStatic(apkPath);
    if (expectedChecksum.length === 0) {
      return stats.size;
    }
    const { checksum: actualChecksum } = await this.deps
      .checksumCalculator()
      .computeFileSha256(apkPath);
    if (actualChecksum.toLowerCase() !== expectedChecksum.toLowerCase()) {
      throw new Error(
        `APK checksum verification failed. Expected: ${expectedChecksum}, Got: ${actualChecksum}`,
      );
    }
    logger.info("[CTRL_PROXY] Prefetch: checksum verified", { checksum: actualChecksum });
    return stats.size;
  }

  private async publishPrefetchedApk(
    apkPath: string,
    cachePath: string,
    expectedChecksum: string,
  ): Promise<string> {
    try {
      await fs.rename(apkPath, cachePath);
      return cachePath;
    } catch (error) {
      // Another daemon can win publication while this download was in flight.
      if (await this.isValidPrefetchCache(cachePath, expectedChecksum)) {
        logger.info("[CTRL_PROXY] Prefetch: reused concurrently published APK", {
          path: cachePath,
        });
        return cachePath;
      }
      throw error;
    }
  }

  private async isValidPrefetchCache(
    cachePath: string,
    expectedChecksum: string,
  ): Promise<boolean> {
    try {
      const stats = await fs.stat(cachePath);
      if (stats.size < 10000) {
        throw new Error(`cached APK is too small (${stats.size} bytes)`);
      }
      this.verifyApkIntegrityStatic(cachePath);
      if (expectedChecksum.length > 0) {
        const { checksum } = await this.deps.checksumCalculator().computeFileSha256(cachePath);
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
  async getPrefetchedPath(): Promise<string | null> {
    if (this.prefetchPromise === null) {
      return null;
    }

    try {
      await this.prefetchPromise;
      return this.prefetchedApkPath;
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
  async consume(destinationPath: string): Promise<boolean> {
    const prefetchedPath = await this.getPrefetchedPath();
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
   * Consume only an already-completed prefetch. Unlike consume(),
   * this never waits for an in-progress network download.
   */
  async consumeCompleted(destinationPath: string): Promise<boolean> {
    if (!this.prefetchedApkPath) {
      return false;
    }

    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(this.prefetchedApkPath, destinationPath);
      logger.info("[CTRL_PROXY] Copied completed prefetched APK", {
        source: this.prefetchedApkPath,
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
  async cleanup(): Promise<void> {
    // Published cache assets are reusable across daemon lifecycles; only reset
    // process-local references here. Staging directories are cleaned by doPrefetch.
    const prefetchedApkPath = this.prefetchedApkPath;
    this.prefetchedApkPath = null;
    this.prefetchPromise = null;
    this.prefetchError = null;
    const prefetchDir = prefetchedApkPath && path.dirname(prefetchedApkPath);
    if (
      prefetchDir &&
      path.dirname(prefetchDir) === os.tmpdir() &&
      path.basename(prefetchDir).startsWith(this.PREFETCH_DIR_PREFIX)
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

  /** Prefix shared by every prefetch scratch dir, including the `-upgrade-` variant. */
  private readonly PREFETCH_DIR_PREFIX = "auto-mobile-prefetch-";
  /**
   * Only prefetch dirs older than this are swept, so an in-flight prefetch
   * (this process's or a concurrent one's) is never removed. Matches the
   * `-mmin +60` guard from the issue's workaround (#4334).
   */
  private readonly STALE_PREFETCH_MAX_AGE_MS = 60 * 60 * 1000;

  /**
   * Best-effort startup sweep for orphaned `auto-mobile-prefetch-*` scratch
   * directories. Successful prefetched APKs are published outside their staging
   * directory into the reusable cache. A process that is SIGKILLed or crashes
   * can still leave its staging dir behind, so this reclaims those artifacts
   * without touching the published cache asset (#4334).
   */
  async sweepStaleDirs(tempRoot: string = os.tmpdir(), timer: Timer = defaultTimer): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await sortedReaddirEntries(tempRoot);
    } catch (error) {
      // A missing/unreadable temp root is expected on some hosts; nothing to sweep.
      logger.debug(`[CTRL_PROXY] Prefetch sweep skipped: cannot read ${tempRoot}: ${error}`);
      return;
    }

    const candidates = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(this.PREFETCH_DIR_PREFIX),
    );
    const now = timer.now();
    const deadline = now + STALE_PREFETCH_SWEEP_DEADLINE_MS;
    let reclaimed = 0;
    for (const [index, entry] of candidates.entries()) {
      if (timer.now() >= deadline) {
        this.logPrefetchSweepDeadline();
        return;
      }
      const dir = path.join(tempRoot, entry.name);
      const result = await this.reclaimStalePrefetchDir(dir, now, deadline, timer);
      if (result === "deadline_exhausted") {
        this.logPrefetchSweepDeadline();
        return;
      }
      if (result !== "reclaimed") {
        continue;
      }
      reclaimed++;
      if (reclaimed === MAX_STALE_PREFETCH_DIRS_PER_STARTUP) {
        this.logSkippedPrefetchCandidates(candidates.length - index - 1);
        break;
      }
    }

    if (reclaimed > 0) {
      logger.info(`[CTRL_PROXY] Swept ${reclaimed} stale prefetch dir(s) from ${tempRoot}`);
    }
  }

  private async reclaimStalePrefetchDir(
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
      if (now - stats.mtimeMs < this.STALE_PREFETCH_MAX_AGE_MS) {
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

  private logPrefetchSweepDeadline(): void {
    logger.warn(
      `[CTRL_PROXY] Prefetch sweep timed out after ${STALE_PREFETCH_SWEEP_DEADLINE_MS}ms ` +
        `while inspecting stale prefetch directories`,
    );
  }

  private logSkippedPrefetchCandidates(skippedCandidateCount: number): void {
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
  private verifyApkIntegrityStatic(apkPath: string): void {
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
}
