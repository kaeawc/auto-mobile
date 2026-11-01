import { errorMessage } from "../../utils/describeUnknownError";
import AdmZip from "adm-zip";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePinnedVersion,
  resolveAudioLoopbackHelperChecksum,
  resolveAudioLoopbackHelperUrl,
  AUDIO_LOOPBACK_HELPER_ARCHIVE_FILENAME as RELEASE_AUDIO_LOOPBACK_HELPER_ARCHIVE_FILENAME,
} from "../../constants/release";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { logger } from "../../utils/logger";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { VerifiedArtifactCache } from "../../utils/VerifiedArtifactCache";
import { ensureSecureTempDirSync, getTempDir } from "../../utils/tempDir";

const CACHE_SUBDIR = "audio-loopback-helper";
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const EXECUTABLE_MODE = 0o700;
export const AUDIO_LOOPBACK_HELPER_DOWNLOAD_TIMEOUT_MS = 30_000;

export const AUDIO_LOOPBACK_HELPER_ARCHIVE_FILENAME =
  RELEASE_AUDIO_LOOPBACK_HELPER_ARCHIVE_FILENAME;
export const AUDIO_LOOPBACK_HELPER_CACHE_FILENAME = "audio-loopback-helper";
export const AUDIO_LOOPBACK_HELPER_METADATA_FILENAME = "audio-loopback-helper.json";

export interface AudioLoopbackHelperMetadata {
  version: string;
  sha256: string;
  size: number;
  downloadedAt: number;
}

export interface AudioLoopbackHelperProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  cacheDir?: string;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
  expectedChecksum?: string;
  releaseUrl?: string;
  downloadTimeoutMs?: number;
  /** Host platform; injectable for macOS resolution tests without running the helper. */
  platform?: NodeJS.Platform;
}

/**
 * Delivers the signed macOS audio helper from a checksum-pinned GitHub Release.
 * Source builds are intentionally not part of this production resolution path.
 */
export class AudioLoopbackHelperProvider {
  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly cacheDir: string;
  private readonly usesDefaultCacheDir: boolean;
  private readonly timer: Timer;
  private readonly cache: VerifiedArtifactCache;
  private readonly env: NodeJS.ProcessEnv;
  private readonly expectedChecksumOverride?: string;
  private readonly releaseUrlOverride?: string;
  private readonly downloadTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private inFlight: Promise<string | null> | null = null;

  constructor(deps: AudioLoopbackHelperProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.cacheDir = deps.cacheDir ?? getTempDir(CACHE_SUBDIR);
    this.usesDefaultCacheDir = deps.cacheDir === undefined;
    this.timer = deps.timer ?? defaultTimer;
    this.cache = new VerifiedArtifactCache({
      downloader: this.downloader,
      checksumCalculator: this.checksumCalculator,
      timer: this.timer,
    });
    this.env = deps.env ?? process.env;
    this.expectedChecksumOverride = deps.expectedChecksum;
    this.releaseUrlOverride = deps.releaseUrl;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? AUDIO_LOOPBACK_HELPER_DOWNLOAD_TIMEOUT_MS;
    this.platform = deps.platform ?? process.platform;
  }

