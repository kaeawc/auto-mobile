import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { resolvePinnedVersion } from "../../constants/release";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import type { ChecksumCalculator } from "../../utils/ChecksumCalculator";
import type { FileDownloader } from "../../utils/FileDownloader";
import { DefaultIOSCtrlProxyBundleDownloader } from "../../utils/IOSCtrlProxyBundleDownloader";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { ensureSecureTempDirSync, getTempDir } from "../../utils/tempDir";
import { VerifiedArtifactCache } from "../../utils/VerifiedArtifactCache";

// Mirrors IosCtrlProxyBuilder's private RUNNER_XCTESTRUN_PREFIX: these are mutable launch copies.
const RUNNER_XCTESTRUN_PREFIX = "automobile-runner-";

/** Identifies one released simulator runner archive (tvOS, watchOS, visionOS). */
export interface SimulatorRunnerReleaseSpec {
  /** Platform name used in messages, e.g. "tvOS". */
  displayName: string;
  /** Log prefix, e.g. "[TVOS_RUNNER]". */
  logLabel: string;
  /** Secure temp-dir subdirectory holding verified extractions keyed by SHA-256. */
  cacheSubdir: string;
  /** Sidecar recording the verified archive SHA-256 inside each extraction. */
  metadataFilename: string;
  /** Release asset filename, also used for the staged download. */
  archiveFilename: string;
  /** Simulator SDK token the template xctestrun name must contain, e.g. "appletvsimulator". */
  sdk: string;
  resolveChecksum(env: NodeJS.ProcessEnv): string;
  resolveUrl(env: NodeJS.ProcessEnv): string;
}

export interface SimulatorRunnerReleaseFileSystem {
  readdir(directory: string): Promise<string[]>;
  stat(file: string): Promise<Pick<Stats, "isFile">>;
}

export interface SimulatorRunnerReleaseProviderDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  timer?: Timer;
  cacheDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  expectedChecksum?: string;
  releaseUrl?: string;
  downloadTimeoutMs?: number;
  extract?: (zipPath: string, destDir: string) => Promise<void>;
  fileSystem?: SimulatorRunnerReleaseFileSystem;
}

/** Resolves only checksum-pinned simulator runner release products; source builds belong to artifact resolution. */
export class SimulatorRunnerReleaseProvider {
  private readonly cache: VerifiedArtifactCache;
  private readonly cacheDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timer: Timer;
  private readonly fileSystem: SimulatorRunnerReleaseFileSystem;
  private readonly flights = new SingleFlight<string, string | null>();

  constructor(
    private readonly spec: SimulatorRunnerReleaseSpec,
    private readonly deps: SimulatorRunnerReleaseProviderDeps = {},
  ) {
    this.timer = deps.timer ?? defaultTimer;
    this.cache = new VerifiedArtifactCache({
      downloader: deps.downloader,
      checksumCalculator: deps.checksumCalculator,
      timer: this.timer,
    });
    this.cacheDir = path.resolve(deps.cacheDir ?? getTempDir(spec.cacheSubdir));
    this.env = deps.env ?? process.env;
    this.fileSystem = deps.fileSystem ?? fs;
  }

  async ensure(signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    if ((this.deps.platform ?? process.platform) !== "darwin") {
      return null;
    }
    return this.flights.run(
      "runner",
      async () => {
        try {
          return await this.doEnsure();
        } catch (error) {
          throw toActionableError(
            error,
            `Unable to resolve the released ${this.spec.displayName} runner`,
          );
        }
      },
      signal,
    );
  }

  private async doEnsure(): Promise<string | null> {
    const { displayName, logLabel } = this.spec;
    const expected = this.deps.expectedChecksum ?? this.spec.resolveChecksum(this.env);
    if (!expected) {
      logger.info(
        `${logLabel} This release has no pinned ${displayName} runner; no archive can be trusted.`,
      );
      return null;
    }
    if (!/^[a-f0-9]{64}$/i.test(expected)) {
      throw new ActionableError(`Invalid pinned ${displayName} runner SHA-256 checksum.`);
    }
    const destination = path.join(this.cacheDir, expected.toLowerCase());
    const metadataPath = path.join(destination, this.spec.metadataFilename);
    let cached: string | null = null;
    if (
      await this.cache.isCached({
        label: logLabel,
        subject: "runner",
        expectedSha256: expected,
        metadataPath,
        parseMetadata: (value) =>
          typeof value === "object" &&
          value !== null &&
          "sha256" in value &&
          typeof value.sha256 === "string"
            ? { sha256: value.sha256 }
            : null,
        verifyArtifact: async () => {
          cached = await this.findXctestrun(destination);
          return cached !== null;
        },
      })
    ) {
      return cached;
    }
    return this.download(expected, destination, metadataPath);
  }

