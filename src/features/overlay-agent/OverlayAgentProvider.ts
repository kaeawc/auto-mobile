import * as fs from "node:fs/promises";
import path from "node:path";
import {
  OVERLAY_AGENT_DYLIB_FILENAME,
  resolveOverlayAgentChecksum,
  resolveOverlayAgentUrl,
  resolvePinnedVersion,
} from "../../constants/release";
import { ActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { errorMessage } from "../../utils/describeUnknownError";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { logger } from "../../utils/logger";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { ensureSecureTempDirSync, getTempDir } from "../../utils/tempDir";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";

const CACHE_SUBDIR = "overlay-agent";
const SECURE_DIR_MODE = 0o700;
// The dylib is loaded by dyld in a simulator process, never executed directly.
const SECURE_FILE_MODE = 0o600;
export const OVERLAY_AGENT_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Absolute path to a locally built overlay-agent dylib (repo checkouts, local builds). */
export const IOS_OVERLAY_AGENT_ENV = "AUTOMOBILE_IOS_OVERLAY_AGENT";
/** Set to `1`/`true` to forbid the release download (offline and air-gapped use). */
export const SKIP_IOS_OVERLAY_AGENT_DOWNLOAD_ENV = "AUTOMOBILE_SKIP_IOS_OVERLAY_AGENT_DOWNLOAD";

export const OVERLAY_AGENT_CACHE_FILENAME = OVERLAY_AGENT_DYLIB_FILENAME;
export const OVERLAY_AGENT_METADATA_FILENAME = "AutoMobileOverlayAgent.json";

export interface OverlayAgentMetadata {
  version: string;
  sha256: string;
  size: number;
  downloadedAt: number;
}

export interface OverlayAgentProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  cacheDir?: string;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
  expectedChecksum?: string;
  releaseUrl?: string;
  downloadTimeoutMs?: number;
  /** Local build outputs tried after the env override and before downloading. */
  localBuildPaths?: string[];
}

export type OverlayAgentSource = "explicit" | "env" | "local-build" | "cache" | "download";

export interface ResolvedOverlayAgent {
  /** Absolute path usable as a `DYLD_INSERT_LIBRARIES` entry. */
  path: string;
  source: OverlayAgentSource;
}

/**
 * Resolves the iOS-simulator overlay-agent dylib: explicit path, then the
 * `AUTOMOBILE_IOS_OVERLAY_AGENT` override, then a local build output, then a
 * checksum-pinned GitHub Release download cached with a metadata sidecar.
 * Fetched lazily on first overlay use, never at daemon start.
 */
export class OverlayAgentProvider {
  private static instance: OverlayAgentProvider | null = null;

  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly cacheDir: string;
  private readonly usesDefaultCacheDir: boolean;
  private readonly timer: Timer;
  private readonly env: NodeJS.ProcessEnv;
  private readonly expectedChecksumOverride?: string;
  private readonly releaseUrlOverride?: string;
  private readonly downloadTimeoutMs: number;
  private readonly localBuildPaths: string[];
  private inFlight: Promise<ResolvedOverlayAgent> | null = null;

  constructor(deps: OverlayAgentProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.cacheDir = deps.cacheDir ?? getTempDir(CACHE_SUBDIR);
    this.usesDefaultCacheDir = deps.cacheDir === undefined;
    this.timer = deps.timer ?? defaultTimer;
    this.env = deps.env ?? process.env;
    this.expectedChecksumOverride = deps.expectedChecksum;
    this.releaseUrlOverride = deps.releaseUrl;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? OVERLAY_AGENT_DOWNLOAD_TIMEOUT_MS;
    this.localBuildPaths = deps.localBuildPaths ?? [];
  }

  static getInstance(): OverlayAgentProvider {
    OverlayAgentProvider.instance ??= new OverlayAgentProvider();
    return OverlayAgentProvider.instance;
  }

  static resetInstances(): void {
    OverlayAgentProvider.instance = null;
  }