  async ensure(): Promise<string | null | undefined> {
    if (this.platform !== "darwin") {
      return undefined;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doEnsure()
      .catch((error: unknown) => {
        throw toActionableError(error, "Unable to resolve the released audio-loopback helper");
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async doEnsure(): Promise<string | null> {
    const expected = this.expectedChecksumOverride ?? resolveAudioLoopbackHelperChecksum(this.env);
    if (expected.length === 0) {
      logger.info(
        "[AUDIO_LOOPBACK_HELPER] Expected checksum unknown for the pinned version; " +
          "no release helper can be trusted.",
      );
      return null;
    }

    const cached = await this.tryCache(expected);
    if (cached) {
      logger.info("[AUDIO_LOOPBACK_HELPER] Reusing verified release helper", { path: cached });
      return cached;
    }

    return this.download(expected);
  }

  private get helperPath(): string {
    return path.join(this.cacheDir, AUDIO_LOOPBACK_HELPER_CACHE_FILENAME);
  }

  private get metadataPath(): string {
    return path.join(this.cacheDir, AUDIO_LOOPBACK_HELPER_METADATA_FILENAME);
  }

  private async tryCache(expected: string): Promise<string | null> {
    const hit = await this.cache.isCached<Pick<AudioLoopbackHelperMetadata, "sha256" | "size">>({
      label: "[AUDIO_LOOPBACK_HELPER]",
      subject: "helper",
      expectedSha256: expected,
      metadataPath: this.metadataPath,
      parseMetadata: (value) => (isCacheMetadata(value) ? value : null),
      verifyArtifact: (metadata) => this.isHelperExecutable(metadata.size),
    });
    return hit ? this.helperPath : null;
  }

  private async isHelperExecutable(size: number): Promise<boolean> {
    try {
      const stats = await fs.stat(this.helperPath);
      return !(
        !stats.isFile() ||
        stats.size !== size ||
        (process.platform !== "win32" && (stats.mode & 0o111) === 0)
      );
    } catch (error) {
      // A removed cache entry is expected and can be downloaded again.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        logger.debug("[AUDIO_LOOPBACK_HELPER] No cached helper executable");
      } else {
        logger.warn("[AUDIO_LOOPBACK_HELPER] Unable to inspect cached helper", error);
      }
      return false;
    }
  }

  private async ensureSecureCacheDir(): Promise<string> {
    if (this.usesDefaultCacheDir) {
      return ensureSecureTempDirSync(CACHE_SUBDIR);
    }
    await fs.mkdir(this.cacheDir, { recursive: true, mode: SECURE_DIR_MODE });
    await fs.chmod(this.cacheDir, SECURE_DIR_MODE);
    return this.cacheDir;
  }

  private async download(expected: string): Promise<string> {
    const dir = await this.ensureSecureCacheDir();
    const archivePath = path.join(dir, `${AUDIO_LOOPBACK_HELPER_ARCHIVE_FILENAME}.download`);
    const extractedPath = path.join(dir, `${AUDIO_LOOPBACK_HELPER_CACHE_FILENAME}.download`);

    await this.cache.fetch({
      label: "[AUDIO_LOOPBACK_HELPER]",
      expectedSha256: expected,
      url: this.releaseUrlOverride ?? resolveAudioLoopbackHelperUrl(this.env),
      archivePath,
      metadataPath: this.metadataPath,
      metadataMode: SECURE_FILE_MODE,
      downloadTimeoutMs: this.downloadTimeoutMs,
      afterDownload: (downloaded) => fs.chmod(downloaded, SECURE_FILE_MODE),
      mismatchError: (want, actual) =>
        new ActionableError(
          `audio-loopback-helper checksum verification failed. Expected: ${want}, Got: ${actual}. ` +
            "The downloaded release asset is corrupted or tampered.",
        ),
      timeoutError: () =>
        new ActionableError(
          `Timed out downloading audio-loopback-helper after ${this.downloadTimeoutMs}ms. ` +
            "Check GitHub Release asset availability or set AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER for local development.",
        ),
      publish: async (downloaded, sha256) => {
        await fs.writeFile(extractedPath, extractHelper(downloaded), { mode: EXECUTABLE_MODE });
        await fs.chmod(extractedPath, EXECUTABLE_MODE);
        const { size } = await fs.stat(extractedPath);
        await fs.rename(extractedPath, this.helperPath);
        logger.info("[AUDIO_LOOPBACK_HELPER] Downloaded and verified release helper", {
          path: this.helperPath,
          sha256,
        });
        return {
          version: resolvePinnedVersion(this.env),
          sha256: sha256 ?? expected,
          size,
          downloadedAt: this.timer.now(),
        } satisfies AudioLoopbackHelperMetadata;
      },
      discard: () => fs.rm(extractedPath, { force: true }),
    });
    return this.helperPath;
  }
}

function isCacheMetadata(
  value: unknown,
): value is Pick<AudioLoopbackHelperMetadata, "sha256" | "size"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "size" in value &&
    typeof value.size === "number"
  );
}

function extractHelper(archivePath: string): Buffer {
  let archive: AdmZip;
  try {
    archive = new AdmZip(archivePath);
  } catch (error) {
    throw new ActionableError(
      `audio-loopback-helper release asset is not a valid zip archive: ${errorMessage(error)}`,
    );
  }
  const entries = archive
    .getEntries()
    .filter(
      (candidate) =>
        !candidate.isDirectory &&
        path.posix.basename(candidate.entryName) === AUDIO_LOOPBACK_HELPER_CACHE_FILENAME,
    );
  if (entries.length !== 1) {
    throw new ActionableError(
      `audio-loopback-helper release asset must contain exactly one ${AUDIO_LOOPBACK_HELPER_CACHE_FILENAME}.`,
    );
  }
  try {
    return entries[0].getData();
  } catch (error) {
    if (error instanceof ActionableError) {
      throw error;
    }
    throw new ActionableError(
      `Unable to extract audio-loopback-helper release asset: ${errorMessage(error)}`,
    );
  }
}
