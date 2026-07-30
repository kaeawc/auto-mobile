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

    try {
      await this.executor.executeCommand(
        "tar",
        ["-xzf", archivePath, "-C", destinationDir],
        { timeoutMs, signal: request.signal }
      );
    } catch (error) {
      throw new ActionableError(
        `Failed to extract archive '${archivePath}' into '${destinationDir}': ${errorMessage(error)}.`
      );
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
