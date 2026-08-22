import { errorMessage } from "../../utils/describeUnknownError";
import AdmZip from "adm-zip";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePinnedVersion,
  resolveVideoJarChecksum,
  resolveVideoJarUrl,
} from "../../constants/release";
import { ActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { ensureSecureTempDirSync, getTempDir } from "../../utils/tempDir";

/** Owner read/write only — cache files are per-user, never world-readable. */
const SECURE_FILE_MODE = 0o600;
/** Owner read/write/execute only, matching the auto-mobile secure-dir convention. */
const SECURE_DIR_MODE = 0o700;
/** Subdirectory under the auto-mobile base dir that holds the cached jar. */
const CACHE_SUBDIR = "video-server";

/** Fixed on-disk name of the cached persistent-encoder jar. */
export const VIDEO_SERVER_JAR_CACHE_FILENAME = "automobile-video.jar";

/** Metadata sidecar describing the currently-cached jar. */
export const VIDEO_SERVER_JAR_METADATA_FILENAME = "video-server-jar.json";

/** The DEX entry every valid `automobile-video.jar` must contain. */
const REQUIRED_DEX_ENTRY = "classes.dex";

export interface VideoServerJarMetadata {
  version: string;
  sha256: string;
  /** Byte size of the cached jar; a cheap tamper/truncation signal on cache hits. */
  size: number;
  downloadedAt: number;
}

/**
 * Host-known integrity descriptor of a local `automobile-video.jar` — the exact
 * bytes the host would push to `/data/local/tmp`. Used by the on-device jar-hash
 * mechanism (issue #4733) to decide whether the remote copy already matches
 * (skip the push) and to verify the remote bytes before `app_process` launch.
 */
export interface VideoServerJarIntegrity {
  /** Lowercase sha256 hex of the jar's bytes. */
  sha256: string;
  /** Byte size of the jar. */
  size: number;
}

/**
 * The single method {@link PersistentEncoderH264Source} needs to learn the
 * host-known expected sha256 + size of the jar it is about to push/launch. A
 * narrow interface (YAGNI) so tests can inject a fake without the download
 * machinery. The production default is {@link VideoServerJarProvider}, which
 * computes it with the same canonical {@link ChecksumCalculator} it uses to
 * verify downloads.
 */
export interface JarIntegrityProbe {
  computeLocalJarIntegrity(jarPath: string): Promise<VideoServerJarIntegrity>;
}

export interface VideoServerJarProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  /** Persistent cache directory. Defaults to `~/.auto-mobile/video-server`. */
  cacheDir?: string;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
}

/**
 * Client-side delivery of `automobile-video.jar` (the persistent on-device
 * H.264 encoder, #3776). Fetches the jar from GitHub releases, sha256-verifies
 * it, and caches it persistently at `~/.auto-mobile/video-server/` (hyphen —
 * the daemon's primary dir) so repeat starts pay no download latency.
 *
 * Reuses the shared `DefaultFileDownloader` + `DefaultChecksumCalculator`
 * primitives (same as the CtrlProxy APK path). Resolution precedence, env
 * flags, and fail-mode policy (mismatch-fatal vs degrade) are layered on top of
 * this provider in #3834; this class owns only the cached-or-download-and-verify
 * mechanism and its single-flight guard.
 */
export class VideoServerJarProvider {
  private static instance: VideoServerJarProvider | null = null;
  private static expectedChecksumOverride: string | null = null;

  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly cacheDir: string;
  private readonly usesDefaultCacheDir: boolean;
  private readonly timer: Timer;
  private readonly env: NodeJS.ProcessEnv;

  /** Single-flight guard: concurrent ensure() calls share one download. */
  private inFlight: Promise<string | null> | null = null;

  constructor(deps: VideoServerJarProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.timer = deps.timer ?? defaultTimer;
    this.env = deps.env ?? process.env;
    this.usesDefaultCacheDir = deps.cacheDir === undefined;
    // Anchor on the shared auto-mobile base-dir resolver so the AUTOMOBILE_DATA_DIR
    // override (and the bunx-temp-dir avoidance, #2724) apply to the jar cache too.
    this.cacheDir = deps.cacheDir ?? getTempDir(CACHE_SUBDIR);
  }

