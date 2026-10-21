import path from "node:path";
import {
  NETWORK_FILTER_ARCHIVE_FILENAME,
  resolveAssetVersion,
  resolveNetworkFilterChecksum,
  resolveNetworkFilterUrl,
  resolvePinnedVersion,
} from "../../constants/release";
import { ActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { logger } from "../../utils/logger";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { VerifiedArtifactCache } from "../../utils/VerifiedArtifactCache";
import { getTempDir } from "../../utils/tempDir";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import {
  NETWORK_FILTER_APP_NAME,
  NETWORK_FILTER_APP_PATH_ENV,
  controllerPath,
} from "./networkFilterApp";
import {
  DefaultNetworkFilterCommandRunner,
  NodeNetworkFilterFileSystem,
  type NetworkFilterCommandRunner,
  type NetworkFilterFileSystem,
} from "./networkFilterHost";

export const NETWORK_FILTER_CACHE_SUBDIR = "network-filter";
export const NETWORK_FILTER_METADATA_FILENAME = "network-filter.json";
export const NETWORK_FILTER_DOWNLOAD_TIMEOUT_MS = 60_000;
export const NETWORK_FILTER_EXTRACT_TIMEOUT_MS = 60_000;
/** Version recorded for an app supplied through {@link NETWORK_FILTER_APP_PATH_ENV}. */
export const NETWORK_FILTER_OVERRIDE_VERSION = "local-override";

export interface NetworkFilterAppMetadata {
  version: string;
  sha256: string;
  downloadedAt: number;
}

/** A verified-by-checksum (or developer-supplied) app ready for signature checks. */
export interface NetworkFilterAppCandidate {
  appPath: string;
  source: "release" | "override";
  /** Concrete release version, or {@link NETWORK_FILTER_OVERRIDE_VERSION}. */
  version: string;
  /** Release archive SHA-256; null for an override. */
  sha256: string | null;
}

export interface NetworkFilterAppProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  fileSystem?: NetworkFilterFileSystem;
  commandRunner?: NetworkFilterCommandRunner;
  cacheDir?: string;
  timer?: Timer;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the registry's `networkFilterSha256` for the pinned version. */
  expectedChecksum?: string;
  /** Test seam: replaces the resolved release URL. */
  releaseUrl?: string;
  downloadTimeoutMs?: number;
}

/**
 * Delivers the signed Network Extension app (#10588), modelled on
 * `ScreenCaptureHelperProvider`: the release zip is downloaded through an
 * injected downloader, its SHA-256 is checked against the release checksum
 * registry, and it is unpacked with `ditto` (which preserves the nested
 * system extension's signature) into a cache with JSON metadata.
 *
 * This class only stages files under AutoMobile's own data directory. Copying
 * to `/Applications` and activation belong to `NetworkFilterInstaller`, which
 * only runs from the explicit install command.
 */
export class NetworkFilterAppProvider {
  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly fileSystem: NetworkFilterFileSystem;
  private readonly commandRunner: NetworkFilterCommandRunner;
  private readonly cacheDir: string;
  private readonly timer: Timer;
  private readonly cache: VerifiedArtifactCache;
  private readonly env: NodeJS.ProcessEnv;
  private readonly downloadTimeoutMs: number;
  private readonly expectedChecksumOverride?: string;
  private readonly releaseUrlOverride?: string;
  private inFlight: Promise<NetworkFilterAppCandidate> | null = null;

  constructor(deps: NetworkFilterAppProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.fileSystem = deps.fileSystem ?? new NodeNetworkFilterFileSystem();
    this.commandRunner = deps.commandRunner ?? new DefaultNetworkFilterCommandRunner();
    this.cacheDir = deps.cacheDir ?? getTempDir(NETWORK_FILTER_CACHE_SUBDIR);
    this.timer = deps.timer ?? defaultTimer;
    this.cache = new VerifiedArtifactCache({
      downloader: this.downloader,
      checksumCalculator: this.checksumCalculator,
      fileSystem: this.fileSystem,
      timer: this.timer,
    });
    this.env = deps.env ?? process.env;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? NETWORK_FILTER_DOWNLOAD_TIMEOUT_MS;
    this.expectedChecksumOverride = deps.expectedChecksum;
    this.releaseUrlOverride = deps.releaseUrl;
  }

  /** Directory holding cached downloads, metadata and the install receipt. */
  get cacheDirectory(): string {
    return this.cacheDir;
  }

  async ensure(): Promise<NetworkFilterAppCandidate> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.doEnsure().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doEnsure(): Promise<NetworkFilterAppCandidate> {
    const override = this.env[NETWORK_FILTER_APP_PATH_ENV]?.trim();
    if (override) {
      return this.resolveOverride(override);
    }

    const version = resolveAssetVersion(resolvePinnedVersion(this.env));
    const expected = this.expectedChecksumOverride ?? resolveNetworkFilterChecksum(this.env);
    if (expected.length === 0) {
      // Fail closed: never download another version's build to fill the gap.
      throw new ActionableError(
        `No Network Extension app is published for AutoMobile ${version}: the release checksum ` +
          "registry has no networkFilterSha256 for this version, so no download can be trusted. " +
          `Upgrade AutoMobile, or set ${NETWORK_FILTER_APP_PATH_ENV} to a locally built, ` +
          "Developer ID signed app.",
      );
    }

    const cached = await this.tryCache(expected);
    if (cached) {
      logger.info("[NETWORK_FILTER] Reusing verified release app", { path: cached });
      return { appPath: cached, source: "release", version, sha256: expected };
    }
    const appPath = await this.download(expected, version);
    return { appPath, source: "release", version, sha256: expected };
  }