  private async findXctestrun(directory: string): Promise<string | null> {
    const products = path.join(directory, "Build", "Products");
    try {
      const names = (await this.fileSystem.readdir(products)).filter(
        (name) =>
          name.includes(this.spec.sdk) &&
          name.endsWith(".xctestrun") &&
          !name.startsWith(RUNNER_XCTESTRUN_PREFIX) &&
          path.basename(name) === name,
      );
      const files: string[] = [];
      for (const name of names) {
        const file = path.join(products, name);
        if ((await this.fileSystem.stat(file)).isFile()) {
          files.push(file);
        }
      }
      return files.length === 1 ? files[0] : null;
    } catch (error) {
      // A removed cache entry is expected and can be downloaded again.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        logger.debug(`${this.spec.logLabel} No cached runner products`);
      } else {
        logger.warn(`${this.spec.logLabel} Unable to inspect runner products`, error);
      }
      return null;
    }
  }

  private async download(
    expected: string,
    destination: string,
    metadataPath: string,
  ): Promise<string | null> {
    const { displayName, logLabel } = this.spec;
    if (this.deps.cacheDir === undefined) {
      ensureSecureTempDirSync(this.spec.cacheSubdir);
    } else {
      await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.cacheDir, 0o700);
    }
    const staging = await fs.mkdtemp(path.join(this.cacheDir, ".staging-"));
    const archivePath = path.join(staging, this.spec.archiveFilename);
    const extracted = path.join(staging, "extracted");
    let relativeXctestrun: string | undefined;
    let downloaded = false;
    try {
      await this.fetch({
        expected,
        archivePath,
        metadataPath,
        destination,
        extracted,
        staging,
        onDownloaded: () => {
          downloaded = true;
        },
        onPublished: (relative) => {
          relativeXctestrun = relative;
        },
      });
    } catch (error) {
      if (downloaded) {
        // A downloaded archive that fails verification or extraction must fail closed.
        throw error;
      }
      // Offline, a missing release asset or an outage must not block the local source build.
      logger.warn(
        `${logLabel} Unable to download the released ${displayName} runner; falling back to a local build: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
    if (!relativeXctestrun) {
      throw new ActionableError(`${displayName} runner extraction did not publish an xctestrun.`);
    }
    return path.join(destination, relativeXctestrun);
  }

  private async fetch(request: {
    expected: string;
    archivePath: string;
    metadataPath: string;
    destination: string;
    extracted: string;
    staging: string;
    onDownloaded(): void;
    onPublished(relativeXctestrun: string): void;
  }): Promise<void> {
    const { expected, archivePath, metadataPath, destination, extracted, staging } = request;
    const { displayName, logLabel, sdk } = this.spec;
    await this.cache.fetch({
      label: logLabel,
      expectedSha256: expected,
      url: this.deps.releaseUrl ?? this.spec.resolveUrl(this.env),
      archivePath,
      metadataPath,
      metadataMode: 0o600,
      downloadTimeoutMs: this.deps.downloadTimeoutMs ?? 120_000,
      afterDownload: async (file) => {
        request.onDownloaded();
        await fs.chmod(file, 0o600);
      },
      mismatchError: (want, actual) =>
        new ActionableError(
          `${displayName} runner checksum verification failed. Expected: ${want}, Got: ${actual}. The release archive is corrupted or tampered.`,
        ),
      timeoutError: () =>
        new ActionableError(
          `Timed out downloading the ${displayName} runner. Check release asset availability.`,
        ),
      publish: async (zip, sha256) => {
        const extract =
          this.deps.extract ??
          ((file: string, dir: string) =>
            new DefaultIOSCtrlProxyBundleDownloader().extractBundle(file, dir));
        await extract(zip, extracted);
        const xctestrun = await this.findXctestrun(extracted);
        if (!xctestrun) {
          throw new ActionableError(
            `${displayName} runner archive must contain exactly one ${sdk} xctestrun in Build/Products.`,
          );
        }
        request.onPublished(path.relative(extracted, xctestrun));
        await fs.chmod(extracted, 0o700);
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rename(extracted, destination);
        return { version: resolvePinnedVersion(this.env), sha256, downloadedAt: this.timer.now() };
      },
      settle: () => fs.rm(staging, { recursive: true, force: true }),
    });
  }
}