  public static getInstance(): VideoServerJarProvider {
    if (VideoServerJarProvider.instance === null) {
      VideoServerJarProvider.instance = new VideoServerJarProvider();
    }
    return VideoServerJarProvider.instance;
  }

  /** Reset the singleton + testing overrides (for unit tests). */
  public static resetInstances(): void {
    VideoServerJarProvider.instance = null;
    VideoServerJarProvider.expectedChecksumOverride = null;
  }

  /**
   * Force the expected sha256 for tests, bypassing the registry resolver.
   * Mirrors `AndroidCtrlProxyManager.setExpectedChecksumForTesting`.
   */
  public static setExpectedChecksumForTesting(checksum: string | null): void {
    VideoServerJarProvider.expectedChecksumOverride = checksum;
  }

  /**
   * Compute the host-known sha256 + size of a resolved local jar (issue #4733).
   * Works for any resolution source — cached download, `AUTOMOBILE_VIDEO_SERVER_JAR`
   * override, or local Gradle build — because it hashes the actual bytes that
   * will be pushed rather than trusting the release registry (which override/build
   * jars are never checked against). Reuses the same canonical
   * {@link ChecksumCalculator} the download path verifies with, so the "expected"
   * value is derived identically everywhere.
   */
  public async computeLocalJarIntegrity(jarPath: string): Promise<VideoServerJarIntegrity> {
    const [{ checksum }, stats] = await Promise.all([
      this.checksumCalculator.computeFileSha256(jarPath),
      fs.stat(jarPath),
    ]);
    return { sha256: checksum.toLowerCase(), size: stats.size };
  }

  private get cachedJarPath(): string {
    return path.join(this.cacheDir, VIDEO_SERVER_JAR_CACHE_FILENAME);
  }

  private get metadataPath(): string {
    return path.join(this.cacheDir, VIDEO_SERVER_JAR_METADATA_FILENAME);
  }

  private expectedChecksum(): string {
    return VideoServerJarProvider.expectedChecksumOverride ?? resolveVideoJarChecksum(this.env);
  }

  /**
   * Resolve a verified jar path from the persistent cache or a fresh download.
   *
   * - Returns the cached/downloaded path when the expected checksum is known and
   *   verification succeeds.
   * - Returns `null` when the expected checksum is unknown (empty) — the jar
   *   cannot be integrity-verified, so the caller degrades to `screenrecord`
   *   (the network is never touched in this case). #3834 layers the
   *   `REQUIRE`/`SKIP` env flags on top.
   * - Throws when a downloaded jar fails sha256 or the structural zip check
   *   (corruption/tampering must never be silently cached).
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
        "[VIDEO_JAR] Expected checksum unknown for the pinned version; returning null " +
        "without touching the network (jar is integrity-unverifiable)"
      );
      return null;
    }

    const cached = await this.tryCache(expected);
    if (cached) {
      logger.info("[VIDEO_JAR] Reusing verified cached jar", { path: cached });
      return cached;
    }

    return this.download(expected);
  }

  /**
   * Return the cached jar path iff the sidecar's recorded sha matches the
   * expected sha and the on-disk file still matches the recorded size.
   *
   * The jar was sha256- and structurally-verified before it was atomically
   * renamed into place at download time, so a cache hit does not re-hash or
   * re-parse the ~2.5 MB jar on the (hot) stream-start path — it trusts the
   * sidecar and uses a cheap `stat` size compare as the truncation/tamper
   * signal. A size mismatch (or missing file) falls through to a re-download,
   * which re-verifies from scratch.
   */
  private async tryCache(expected: string): Promise<string | null> {
    let metadata: VideoServerJarMetadata;
    try {
      metadata = JSON.parse(await fs.readFile(this.metadataPath, "utf8")) as VideoServerJarMetadata;
    } catch (error) {
      // No/invalid metadata sidecar is the normal cold-cache case, not an error.
      logger.debug(`[VIDEO_JAR] No usable cache metadata (cache miss): ${error}`);
      return null;
    }

    if (metadata.sha256.toLowerCase() !== expected.toLowerCase()) {
      return null;
    }

    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(this.cachedJarPath);
    } catch (error) {
      // Metadata present but the jar file is gone — treat as a cache miss.
      logger.debug(`[VIDEO_JAR] Cached jar file missing despite metadata: ${error}`);
      return null;
    }

