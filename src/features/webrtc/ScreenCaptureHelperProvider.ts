import * as fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePinnedVersion,
  resolveScreenCaptureHelperChecksum,
  resolveScreenCaptureHelperUrl,
  SCREEN_CAPTURE_HELPER_FILENAME,
} from "../../constants/release";
import { ActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { ensureSecureTempDirSync, getTempDir } from "../../utils/tempDir";

/**
 * Owner read/write/execute only. Unlike the jar (0o600), the helper is an
 * executable that must be runnable by its owner; 0o700 keeps it non-readable to
 * other users while still executable, matching the 0o700 cache dir.
 */
const SECURE_EXEC_MODE = 0o700;
/** Owner read/write only, for the non-executable metadata sidecar. */
const SECURE_FILE_MODE = 0o600;
/** Owner read/write/execute only, matching the auto-mobile secure-dir convention. */
const SECURE_DIR_MODE = 0o700;
/** Subdirectory under the auto-mobile base dir that holds the cached helper. */
const CACHE_SUBDIR = "screen-capture-helper";

/** Fixed on-disk name of the cached helper executable. */
export const SCREEN_CAPTURE_HELPER_CACHE_FILENAME = SCREEN_CAPTURE_HELPER_FILENAME;

/** Metadata sidecar describing the currently-cached helper. */
export const SCREEN_CAPTURE_HELPER_METADATA_FILENAME = "screen-capture-helper.json";

export interface ScreenCaptureHelperMetadata {
  version: string;
  sha256: string;
  /** Byte size of the cached helper; a cheap tamper/truncation signal on cache hits. */
  size: number;
  downloadedAt: number;
}

export interface ScreenCaptureHelperProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  /** Persistent cache directory. Defaults to `~/.auto-mobile/screen-capture-helper`. */
  cacheDir?: string;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
}

/**
 * Client-side delivery of the prebuilt iOS `screen-capture-helper` (issue
 * #4392). Fetches the universal helper from GitHub releases, sha256-verifies it,
 * marks it executable, and caches it persistently at
 * `~/.auto-mobile/screen-capture-helper/` so a normal macOS install resolves it
 * without a local `swift build`, and repeat starts pay no download latency.
 *
 * Reuses the shared `DefaultFileDownloader` + `DefaultChecksumCalculator`
 * primitives (same as the CtrlProxy APK and video-server jar paths). Resolution
 * precedence and the env override are layered on top in `ensureIosScreenCaptureHelper`
 * (IosH264Source); this class owns only the cached-or-download-and-verify
 * mechanism and its single-flight guard.
 */
export class ScreenCaptureHelperProvider {
  private static instance: ScreenCaptureHelperProvider | null = null;
  private static expectedChecksumOverride: string | null = null;

  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly cacheDir: string;
  private readonly usesDefaultCacheDir: boolean;
  private readonly timer: Timer;
  private readonly env: NodeJS.ProcessEnv;

  /** Single-flight guard: concurrent ensure() calls share one download. */
  private inFlight: Promise<string | null> | null = null;

  constructor(deps: ScreenCaptureHelperProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.timer = deps.timer ?? defaultTimer;
    this.env = deps.env ?? process.env;
    this.usesDefaultCacheDir = deps.cacheDir === undefined;
    // Anchor on the shared auto-mobile base-dir resolver so the AUTOMOBILE_DATA_DIR
    // override (and the bunx-temp-dir avoidance, #2724) apply to the helper cache too.
    this.cacheDir = deps.cacheDir ?? getTempDir(CACHE_SUBDIR);
  }

  public static getInstance(): ScreenCaptureHelperProvider {
    if (ScreenCaptureHelperProvider.instance === null) {
      ScreenCaptureHelperProvider.instance = new ScreenCaptureHelperProvider();
    }
    return ScreenCaptureHelperProvider.instance;
  }

  /** Reset the singleton + testing overrides (for unit tests). */
  public static resetInstances(): void {
    ScreenCaptureHelperProvider.instance = null;
    ScreenCaptureHelperProvider.expectedChecksumOverride = null;
  }

  /**
   * Force the expected sha256 for tests, bypassing the registry resolver.
   * Mirrors `VideoServerJarProvider.setExpectedChecksumForTesting`.
   */
  public static setExpectedChecksumForTesting(checksum: string | null): void {
    ScreenCaptureHelperProvider.expectedChecksumOverride = checksum;
  }

  private get cachedHelperPath(): string {
    return path.join(this.cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME);
  }

  private get metadataPath(): string {
    return path.join(this.cacheDir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME);
  }

  private expectedChecksum(): string {
    return ScreenCaptureHelperProvider.expectedChecksumOverride ?? resolveScreenCaptureHelperChecksum(this.env);
  }

