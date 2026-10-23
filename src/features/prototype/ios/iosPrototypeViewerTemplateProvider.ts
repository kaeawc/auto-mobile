import { type SpotlightFileSystem, markSpotlightExcluded } from "../../../utils/spotlightExclusion";
import AdmZip from "adm-zip";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  PROTOTYPE_VIEWER_ARCHIVE_FILENAME,
  resolvePrototypeViewerUrl,
  resolvePrototypeViewerChecksum,
  resolvePinnedVersion,
} from "../../../constants/release";
import {
  type ChecksumCalculator,
  DefaultChecksumCalculator,
} from "../../../utils/ChecksumCalculator";
import { type FileDownloader, DefaultFileDownloader } from "../../../utils/FileDownloader";
import { type IdGenerator, defaultIdGenerator } from "../../../utils/IdGenerator";
import { type Timer, defaultTimer } from "../../../utils/SystemTimer";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { ensureSecureTempDirSync, getTempDir } from "../../../utils/tempDir";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";
import { assertZipEntriesContained } from "../../../utils/workers/assertZipEntriesContained";
import type { TemplateProvider } from "./iosPrototypeInstaller";
import {
  PrototypeViewerChecksumMismatchError,
  PrototypeViewerDownloadError,
  PrototypeViewerDownloadDisabledError,
  PrototypeViewerExtractError,
  PrototypeViewerOverrideError,
  PrototypeViewerUnsupportedVersionError,
} from "./iosPrototypeInstallerErrors";
import { ENV, readEnvBool } from "../../../config/env";

const CACHE_SUBDIR = "prototype-viewer";
const APP_NAME = "PrototypeViewer.app";
export const IOS_PROTOTYPE_VIEWER_ENV = ENV.IOS_PROTOTYPE_VIEWER.name;
export const SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD_ENV = ENV.SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD.name;
export const PROTOTYPE_VIEWER_METADATA_FILENAME = "AutoMobilePrototypeViewer.json";
export const PROTOTYPE_VIEWER_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface PrototypeViewerMetadata {
  version: string;
  sha256: string;
  size: number;
  downloadedAt: number;
}

export interface PrototypeViewerTemplateProviderDeps {
  platform?: NodeJS.Platform;
  spotlightFileSystem?: SpotlightFileSystem;
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  cacheDir?: string;
  timer?: Timer;
  idGenerator?: IdGenerator;
  env?: NodeJS.ProcessEnv;
  expectedChecksum?: string;
  releaseUrl?: string;
  downloadTimeoutMs?: number;
  localBuildPaths?: string[];
  renameFile?: (from: string, to: string) => Promise<void>;
  explicitPath?: string;
}

export interface ResolvedPrototypeViewerTemplate {
  path: string;
  source: "explicit" | "env" | "local-build" | "cache" | "download";
}

/** Lazily resolves an app template; release bytes are always pinned and verified before extraction. */
export class PrototypeViewerTemplateProvider implements TemplateProvider {
  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly cacheDir: string;
  private readonly timer: Timer;
  private readonly idGenerator: IdGenerator;
  private readonly env: NodeJS.ProcessEnv;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private spotlightExclusion: Promise<void> | undefined;
  private inFlight: Promise<ResolvedPrototypeViewerTemplate> | null = null;

  constructor(private readonly deps: PrototypeViewerTemplateProviderDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.cacheDir = deps.cacheDir ?? getTempDir(CACHE_SUBDIR);
    this.timer = deps.timer ?? defaultTimer;
    this.idGenerator = deps.idGenerator ?? defaultIdGenerator;
    this.env = deps.env ?? process.env;
    this.renameFile = deps.renameFile ?? fs.rename;
  }

  async resolve(): Promise<string> {
    return (await this.resolveDetailed()).path;
  }