    if (stats.size !== metadata.size) {
      logger.warn("[VIDEO_JAR] Cached jar size differs from sidecar; will re-download", {
        expected: metadata.size,
        actual: stats.size,
      });
      return null;
    }

    return this.cachedJarPath;
  }

  /**
   * Ensure the cache directory exists with owner-only (0o700) permissions, and
   * return its path. The jar + sidecar are per-user cache artifacts, so a fixed,
   * predictable filename inside a 0o700 directory is not exposed to other users
   * (same posture as the daemon's secure logs dir, #2724). The default location
   * goes through the shared `ensureSecureTempDirSync` helper.
   */
  private async ensureSecureCacheDir(): Promise<string> {
    if (this.usesDefaultCacheDir) {
      return ensureSecureTempDirSync(CACHE_SUBDIR);
    }
    await fs.mkdir(this.cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    return this.cacheDir;
  }

  /** Download to a temp file, verify, then atomically move into the cache. */
  private async download(expected: string): Promise<string> {
    const url = resolveVideoJarUrl(this.env);
    const dir = await this.ensureSecureCacheDir();
    const jarPath = path.join(dir, VIDEO_SERVER_JAR_CACHE_FILENAME);
    const tempPath = `${jarPath}.download`;

    logger.info("[VIDEO_JAR] Downloading persistent-encoder jar", { url, destination: tempPath });
    try {
      await this.downloader.download(url, tempPath);
      await fs.chmod(tempPath, SECURE_FILE_MODE);

      const { checksum: actual } = await this.checksumCalculator.computeFileSha256(tempPath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        // A downloaded jar that does not match its pinned checksum is corrupted
        // or tampered — an actionable failure surfaced to the caller, never
        // silently cached. (The caller decides degrade-vs-fatal for the *absent*
        // checksum case; a mismatch is unconditional.)
        throw new ActionableError(
          `video-server jar checksum verification failed. Expected: ${expected}, Got: ${actual}. ` +
          "The downloaded automobile-video.jar does not match the pinned release checksum; " +
          "this indicates a corrupted or tampered download and is never silently accepted."
        );
      }

      // Structural check catches a truncated file or an HTML error page saved
      // with a .jar name before it is ever pushed to a device.
      if (!this.hasClassesDex(tempPath)) {
        throw new ActionableError(
          "video-server jar is not a valid zip containing classes.dex (truncated or error-page download)."
        );
      }

      const { size } = await fs.stat(tempPath);
      await fs.rename(tempPath, jarPath);
      await this.writeMetadata(dir, actual, size);
      logger.info("[VIDEO_JAR] Downloaded, verified, and cached jar", { path: jarPath, sha256: actual });
      return jarPath;
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async writeMetadata(dir: string, sha256: string, size: number): Promise<void> {
    const metadata: VideoServerJarMetadata = {
      version: resolvePinnedVersion(this.env),
      sha256,
      size,
      downloadedAt: this.timer.now(),
    };
    await fs.writeFile(
      path.join(dir, VIDEO_SERVER_JAR_METADATA_FILENAME),
      JSON.stringify(metadata, null, 2),
      { encoding: "utf8", mode: SECURE_FILE_MODE }
    );
  }

  /** True iff `filePath` is a readable zip containing a `classes.dex` entry. */
  private hasClassesDex(filePath: string): boolean {
    try {
      const zip = new AdmZip(filePath);
      return zip.getEntries().some(entry => entry.entryName === REQUIRED_DEX_ENTRY);
    } catch (error) {
      // A truncated download / HTML error page is not a valid zip.
      logger.warn("[VIDEO_JAR] Structural check failed (not a valid zip)", {
        path: filePath,
        error: errorMessage(error),
      });
      return false;
    }
  }
}