  /**
   * Resolve a verified helper path from the persistent cache or a fresh download.
   *
   * - Returns the cached/downloaded path when the expected checksum is known and
   *   verification succeeds.
   * - Returns `null` when the expected checksum is unknown (empty) — the helper
   *   cannot be integrity-verified, so the caller degrades to the env override /
   *   local Swift build (the network is never touched in this case).
   * - Throws when a downloaded helper fails sha256 (corruption/tampering must
   *   never be silently cached).
   *
   * Single-flight: concurrent callers share one in-flight download.
   */
  public async ensure(): Promise<string | null> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    this.inFlight = this.doEnsure().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doEnsure(): Promise<string | null> {
    const expected = this.expectedChecksum();
    if (expected.length === 0) {
      logger.info(
        "[SCREEN_CAPTURE_HELPER] Expected checksum unknown for the pinned version; returning null " +
        "without touching the network (helper is integrity-unverifiable)"
      );
      return null;
    }

    const cached = await this.tryCache(expected);
    if (cached) {
      logger.info("[SCREEN_CAPTURE_HELPER] Reusing verified cached helper", { path: cached });
      return cached;
    }

    return this.download(expected);
  }

  /**
   * Return the cached helper path iff the sidecar's recorded sha matches the
   * expected sha and the on-disk file still matches the recorded size. The
   * helper was sha256-verified before it was atomically renamed into place, so a
   * cache hit trusts the sidecar and uses a cheap `stat` size compare as the
   * truncation/tamper signal rather than re-hashing on the hot stream-start path.
   */
  private async tryCache(expected: string): Promise<string | null> {
    let metadata: ScreenCaptureHelperMetadata;
    try {
      metadata = JSON.parse(await fs.readFile(this.metadataPath, "utf8")) as ScreenCaptureHelperMetadata;
    } catch (error) {
      // No/invalid metadata sidecar is the normal cold-cache case, not an error.
      logger.debug(`[SCREEN_CAPTURE_HELPER] No usable cache metadata (cache miss): ${error}`);
      return null;
    }

    if (metadata.sha256.toLowerCase() !== expected.toLowerCase()) {
      return null;
    }

    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(this.cachedHelperPath);
    } catch (error) {
      // Metadata present but the helper file is gone — treat as a cache miss.
      logger.debug(`[SCREEN_CAPTURE_HELPER] Cached helper file missing despite metadata: ${error}`);
      return null;
    }

    if (stats.size !== metadata.size) {
      logger.warn("[SCREEN_CAPTURE_HELPER] Cached helper size differs from sidecar; will re-download", {
        expected: metadata.size,
        actual: stats.size,
      });
      return null;
    }

    return this.cachedHelperPath;
  }

  /**
   * Ensure the cache directory exists with owner-only (0o700) permissions, and
   * return its path. The default location goes through the shared
   * `ensureSecureTempDirSync` helper (same posture as the jar cache, #2724).
   */
  private async ensureSecureCacheDir(): Promise<string> {
    if (this.usesDefaultCacheDir) {
      return ensureSecureTempDirSync(CACHE_SUBDIR);
    }
    await fs.mkdir(this.cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    return this.cacheDir;
  }

  /** Download to a temp file, verify, mark executable, then atomically move into the cache. */
  private async download(expected: string): Promise<string> {
    const url = resolveScreenCaptureHelperUrl(this.env);
    const dir = await this.ensureSecureCacheDir();
    const helperPath = path.join(dir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME);
    const tempPath = `${helperPath}.download`;

    logger.info("[SCREEN_CAPTURE_HELPER] Downloading prebuilt helper", { url, destination: tempPath });
    try {
      await this.downloader.download(url, tempPath);

      const { checksum: actual } = await this.checksumCalculator.computeFileSha256(tempPath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        // A downloaded helper that does not match its pinned checksum is
        // corrupted or tampered — an actionable failure surfaced to the caller,
        // never silently cached.
        throw new ActionableError(
          `screen-capture-helper checksum verification failed. Expected: ${expected}, Got: ${actual}. ` +
          "The downloaded helper does not match the pinned release checksum; " +
          "this indicates a corrupted or tampered download and is never silently accepted."
        );
      }

      // Mark executable BEFORE renaming into place: the cached file is spawned
      // directly, and npm/curl do not preserve an executable bit.
      await fs.chmod(tempPath, SECURE_EXEC_MODE);
      const { size } = await fs.stat(tempPath);
      await fs.rename(tempPath, helperPath);
      await this.writeMetadata(dir, actual, size);
      logger.info("[SCREEN_CAPTURE_HELPER] Downloaded, verified, and cached helper", { path: helperPath, sha256: actual });
      return helperPath;
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async writeMetadata(dir: string, sha256: string, size: number): Promise<void> {
    const metadata: ScreenCaptureHelperMetadata = {
      version: resolvePinnedVersion(this.env),
      sha256,
      size,
      downloadedAt: this.timer.now(),
    };
    await fs.writeFile(
      path.join(dir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME),
      JSON.stringify(metadata, null, 2),
      { encoding: "utf8", mode: SECURE_FILE_MODE }
    );
  }
}