  /** The #4221 lesson: an override must be a real `.app`, or we fail closed. */
  private async resolveOverride(raw: string): Promise<NetworkFilterAppCandidate> {
    const appPath = resolvePathFromDaemonLaunchWorkingDirectory(raw, this.env);
    if (!appPath.endsWith(".app") || !(await this.fileSystem.isDirectory(appPath))) {
      throw new ActionableError(
        `${NETWORK_FILTER_APP_PATH_ENV} must point at an app bundle directory ending in .app, ` +
          `but ${appPath} is not one. Build it with scripts/ios/build-network-filter-probe.sh signed.`,
      );
    }
    if (!(await this.fileSystem.isFile(controllerPath(appPath)))) {
      throw new ActionableError(
        `${NETWORK_FILTER_APP_PATH_ENV} points at ${appPath}, which has no ` +
          "Contents/MacOS/network-filter-controller. Build it with " +
          "scripts/ios/build-network-filter-probe.sh signed.",
      );
    }
    return {
      appPath,
      source: "override",
      version: NETWORK_FILTER_OVERRIDE_VERSION,
      sha256: null,
    };
  }

  private get metadataPath(): string {
    return path.join(this.cacheDir, NETWORK_FILTER_METADATA_FILENAME);
  }

  private get appDir(): string {
    return path.join(this.cacheDir, "app");
  }

  private get cachedAppPath(): string {
    return path.join(this.appDir, NETWORK_FILTER_APP_NAME);
  }

  private async tryCache(expected: string): Promise<string | null> {
    const hit = await this.cache.isCached<Pick<NetworkFilterAppMetadata, "sha256">>({
      label: "[NETWORK_FILTER]",
      subject: "app",
      expectedSha256: expected,
      metadataPath: this.metadataPath,
      parseMetadata: (value) => (isCacheMetadata(value) ? value : null),
      verifyArtifact: () => this.fileSystem.isFile(controllerPath(this.cachedAppPath)),
    });
    return hit ? this.cachedAppPath : null;
  }

  private async download(expected: string, version: string): Promise<string> {
    await this.fileSystem.ensureDir(this.cacheDir);
    const archivePath = path.join(this.cacheDir, `${NETWORK_FILTER_ARCHIVE_FILENAME}.download`);
    const stagingDir = path.join(this.cacheDir, "app.download");

    await this.cache.fetch({
      label: "[NETWORK_FILTER]",
      expectedSha256: expected,
      url: this.releaseUrlOverride ?? resolveNetworkFilterUrl(this.env),
      archivePath,
      metadataPath: this.metadataPath,
      downloadTimeoutMs: this.downloadTimeoutMs,
      mismatchError: (want, actual) =>
        new ActionableError(
          `Network Extension app checksum verification failed. Expected: ${want}, Got: ${actual}. ` +
            "The downloaded release asset is corrupted or tampered; nothing was installed.",
        ),
      timeoutError: () =>
        new ActionableError(
          `Timed out downloading the Network Extension app after ${this.downloadTimeoutMs}ms. ` +
            `Check GitHub Release asset availability or set ${NETWORK_FILTER_APP_PATH_ENV} for a local build.`,
        ),
      publish: async (downloaded, sha256) => {
        await this.fileSystem.remove(stagingDir);
        await this.fileSystem.ensureDir(stagingDir);
        const extract = await this.commandRunner.run(
          "ditto",
          ["-x", "-k", downloaded, stagingDir],
          {
            timeoutMs: NETWORK_FILTER_EXTRACT_TIMEOUT_MS,
          },
        );
        if (extract.exitCode !== 0) {
          throw new ActionableError(
            `Unable to unpack the Network Extension app archive with ditto (exit ${extract.exitCode}): ` +
              `${extract.stderr.trim() || "no output"}`,
          );
        }
        const stagedApp = path.join(stagingDir, NETWORK_FILTER_APP_NAME);
        if (!(await this.fileSystem.isFile(controllerPath(stagedApp)))) {
          throw new ActionableError(
            `The Network Extension release asset does not contain ${NETWORK_FILTER_APP_NAME} ` +
              "with its controller executable.",
          );
        }
        await this.fileSystem.remove(this.appDir);
        await this.fileSystem.rename(stagingDir, this.appDir);
        logger.info("[NETWORK_FILTER] Downloaded and verified release app", {
          path: this.cachedAppPath,
          sha256,
        });
        return {
          version,
          sha256: sha256 ?? expected,
          downloadedAt: this.timer.now(),
        } satisfies NetworkFilterAppMetadata;
      },
      discard: () => this.fileSystem.remove(stagingDir),
      settle: () => this.fileSystem.remove(archivePath),
    });
    return this.cachedAppPath;
  }
}

function isCacheMetadata(value: unknown): value is Pick<NetworkFilterAppMetadata, "sha256"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string"
  );
}
