import path from "node:path";
import {
  type LmkPressureAbi,
  resolveLmkPressureChecksum,
  resolveLmkPressureUrl,
} from "../../constants/release";
import { ActionableError } from "../../models/ActionableError";
import { type ChecksumCalculator, DefaultChecksumCalculator } from "../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../utils/FileDownloader";
import { type IdGenerator, defaultIdGenerator } from "../../utils/IdGenerator";
import { logger } from "../../utils/logger";
import { type Timer, defaultTimer } from "../../utils/SystemTimer";
import { getTempDir } from "../../utils/tempDir";
import { VerifiedArtifactCache } from "../../utils/VerifiedArtifactCache";
import { type LmkPressureFileSystem, NodeLmkPressureFileSystem } from "./NodeLmkPressureFileSystem";

export const LMK_PRESSURE_CACHE_SUBDIR = "lmk-pressure";
export const LMK_PRESSURE_BINARY_FILENAME = "lmk_pressure";
export const LMK_PRESSURE_METADATA_FILENAME = "lmk-pressure.json";
export const LMK_PRESSURE_DOWNLOAD_TIMEOUT_MS = 60_000;

interface LmkPressureMetadata {
  sha256: string;
  size: number;
}

export interface LmkPressureBinaryProviderDeps {
  fileSystem?: LmkPressureFileSystem;
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  timer?: Timer;
  /** Defaults to `<auto-mobile data dir>/lmk-pressure`. */
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the pinned SHA-256 per ABI instead of the release registry. */
  expectedChecksum?: (abi: LmkPressureAbi) => string;
  /** Test seam: the release asset URL per ABI. */
  releaseUrl?: (abi: LmkPressureAbi) => string;
  downloadTimeoutMs?: number;
  /** Names each download's staging file, so concurrent callers never share one. */
  idGenerator?: IdGenerator;
}

/**
 * Delivers the deviceCondition memory-pressure payload from the GitHub Release
 * (#16402): each ABI's binary is downloaded once, checked against the SHA-256
 * pinned in the release checksum registry, and cached under AutoMobile's data
 * directory. A release without a pinned checksum yields null without touching
 * the network, so an unverifiable binary is never pushed to a device.
 */
export class LmkPressureBinaryProvider {
  private readonly fileSystem: LmkPressureFileSystem;
  private readonly cache: VerifiedArtifactCache;
  private readonly cacheDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly downloadTimeoutMs: number;
  private readonly expectedChecksum: (abi: LmkPressureAbi) => string;
  private readonly releaseUrl: (abi: LmkPressureAbi) => string;
  private readonly idGenerator: IdGenerator;
  private readonly inFlight = new Map<LmkPressureAbi, Promise<string | null>>();

  constructor(deps: LmkPressureBinaryProviderDeps = {}) {
    this.fileSystem = deps.fileSystem ?? new NodeLmkPressureFileSystem();
    this.cache = new VerifiedArtifactCache({
      downloader: deps.downloader ?? new DefaultFileDownloader(),
      checksumCalculator: deps.checksumCalculator ?? new DefaultChecksumCalculator(),
      fileSystem: this.fileSystem,
      timer: deps.timer ?? defaultTimer,
    });
    this.cacheDir = deps.cacheDir ?? getTempDir(LMK_PRESSURE_CACHE_SUBDIR);
    this.env = deps.env ?? process.env;
    this.downloadTimeoutMs = deps.downloadTimeoutMs ?? LMK_PRESSURE_DOWNLOAD_TIMEOUT_MS;
    this.expectedChecksum =
      deps.expectedChecksum ?? ((abi) => resolveLmkPressureChecksum(abi, this.env));
    this.releaseUrl = deps.releaseUrl ?? ((abi) => resolveLmkPressureUrl(abi, this.env));
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
  }

  /** Verified local path of the ABI's released binary, or null when none is pinned. */
  ensure(abi: LmkPressureAbi): Promise<string | null> {
    const pending = this.inFlight.get(abi);
    if (pending) {
      return pending;
    }
    const next = this.doEnsure(abi).finally(() => this.inFlight.delete(abi));
    this.inFlight.set(abi, next);
    return next;
  }

  private async doEnsure(abi: LmkPressureAbi): Promise<string | null> {
    const expected = this.expectedChecksum(abi);
    if (expected.length === 0) {
      logger.info(
        `[LMK_PRESSURE] No ${abi} memory-pressure binary is pinned for this release; not downloading`,
      );
      return null;
    }
    const dir = path.join(this.cacheDir, abi);
    const binaryPath = path.join(dir, LMK_PRESSURE_BINARY_FILENAME);
    const metadataPath = path.join(dir, LMK_PRESSURE_METADATA_FILENAME);
    const cached = await this.cache.isCached<LmkPressureMetadata>({
      label: "[LMK_PRESSURE]",
      subject: `${abi} binary`,
      expectedSha256: expected,
      metadataPath,
      parseMetadata: (value) => (isMetadata(value) ? value : null),
      verifyArtifact: async (metadata) =>
        (await this.fileSystem.fileSize(binaryPath)) === metadata.size,
    });
    if (cached) {
      return binaryPath;
    }
    await this.fileSystem.ensureDir(dir);
    await this.cache.fetch({
      label: "[LMK_PRESSURE]",
      expectedSha256: expected,
      url: this.releaseUrl(abi),
      // Each attempt stages its own file: another provider (a second device's apply, or
      // another daemon) may be downloading the same ABI into this directory at once.
      archivePath: `${binaryPath}.${this.idGenerator.next()}.download`,
      finalPath: binaryPath,
      metadataPath,
      downloadTimeoutMs: this.downloadTimeoutMs,
      mismatchError: (want, actual) =>
        new ActionableError(
          `The ${abi} memory-pressure binary checksum verification failed. Expected: ${want}, ` +
            `Got: ${actual}. The downloaded release asset is corrupted or tampered; it was not used.`,
        ),
      timeoutError: () =>
        new ActionableError(
          `Timed out downloading the ${abi} memory-pressure binary after ${this.downloadTimeoutMs}ms. ` +
            "Build it with bash scripts/android/build-lmk-pressure.sh or set AUTOMOBILE_LMK_PRESSURE_DIR.",
        ),
      publish: async (downloaded, sha256) => ({
        sha256: sha256 ?? expected,
        size: (await this.fileSystem.fileSize(downloaded)) ?? 0,
      }),
    });
    logger.info(`[LMK_PRESSURE] Downloaded and verified the ${abi} binary`, { path: binaryPath });
    return binaryPath;
  }
}

function isMetadata(value: unknown): value is LmkPressureMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "size" in value &&
    typeof value.size === "number"
  );
}
