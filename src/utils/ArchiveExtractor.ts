import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ActionableError } from "../models/ActionableError";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "./HostCommandExecutor";

/** Default extraction timeout — a local `tar` unpack should complete well within this. */
const DEFAULT_EXTRACTION_TIMEOUT_MS = 120000;

export interface ArchiveExtractionRequest {
  /** Absolute path to the `.tar.gz` archive to extract. */
  archivePath: string;
  /** Absolute directory the archive contents are written under. */
  destinationDir: string;
  /** Optional per-call timeout; falls back to {@link DEFAULT_EXTRACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Optional cancellation signal wired through to the child process. */
  signal?: AbortSignal;
}

/**
 * Safe archive-extraction boundary. The single production owner of `tar`
 * extraction: it validates source/destination, lists entries and rejects
 * path-traversal / zip-slip before writing anything, invokes `tar` argv-first
 * (never a shell string), and surfaces actionable errors. Inject the
 * interface so consumers stay testable with a fake.
 */
export interface ArchiveExtractor {
  extractTarGz(request: ArchiveExtractionRequest): Promise<void>;
}

/**
 * Reject archive entries that would escape the destination directory
 * (absolute paths, drive-qualified paths, or `..` segments that resolve
 * outside `destinationDir`). Pure and exported so the zip-slip guard can be
 * unit-tested without spawning `tar`.
 *
 * This is a lexical, name-only check. On its own it does not defend against a
 * *symlinked* parent of the destination (a legitimate-looking entry name can
 * still be redirected outside the tree by a symlink), so {@link
 * DefaultArchiveExtractor} additionally extracts into a fresh, realpath'd
 * staging directory and moves the results into place. Keep both guards.
 */
export function assertArchiveEntriesSafe(entries: string[], destinationDir: string): void {
  const resolvedRoot = path.resolve(destinationDir);
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    if (path.isAbsolute(entry) || /^[a-zA-Z]:[\\/]/.test(entry) || entry.startsWith("\\")) {
      throw new ActionableError(
        `Refusing to extract archive entry '${rawEntry}' with an absolute path; the archive may be malicious.`
      );
    }
    const resolvedEntry = path.resolve(resolvedRoot, entry);
    const relativeToRoot = path.relative(resolvedRoot, resolvedEntry);
    if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
      throw new ActionableError(
        `Refusing to extract archive entry '${rawEntry}' that escapes the destination directory; the archive may be malicious (path traversal).`
      );
    }
  }
}

/** Split `tar -tzf` output into individual entry paths. */
function parseTarEntries(listing: string): string[] {
  return listing.split(/\r?\n/).filter(line => line.trim().length > 0);
}

export class DefaultArchiveExtractor implements ArchiveExtractor {
  private readonly executor: HostCommandExecutor;

  constructor(executor: HostCommandExecutor = new DefaultHostCommandExecutor()) {
    this.executor = executor;
  }

  async extractTarGz(request: ArchiveExtractionRequest): Promise<void> {
    const archivePath = path.resolve(request.archivePath);
    const destinationDir = path.resolve(request.destinationDir);
    const timeoutMs = request.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;

    const entries = await this.listEntries(archivePath, timeoutMs, request.signal);
    assertArchiveEntriesSafe(entries, destinationDir);

    await fs.mkdir(destinationDir, { recursive: true });
    // Resolve the destination to its real, symlink-free path, then extract into a
    // fresh staging directory created *inside* it (same filesystem, so the later
    // rename is atomic and never crosses devices). tar writes — including any
    // archive-internal symlink entries — are confined to this staging tree, so a
    // symlinked parent of the destination cannot redirect them outside the
    // intended directory. Only the validated top-level results are then moved
    // into place. On any failure the staging tree is always removed.
    const realDestination = await fs.realpath(destinationDir);
    const stagingDir = await fs.mkdtemp(path.join(realDestination, ".am-extract-"));
    try {
      await this.runExtraction(archivePath, stagingDir, timeoutMs, request.signal);
      await this.moveExtractedInto(stagingDir, realDestination);
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runExtraction(
    archivePath: string,
    stagingDir: string,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.executor.executeCommand(
        "tar",
        ["-xzf", archivePath, "-C", stagingDir],
        { timeoutMs, signal }
      );
    } catch (error) {
      throw new ActionableError(
        `Failed to extract archive '${archivePath}' into '${stagingDir}': ${errorMessage(error)}.`
      );
    }
  }

  /** Move each top-level extracted entry from staging into the destination, replacing any prior copy. */
  private async moveExtractedInto(stagingDir: string, destinationDir: string): Promise<void> {
    const names = await fs.readdir(stagingDir);
    for (const name of names) {
      const from = path.join(stagingDir, name);
      const to = path.join(destinationDir, name);
      await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(from, to);
    }
  }

  private async listEntries(archivePath: string, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
    try {
      const result = await this.executor.executeCommand(
        "tar",
        ["-tzf", archivePath],
        { timeoutMs, signal }
      );
      return parseTarEntries(result.stdout ?? "");
    } catch (error) {
      throw new ActionableError(
        `Unable to inspect archive '${archivePath}' before extraction: ${errorMessage(error)}. ` +
        "The archive may be missing or corrupt."
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
