import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ActionableError } from "../models/ActionableError";
import { DefaultHostCommandExecutor, type HostCommandExecutor } from "./HostCommandExecutor";
import { logger } from "./logger";

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
    // Reject any drive-letter prefix, with or without a following separator: a
    // *drive-relative* entry like `C:evil` (no slash) is not caught by
    // path.isAbsolute on POSIX but resolves against another drive's cwd on Windows.
    if (path.isAbsolute(entry) || /^[a-zA-Z]:/.test(entry) || entry.startsWith("\\")) {
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
    // rename is atomic and never crosses devices). Extracting into the realpath'd
    // staging tree confines writes when a *parent* of the destination is a symlink.
    // It does NOT, on its own, contain a symlink *member* of the archive: the
    // lexical name check never sees entry types, and tar happily creates a symlink
    // pointing outside the tree. `assertStagedSymlinksSafe` is the guard that
    // actually rejects those, after extraction and before anything is moved into
    // place. On any failure the staging tree is always removed — with its
    // permissions restored first, so a restrictive archive-set directory mode
    // (e.g. a `0555` `./` member) cannot strand it.
    const realDestination = await fs.realpath(destinationDir);
    const stagingDir = await fs.mkdtemp(path.join(realDestination, ".am-extract-"));
    try {
      await this.runExtraction(archivePath, stagingDir, timeoutMs, request.signal);
      await assertStagedSymlinksSafe(stagingDir, realDestination);
      // A malicious `./` member can leave the staging root unwritable, which would
      // fail the rename below; restore owner write/traverse before moving.
      await fs.chmod(stagingDir, 0o700).catch(() => undefined);
      await this.moveExtractedInto(stagingDir, realDestination);
    } finally {
      await removeStagingTree(stagingDir);
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
      try {
        await fs.rm(to, { recursive: true, force: true });
      } catch (error) {
        // Best-effort removal of a prior copy; the rename below still overwrites or
        // reports. Log so a surprising failure here leaves a trace.
        logger.debug(`could not remove prior '${to}' before move: ${errorMessage(error)}`);
      }
      try {
        await fs.rename(from, to);
      } catch (error) {
        throw new ActionableError(
          `Failed to move extracted entry into place ('${from}' -> '${to}'): ${errorMessage(error)}.`
        );
      }
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

/**
 * Reject any staged symlink member whose target would resolve outside the
 * destination once the tree is moved into place. A self-contained link (target
 * stays inside the destination, e.g. a versioned `lib/*.dylib` link) is allowed;
 * an escaping link (absolute target, or a relative target that climbs past the
 * root) is rejected. `tar` creates symlink members without complaint and the
 * lexical name check never sees their type, so this is the guard that contains
 * them. Targets are validated against each link's *final* location under the
 * destination, since a relative target's meaning shifts when the tree is moved.
 */
async function assertStagedSymlinksSafe(stagingDir: string, destinationDir: string): Promise<void> {
  const dirents = await fs.readdir(stagingDir, { withFileTypes: true });
  for (const dirent of dirents) {
    const entryPath = path.join(stagingDir, dirent.name);
    if (dirent.isSymbolicLink()) {
      const relFromStaging = path.relative(stagingDir, entryPath);
      const finalLinkPath = path.join(destinationDir, relFromStaging);
      const target = await fs.readlink(entryPath);
      const resolvedTarget = path.resolve(path.dirname(finalLinkPath), target);
      const relToRoot = path.relative(destinationDir, resolvedTarget);
      if (relToRoot === ".." || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot)) {
        throw new ActionableError(
          `Refusing to extract archive symlink '${relFromStaging}' -> '${target}' ` +
          "that escapes the destination directory; the archive may be malicious."
        );
      }
    } else if (dirent.isDirectory()) {
      // Recurse into real subdirectories only — never follow a symlinked directory.
      await assertStagedSymlinksSafe(entryPath, destinationDir);
    }
  }
}

/**
 * Remove the staging tree, restoring owner write/traverse permissions first so a
 * restrictive archive-set directory mode (e.g. a `0555` or `000` `./` member)
 * cannot strand the `.am-extract-*` directory. Best-effort: the mkdtemp name is
 * unique, so a leftover is harmless, but log it rather than swallowing silently.
 */
async function removeStagingTree(stagingDir: string): Promise<void> {
  try {
    await restoreOwnerWritable(stagingDir);
    await fs.rm(stagingDir, { recursive: true, force: true });
  } catch (error) {
    logger.debug(`best-effort staging cleanup failed for '${stagingDir}': ${errorMessage(error)}`);
  }
}

/** Recursively grant owner rwx on every real directory so removal can proceed. */
async function restoreOwnerWritable(dir: string): Promise<void> {
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const dirents: Dirent[] = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const dirent of dirents) {
    if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
      await restoreOwnerWritable(path.join(dir, dirent.name));
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