  /** Absolute path to a verified (or explicitly overridden) dylib; throws an ActionableError otherwise. */
  async ensure(explicitPath?: string): Promise<ResolvedOverlayAgent> {
    if (explicitPath) {
      return this.requireOverride(explicitPath, "explicit", "the explicit overlay agent path");
    }
    const envPath = this.env[IOS_OVERLAY_AGENT_ENV];
    if (envPath) {
      return this.requireOverride(envPath, "env", IOS_OVERLAY_AGENT_ENV);
    }
    for (const configured of this.localBuildPaths) {
      const candidate = resolvePathFromDaemonLaunchWorkingDirectory(configured, this.env);
      if (await isFile(candidate)) {
        return { path: candidate, source: "local-build" };
      }
    }
    // Single-flight: concurrent first uses share one cache check / download.
    this.inFlight ??= this.resolveFromRelease().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async requireOverride(
    candidate: string,
    source: OverlayAgentSource,
    label: string,
  ): Promise<ResolvedOverlayAgent> {
    // A detached daemon has chdir'd; anchor relative overrides at the launch directory so the
    // returned DYLD_INSERT_LIBRARIES entry is absolute and stable.
    candidate = resolvePathFromDaemonLaunchWorkingDirectory(candidate, this.env);
    if (!(await isFile(candidate))) {
      throw new ActionableError(
        `The overlay agent dylib configured by ${label} does not exist: ${candidate}. ` +
          `Build it with scripts/ios/overlay-agent-build.sh and point ${IOS_OVERLAY_AGENT_ENV} at the result.`,
      );
    }
    return { path: candidate, source };
  }

  private async resolveFromRelease(): Promise<ResolvedOverlayAgent> {
    const expected = this.expectedChecksumOverride ?? resolveOverlayAgentChecksum(this.env);
    if (expected.length === 0) {
      throw new ActionableError(
        "The iOS overlay agent is unavailable for this build: no release checksum is pinned for " +
          `version ${resolvePinnedVersion(this.env)}. Set ${IOS_OVERLAY_AGENT_ENV} to a locally built dylib.`,
      );
    }

    if (await this.isCacheUsable(expected)) {
      logger.info("[OVERLAY_AGENT] Reusing verified release overlay agent", {
        path: this.dylibPath,
      });
      return { path: this.dylibPath, source: "cache" };
    }

    if (isTruthy(this.env[SKIP_IOS_OVERLAY_AGENT_DOWNLOAD_ENV])) {
      throw new ActionableError(
        `The overlay agent download is disabled by ${SKIP_IOS_OVERLAY_AGENT_DOWNLOAD_ENV} and no ` +
          `verified cached copy exists. Set ${IOS_OVERLAY_AGENT_ENV} to a locally built dylib.`,
      );
    }
    return { path: await this.download(expected), source: "download" };
  }

  private get dylibPath(): string {
    return path.join(this.cacheDir, OVERLAY_AGENT_CACHE_FILENAME);
  }

  private get metadataPath(): string {
    return path.join(this.cacheDir, OVERLAY_AGENT_METADATA_FILENAME);
  }

  private async isCacheUsable(expected: string): Promise<boolean> {
    let metadata: unknown;
    try {
      metadata = JSON.parse(await fs.readFile(this.metadataPath, "utf8"));
    } catch (error) {
      // Missing or corrupt metadata is expected on first use and after upgrades; download repairs it.
      logger.debug("[OVERLAY_AGENT] No usable cached overlay agent metadata", {
        error: errorMessage(error),
      });
      return false;
    }
    if (!isCacheMetadata(metadata)) {
      // Stale metadata schemas are expected after upgrades; download rewrites them.
      logger.debug("[OVERLAY_AGENT] No usable cached overlay agent metadata", {
        reason: "Expected an object with a string sha256 and numeric size",
      });
      return false;
    }
    if (metadata.sha256.toLowerCase() !== expected.toLowerCase()) {
      return false;
    }
    try {
      const stats = await fs.stat(this.dylibPath);
      if (!stats.isFile() || stats.size !== metadata.size) {
        return false;
      }
      // The sidecar only records what was once verified; re-hash so same-size corruption or a
      // stale sidecar left by an interrupted publish never passes as a verified dylib.
      const { checksum } = await this.checksumCalculator.computeFileSha256(this.dylibPath);
      return checksum.toLowerCase() === expected.toLowerCase();
    } catch (error) {
      // The dylib vanished while the sidecar survived; download restores both.
      logger.debug("[OVERLAY_AGENT] No usable cached overlay agent dylib", {
        error: errorMessage(error),
      });
      return false;
    }
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
    const partialPath = path.join(dir, `${OVERLAY_AGENT_CACHE_FILENAME}.download`);
    const controller = new AbortController();
    const timeout = this.timer.setTimeout(() => controller.abort(), this.downloadTimeoutMs);
    // Only artifacts this attempt published may be removed on failure; another provider or daemon
    // sharing the cache may already have published a verified entry.
    let published = false;

    try {
      await this.downloader.download(
        this.releaseUrlOverride ?? resolveOverlayAgentUrl(this.env),
        partialPath,
        controller.signal,
      );
      await fs.chmod(partialPath, SECURE_FILE_MODE);
      const { checksum: actual } = await this.checksumCalculator.computeFileSha256(partialPath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new ActionableError(
          `Overlay agent checksum verification failed. Expected: ${expected}, Got: ${actual}. ` +
            "The downloaded release asset is corrupted or tampered, and was deleted.",
        );
      }
      const { size } = await fs.stat(partialPath);
      published = true;
      await fs.rename(partialPath, this.dylibPath);
      await fs.writeFile(
        this.metadataPath,
        JSON.stringify(
          {
            version: resolvePinnedVersion(this.env),
            sha256: actual,
            size,
            downloadedAt: this.timer.now(),
          } satisfies OverlayAgentMetadata,
          null,
          2,
        ),
        { encoding: "utf8", mode: SECURE_FILE_MODE },
      );
      logger.info("[OVERLAY_AGENT] Downloaded and verified release overlay agent", {
        path: this.dylibPath,
        sha256: actual,
      });
      return this.dylibPath;
    } catch (error) {
      // Never leave unverified bytes where a later run could mistake them for a cache entry.
      await Promise.all([
        fs.rm(partialPath, { force: true }),
        ...(published
          ? [fs.rm(this.dylibPath, { force: true }), fs.rm(this.metadataPath, { force: true })]
          : []),
      ]);
      if (controller.signal.aborted) {
        throw new ActionableError(
          `Timed out downloading the overlay agent after ${this.downloadTimeoutMs}ms. ` +
            `Check GitHub Release asset availability or set ${IOS_OVERLAY_AGENT_ENV} for local development.`,
        );
      }
      throw error;
    } finally {
      this.timer.clearTimeout(timeout);
    }
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch (error) {
    // A missing candidate is the normal "try the next source" signal.
    logger.debug(`[OVERLAY_AGENT] ${candidate} is not usable: ${errorMessage(error)}`);
    return false;
  }
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function isCacheMetadata(value: unknown): value is Pick<OverlayAgentMetadata, "sha256" | "size"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "size" in value &&
    typeof value.size === "number"
  );
}
