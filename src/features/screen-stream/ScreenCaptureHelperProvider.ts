import { errorMessage } from "../../utils/describeUnknownError";
import AdmZip from "adm-zip";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePinnedVersion,
  resolveScreenCaptureHelperChecksum,
  resolveScreenCaptureHelperUrl,
  SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME as RELEASE_SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME,
} from "../../constants/release";
import { ActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { logger } from "../../utils/logger";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { ensureSecureTempDirSync, getTempDir } from "../../utils/tempDir";

const CACHE_SUBDIR = "screen-capture-helper";
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const EXECUTABLE_MODE = 0o700;
export const SCREEN_CAPTURE_HELPER_DOWNLOAD_TIMEOUT_MS = 30_000;

export const SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME =
  RELEASE_SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME;
export const SCREEN_CAPTURE_HELPER_CACHE_FILENAME = "screen-capture-helper";
export const SCREEN_CAPTURE_HELPER_METADATA_FILENAME = "screen-capture-helper.json";

export interface ScreenCaptureHelperMetadata {
  version: string;
  sha256: string;
  size: number;
  downloadedAt: number;
}

export interface ScreenCaptureHelperProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  cacheDir?: string;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
  expectedChecksum?: string;
  releaseUrl?: string;
  downloadTimeoutMs?: number;
  /** Test seam: Windows does not expose POSIX executable mode bits. */
  platform?: NodeJS.Platform;
}

/**
 * Delivers the signed macOS capture helper from a checksum-pinned GitHub Release.
 * Source builds are intentionally not part of this production resolution path.
 */
export class ScreenCaptureHelperProvider {
  private static instance: ScreenCaptureHelperProvider | null = null;

  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly cacheDir: string;
  private readonly usesDefaultCacheDir: boolean;
  private readonly timer: Timer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly expectedChecksumOverride?: string;
  private readonly releaseUrlOverride?: string;
  private readonly downloadTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private inFlight: Promise<string | null> | null = null;

  constructor(deps: ScreenCaptureHelperProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.cacheDir = deps.cacheDir ?? getTempDir(CACHE_SUBDIR);
    this.usesDefaultCacheDir = deps.cacheDir === undefined;
    this.timer = deps.timer ?? defaultTimer;
    this.env = deps.env ?? process.env;
    this.expectedChecksumOverride = deps.expectedChecksum;
    this.releaseUrlOverride = deps.releaseUrl;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? SCREEN_CAPTURE_HELPER_DOWNLOAD_TIMEOUT_MS;
    this.platform = deps.platform ?? process.platform;
  }

  static getInstance(): ScreenCaptureHelperProvider {
    ScreenCaptureHelperProvider.instance ??= new ScreenCaptureHelperProvider();
    return ScreenCaptureHelperProvider.instance;
  }

  static resetInstances(): void {
    ScreenCaptureHelperProvider.instance = null;
  }

  async ensure(): Promise<string | null> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doEnsure().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doEnsure(): Promise<string | null> {
    const expected = this.expectedChecksumOverride ?? resolveScreenCaptureHelperChecksum(this.env);
    if (expected.length === 0) {
      logger.info(
        "[SCREEN_CAPTURE_HELPER] Expected checksum unknown for the pinned version; " +
          "no release helper can be trusted.",
      );
      return null;
    }

    const cached = await this.tryCache(expected);
    if (cached) {
      logger.info("[SCREEN_CAPTURE_HELPER] Reusing verified release helper", { path: cached });
      return cached;
    }

    return this.download(expected);
  }

  private get helperPath(): string {
    return path.join(this.cacheDir, SCREEN_CAPTURE_HELPER_CACHE_FILENAME);
  }

  private get metadataPath(): string {
    return path.join(this.cacheDir, SCREEN_CAPTURE_HELPER_METADATA_FILENAME);
  }