  resolveDetailed(): Promise<ResolvedPrototypeViewerTemplate> {
    this.inFlight ??= this.doResolve().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doResolve(): Promise<ResolvedPrototypeViewerTemplate> {
    if (this.deps.explicitPath !== undefined) {
      return this.requireOverride(this.deps.explicitPath, "explicit", "the explicit template path");
    }
    const envPath = this.env[IOS_PROTOTYPE_VIEWER_ENV];
    if (envPath !== undefined) {
      return this.requireOverride(envPath, "env", IOS_PROTOTYPE_VIEWER_ENV);
    }
    for (const configured of this.deps.localBuildPaths ?? []) {
      const candidate = resolvePathFromDaemonLaunchWorkingDirectory(configured, this.env);
      if (await isApp(candidate)) {
        return { path: candidate, source: "local-build" };
      }
    }
    const expected = this.deps.expectedChecksum ?? resolvePrototypeViewerChecksum(this.env);
    if (expected.length === 0) {
      throw new PrototypeViewerUnsupportedVersionError(resolvePinnedVersion(this.env));
    }
    if (await this.isCacheUsable(expected)) {
      return { path: this.cachePaths(expected).app, source: "cache" };
    }
    if (readEnvBool(ENV.SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD, this.env)) {
      throw new PrototypeViewerDownloadDisabledError();
    }
    return { path: await this.download(expected), source: "download" };
  }

  private async requireOverride(
    configured: string,
    source: "explicit" | "env",
    label: string,
  ): Promise<ResolvedPrototypeViewerTemplate> {
    const candidate = resolvePathFromDaemonLaunchWorkingDirectory(configured, this.env);
    if (configured.length === 0 || !(await isApp(candidate))) {
      throw new PrototypeViewerOverrideError(candidate, label);
    }
    return { path: candidate, source };
  }

  private cachePaths(expected: string) {
    const directory = path.join(this.cacheDir, expected.toLowerCase());
    return {
      directory,
      app: path.join(directory, APP_NAME),
      archive: path.join(directory, PROTOTYPE_VIEWER_ARCHIVE_FILENAME),
      metadata: path.join(directory, PROTOTYPE_VIEWER_METADATA_FILENAME),
    };
  }

  private async isCacheUsable(expected: string): Promise<boolean> {
    const paths = this.cachePaths(expected);
    try {
      const metadata: unknown = JSON.parse(await fs.readFile(paths.metadata, "utf8"));
      if (!isCacheMetadata(metadata) || metadata.sha256.toLowerCase() !== expected.toLowerCase()) {
        return false;
      }
      const stats = await fs.stat(paths.archive);
      if (!stats.isFile() || stats.size !== metadata.size) {
        return false;
      }
      const { checksum } = await this.checksumCalculator.computeFileSha256(paths.archive);
      return checksum.toLowerCase() === expected.toLowerCase() && (await isApp(paths.app));
    } catch (error) {
      // Missing/corrupt cache files are expected on first use or after interrupted publication.
      logger.debug("[PROTOTYPE_VIEWER] No usable cached archive", { error: errorMessage(error) });
      return false;
    }
  }

  private async downloadBytes(url: string, partial: string): Promise<void> {
    const controller = new AbortController();
    const timeoutMs = this.deps.downloadTimeoutMs ?? PROTOTYPE_VIEWER_DOWNLOAD_TIMEOUT_MS;
    const timeout = this.timer.setTimeout(() => controller.abort(), timeoutMs);
    try {
      await this.downloader.download(url, partial, controller.signal);
      if (controller.signal.aborted) {
        throw new PrototypeViewerDownloadError(
          `Timed out downloading ${url} after ${timeoutMs}ms.`,
        );
      }
    } catch (error) {
      const detail = controller.signal.aborted
        ? `Timed out downloading after ${timeoutMs}ms`
        : errorMessage(error);
      throw new PrototypeViewerDownloadError(
        `Prototype viewer download failed for ${url}: ${detail}. Set ${IOS_PROTOTYPE_VIEWER_ENV} to a template built with scripts/ios/prototype-viewer-build.sh.`,
        error,
      );
    } finally {
      this.timer.clearTimeout(timeout);
    }
  }

  private async publishApp(staging: string, expected: string): Promise<boolean> {
    const paths = this.cachePaths(expected);
    if (await this.isCacheUsable(expected)) {
      return false;
    }
    // Invalidate before replacing any artifact: interrupted publication must fail closed.
    await fs.rm(paths.metadata, { recursive: true, force: true });
    try {
      await this.renameFile(path.join(staging, APP_NAME), paths.app);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        typeof error.code !== "string" ||
        !["ENOTEMPTY", "EEXIST", "EPERM", "EBUSY"].includes(error.code)
      ) {
        throw error;
      }
      // A competing same-pin provider may have completed while this attempt staged its app.
      if (await this.isCacheUsable(expected)) {
        return false;
      }
      await fs.rm(paths.app, { recursive: true, force: true });
      await this.renameFile(path.join(staging, APP_NAME), paths.app);
    }
    return true;
  }

