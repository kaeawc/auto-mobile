import * as fs from "node:fs/promises";
import { ActionableError } from "../models/ActionableError";
import {
  type ChecksumCalculator,
  type Sha256Source,
  DefaultChecksumCalculator,
} from "./ChecksumCalculator";
import { errorMessage } from "./describeUnknownError";
import { type FileDownloader, DefaultFileDownloader } from "./FileDownloader";
import { logger } from "./logger";
import { type Timer, defaultTimer } from "./SystemTimer";

/** The filesystem surface the cache workflow itself touches (metadata sidecar + cleanup). */
export interface VerifiedArtifactFileSystem {
  /** File contents, or null when the file is missing or unreadable. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string, mode?: number): Promise<void>;
  /** Forced removal; a missing path is not an error. */
  remove(path: string): Promise<void>;
  /** Atomic move; replaces an existing destination. */
  rename(from: string, to: string): Promise<void>;
}

export class NodeVerifiedArtifactFileSystem implements VerifiedArtifactFileSystem {
  async readText(path: string): Promise<string | null> {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      // Missing metadata is the normal cold-cache case.
      logger.debug(`Unreadable cache file ${path}: ${errorMessage(error)}`);
      return null;
    }
  }

  async writeText(path: string, content: string, mode?: number): Promise<void> {
    await fs.writeFile(path, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  }

  async remove(path: string): Promise<void> {
    await fs.rm(path, { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }
}

/** Every cache sidecar records the SHA-256 of the downloaded release asset. */
export interface VerifiedArtifactMetadata {
  sha256: string;
}

export interface VerifiedArtifactLookup<M extends VerifiedArtifactMetadata> {
  /** Short log tag, e.g. `[VIDEO_JAR]`. */
  label: string;
  /** What is cached, for the "no usable cached <subject> metadata" log, e.g. `helper`. */
  subject: string;
  expectedSha256: string;
  metadataPath: string;
  /** Narrow parsed sidecar JSON; return null for a stale or foreign schema. */
  parseMetadata(value: unknown): M | null;
  /** Check the cached artifact itself (size, mode, controller file, re-hash...). */
  verifyArtifact(metadata: M): Promise<boolean>;
}

export interface VerifiedArtifactDownload {
  label: string;
  /**
   * Pinned SHA-256, or null to explicitly opt out of hashing (an unverified development
   * build; the caller owns warning about that). An empty string is NOT an opt-out: it can
   * never match, so it fails closed as a mismatch.
   */
  expectedSha256: string | null;
  url: string;
  /**
   * Temporary path the asset is downloaded to; the cache removes it on failure and never
   * touches any already-cached artifact. Use `finalPath` to move the verified asset into
   * place atomically.
   */
  archivePath: string;
  /** When set, the verified archive is renamed here after `publish`, replacing any old copy. */
  finalPath?: string;
  /** Sidecar location; omit for callers that keep their own metadata (or none). */
  metadataPath?: string;
  metadataMode?: number;
  /** Abort the download after this long; omit for no timeout. */
  downloadTimeoutMs?: number;
  /** Error to surface when the timeout aborted the download; omit to rethrow the abort. */
  timeoutError?(): ActionableError;
  mismatchError(expected: string, actual: string): Error;
  /** Runs right after the download and before hashing (e.g. restrict file mode). */
  afterDownload?(archivePath: string): Promise<void>;
  /**
   * Validate and move the verified asset into place; returns the sidecar to write
   * (its `sha256` must be the verified `actual`). Skipped when omitted.
   */
  publish?(
    archivePath: string,
    actualSha256: string | null,
    source: Sha256Source | null,
  ): Promise<object | void>;
  /** Failure cleanup beyond the archive itself (partial extracts, published entries). */
  discard?(): Promise<void>;
  /** Always runs last, success or failure. */
  settle?(): Promise<void>;
}

export interface VerifiedArtifactCacheDeps {
  downloader?: FileDownloader;
  checksumCalculator?: ChecksumCalculator;
  fileSystem?: VerifiedArtifactFileSystem;
  timer?: Timer;
}

/**
 * The shared "check cache, download, verify SHA-256, publish, write sidecar" workflow
 * behind the release-asset providers. Providers keep what genuinely differs (where files
 * live, how a cached artifact is validated, how an archive is unpacked and published) as
 * hooks; this class owns the sidecar match, the download timeout, the checksum gate, the
 * metadata write and failure cleanup, so a mismatched asset is never published.
 */
export class VerifiedArtifactCache {
  private readonly downloader: FileDownloader;
  private readonly checksumCalculator: ChecksumCalculator;
  private readonly fileSystem: VerifiedArtifactFileSystem;
  private readonly timer: Timer;

  constructor(deps: VerifiedArtifactCacheDeps = {}) {
    this.downloader = deps.downloader ?? new DefaultFileDownloader();
    this.checksumCalculator = deps.checksumCalculator ?? new DefaultChecksumCalculator();
    this.fileSystem = deps.fileSystem ?? new NodeVerifiedArtifactFileSystem();
    this.timer = deps.timer ?? defaultTimer;
  }

  /** True iff the sidecar matches the expected SHA-256 and the artifact still verifies. */
  async isCached<M extends VerifiedArtifactMetadata>(
    lookup: VerifiedArtifactLookup<M>,
  ): Promise<boolean> {
    const raw = await this.fileSystem.readText(lookup.metadataPath);
    if (raw === null) {
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Corrupt metadata is repaired by downloading again.
      logger.debug(`${lookup.label} No usable cached ${lookup.subject} metadata`, {
        error: errorMessage(error),
      });
      return false;
    }
    const metadata = lookup.parseMetadata(parsed);
    if (metadata === null) {
      // Stale metadata schemas are expected after upgrades; download rewrites them.
      logger.debug(`${lookup.label} No usable cached ${lookup.subject} metadata`, {
        reason: "Unexpected metadata schema",
      });
      return false;
    }
    if (metadata.sha256.toLowerCase() !== lookup.expectedSha256.toLowerCase()) {
      return false;
    }
    return lookup.verifyArtifact(metadata);
  }

  /** Download, verify against the pinned SHA-256, publish and record the sidecar. */
  async fetch(request: VerifiedArtifactDownload): Promise<void> {
    const controller = new AbortController();
    const timeout =
      request.downloadTimeoutMs === undefined
        ? null
        : this.timer.setTimeout(() => controller.abort(), request.downloadTimeoutMs);
    try {
      await this.downloader.download(
        request.url,
        request.archivePath,
        request.downloadTimeoutMs === undefined ? undefined : controller.signal,
      );
      await request.afterDownload?.(request.archivePath);
      const { checksum: actual, source } = await this.verify(request);
      const metadata = await request.publish?.(request.archivePath, actual, source);
      await this.commit(request, metadata);
    } catch (error) {
      await this.discard(request);
      if (controller.signal.aborted && request.timeoutError) {
        throw request.timeoutError();
      }
      throw error;
    } finally {
      if (timeout !== null) {
        this.timer.clearTimeout(timeout);
      }
      await request.settle?.();
    }
  }

  /** Move the verified archive into place, then record the sidecar. */
  private async commit(request: VerifiedArtifactDownload, metadata: object | void): Promise<void> {
    if (request.finalPath !== undefined) {
      await this.fileSystem.rename(request.archivePath, request.finalPath);
    }
    if (request.metadataPath !== undefined && metadata) {
      await this.fileSystem.writeText(
        request.metadataPath,
        JSON.stringify(metadata, null, 2),
        request.metadataMode,
      );
    }
  }

  /** Hash and compare against the pinned SHA-256; both null when no pin is configured. */
  private async verify(
    request: VerifiedArtifactDownload,
  ): Promise<{ checksum: string | null; source: Sha256Source | null }> {
    if (request.expectedSha256 === null) {
      return { checksum: null, source: null };
    }
    const result = await this.checksumCalculator.computeFileSha256(request.archivePath);
    if (result.checksum.toLowerCase() !== request.expectedSha256.toLowerCase()) {
      throw request.mismatchError(request.expectedSha256, result.checksum);
    }
    return result;
  }

  /** Cleanup must never replace the failure that triggered it. */
  private async discard(request: VerifiedArtifactDownload): Promise<void> {
    try {
      await Promise.all([this.fileSystem.remove(request.archivePath), request.discard?.()]);
    } catch (error) {
      logger.warn(
        `${request.label} Failed to remove partial download (${request.archivePath} and related files): ${errorMessage(error)}`,
        error,
      );
    }
  }
}