  private async tryCache(expected: string): Promise<string | null> {
    let metadata: ScreenCaptureHelperMetadata;
    try {
      metadata = JSON.parse(
        await fs.readFile(this.metadataPath, "utf8"),
      ) as ScreenCaptureHelperMetadata;
    } catch (error) {
      logger.debug("[SCREEN_CAPTURE_HELPER] No usable cached helper metadata", {
        error: errorMessage(error),
      });
      return null;
    }
    if (metadata.sha256.toLowerCase() !== expected.toLowerCase()) {
      return null;
    }

    try {
      const stats = await fs.stat(this.helperPath);
      if (
        !stats.isFile() ||
        stats.size !== metadata.size ||
        (this.platform !== "win32" && (stats.mode & 0o111) === 0)
      ) {
        return null;
      }
    } catch (error) {
      logger.debug("[SCREEN_CAPTURE_HELPER] No usable cached helper executable", {
        error: errorMessage(error),
      });
      return null;
    }
    return this.helperPath;
  }

  private async ensureSecureCacheDir(): Promise<string> {
    if (this.usesDefaultCacheDir) {
      return ensureSecureTempDirSync(CACHE_SUBDIR);
    }
    await fs.mkdir(this.cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    return this.cacheDir;
  }

  private async download(expected: string): Promise<string> {
    const dir = await this.ensureSecureCacheDir();
    const archivePath = path.join(dir, `${SCREEN_CAPTURE_HELPER_ARCHIVE_FILENAME}.download`);
    const extractedPath = path.join(dir, `${SCREEN_CAPTURE_HELPER_CACHE_FILENAME}.download`);
    const controller = new AbortController();
    const timeout = this.timer.setTimeout(() => controller.abort(), this.downloadTimeoutMs);

    try {
      await this.downloader.download(
        this.releaseUrlOverride ?? resolveScreenCaptureHelperUrl(this.env),
        archivePath,
        controller.signal,
      );
      await fs.chmod(archivePath, SECURE_FILE_MODE);
      const { checksum: actual } = await this.checksumCalculator.computeFileSha256(archivePath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new ActionableError(
          `screen-capture-helper checksum verification failed. Expected: ${expected}, Got: ${actual}. ` +
            "The downloaded release asset is corrupted or tampered.",
        );
      }

      await fs.writeFile(extractedPath, extractHelper(archivePath), { mode: EXECUTABLE_MODE });
      await fs.chmod(extractedPath, EXECUTABLE_MODE);
      const { size } = await fs.stat(extractedPath);
      await fs.rename(extractedPath, this.helperPath);
      await fs.writeFile(
        this.metadataPath,
        JSON.stringify(
          {
            version: resolvePinnedVersion(this.env),
            sha256: actual,
            size,
            downloadedAt: this.timer.now(),
          } satisfies ScreenCaptureHelperMetadata,
          null,
          2,
        ),
        { encoding: "utf8", mode: SECURE_FILE_MODE },
      );
      logger.info("[SCREEN_CAPTURE_HELPER] Downloaded and verified release helper", {
        path: this.helperPath,
        sha256: actual,
      });
      return this.helperPath;
    } catch (error) {
      await Promise.all([
        fs.rm(archivePath, { force: true }),
        fs.rm(extractedPath, { force: true }),
      ]);
      if (controller.signal.aborted) {
        throw new ActionableError(
          `Timed out downloading screen-capture-helper after ${this.downloadTimeoutMs}ms. ` +
            "Check GitHub Release asset availability or set AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER for local development.",
        );
      }
      throw error;
    } finally {
      this.timer.clearTimeout(timeout);
    }
  }
}

function extractHelper(archivePath: string): Buffer {
  let archive: AdmZip;
  try {
    archive = new AdmZip(archivePath);
  } catch (error) {
    throw new ActionableError(
      `screen-capture-helper release asset is not a valid zip archive: ${errorMessage(error)}`,
    );
  }
  const entries = archive
    .getEntries()
    .filter(
      (candidate) =>
        !candidate.isDirectory &&
        path.posix.basename(candidate.entryName) === SCREEN_CAPTURE_HELPER_CACHE_FILENAME,
    );
  if (entries.length !== 1) {
    throw new ActionableError(
      `screen-capture-helper release asset must contain exactly one ${SCREEN_CAPTURE_HELPER_CACHE_FILENAME}.`,
    );
  }
  try {
    return entries[0].getData();
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw new ActionableError(
      `Unable to extract screen-capture-helper release asset: ${errorMessage(error)}`,
    );
  }
}