  private async download(expected: string): Promise<string> {
    const paths = this.cachePaths(expected);
    const partial = `${paths.archive}.${this.idGenerator.next()}.download`;
    const staging = path.join(paths.directory, `extract.${this.idGenerator.next()}`);
    const url = this.deps.releaseUrl ?? resolvePrototypeViewerUrl(this.env);
    let appPublished = false;
    let archivePublished = false;
    try {
      if (this.deps.cacheDir === undefined) {
        ensureSecureTempDirSync(CACHE_SUBDIR);
      }
      await fs.mkdir(paths.directory, { recursive: true, mode: 0o700 });
      this.spotlightExclusion ??= markSpotlightExcluded(
        this.cacheDir,
        this.deps.spotlightFileSystem ?? fs,
        this.deps.platform ?? process.platform,
      );
      await this.spotlightExclusion;
      await this.downloadBytes(url, partial);
      await fs.chmod(partial, 0o600);
      const { checksum: actual } = await this.checksumCalculator.computeFileSha256(partial);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new PrototypeViewerChecksumMismatchError(expected, actual);
      }
      const { size } = await fs.stat(partial);
      await this.extract(partial, staging);
      // A complete staged app is moved in one rename; no partially extracted app is public.
      appPublished = await this.publishApp(staging, expected);
      if (!appPublished) {
        return paths.app;
      }
      await this.renameFile(partial, paths.archive);
      archivePublished = true;
      await fs.writeFile(
        paths.metadata,
        JSON.stringify({
          version: resolvePinnedVersion(this.env),
          sha256: actual,
          size,
          downloadedAt: this.timer.now(),
        } satisfies PrototypeViewerMetadata),
        { encoding: "utf8", mode: 0o600 },
      );
      await fs.chmod(paths.metadata, 0o600);
      return paths.app;
    } catch (error) {
      // Only remove artifacts published by this attempt; an earlier cache may still exist.
      await Promise.all([
        ...(appPublished ? [fs.rm(paths.app, { recursive: true, force: true })] : []),
        ...(archivePublished
          ? [
              fs.rm(paths.archive, { force: true }),
              fs.rm(paths.metadata, { recursive: true, force: true }),
            ]
          : []),
      ]);
      if (
        error instanceof PrototypeViewerChecksumMismatchError ||
        error instanceof PrototypeViewerExtractError ||
        error instanceof PrototypeViewerDownloadError
      ) {
        throw error;
      }
      throw new PrototypeViewerDownloadError(
        `Could not publish the prototype viewer from ${url}: ${errorMessage(error)}. Retry or set ${IOS_PROTOTYPE_VIEWER_ENV} to a local template.`,
        error,
      );
    } finally {
      await Promise.all([
        fs.rm(partial, { force: true }),
        fs.rm(staging, { recursive: true, force: true }),
      ]);
    }
  }

  private async extract(archivePath: string, staging: string): Promise<void> {
    try {
      const zip = new AdmZip(archivePath);
      assertZipEntriesContained(zip, staging, "PrototypeViewer bundle");
      const entries = zip.getEntries();
      if (
        entries.length === 0 ||
        entries.some(
          (entry) =>
            !entry.entryName.startsWith(`${APP_NAME}/`) ||
            entry.entryName
              .split(/[\\/]/)
              .some(
                (component) =>
                  component === ".." || component === "__MACOSX" || component.startsWith("._"),
              ) ||
            entry.entryName.includes("\\") ||
            (entry.entryName === `${APP_NAME}/` && !entry.isDirectory),
        )
      ) {
        throw new PrototypeViewerExtractError(
          `Archive must contain exactly one top-level ${APP_NAME} directory and no entries outside it`,
        );
      }
      // Containment and layout checks finish before even creating the staging directory.
      await fs.mkdir(staging, { mode: 0o700 });
      zip.extractAllTo(staging, true);
      const app = path.join(staging, APP_NAME);
      if (!(await isApp(app))) {
        throw new PrototypeViewerExtractError("Archive app is missing Info.plist");
      }
      const executable = path.join(app, "PrototypeViewer");
      if (!(await fs.stat(executable)).isFile()) {
        throw new PrototypeViewerExtractError(
          "Archive app is missing its PrototypeViewer executable",
        );
      }
      await fs.chmod(executable, 0o755);
    } catch (error) {
      if (error instanceof PrototypeViewerExtractError) {
        throw error;
      }
      throw new PrototypeViewerExtractError(errorMessage(error), error);
    }
  }
}

async function isApp(candidate: string): Promise<boolean> {
  try {
    return (
      (await fs.stat(candidate)).isDirectory() &&
      (await fs.stat(path.join(candidate, "Info.plist"))).isFile()
    );
  } catch (error) {
    // Missing app candidates are an expected miss while trying override/build/cache sources.
    logger.debug("[PROTOTYPE_VIEWER] App candidate is unavailable", {
      candidate,
      error: errorMessage(error),
    });
    return false;
  }
}

function isCacheMetadata(
  value: unknown,
): value is Pick<PrototypeViewerMetadata, "sha256" | "size"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "size" in value &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  );
}
