import path from "path";
import { readdirAsync, statAsync, unlinkAsync } from "./io";

export interface LogPruneOptions {
  /** Directory containing the `.log` files. */
  dir: string;
  /** Prefix identifying the current process's files, e.g. `server-12345` (no trailing `.`/`-`). */
  ownPrefix: string;
  /** Cap on the number of this process's own files to retain. */
  maxOwnFiles: number;
  /** Other processes' files older than this (by mtime) are swept once their owner has exited. */
  abandonedMaxAgeMs: number;
  /** Injectable clock for testing. */
  now?: number;
  /** Injectable liveness check for testing; defaults to a signal-0 probe. */
  isProcessAlive?: (pid: number) => boolean;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH → no such process (dead). EPERM → process exists but isn't ours (alive).
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Whether `file` belongs to `ownPrefix`, matched on an exact PID boundary so
 * `server-12` never claims `server-123`'s files. Filenames are `server-<pid>.log`
 * (active) and `server-<pid>-<ts>.log` (rotated).
 */
function isOwnedBy(file: string, ownPrefix: string): boolean {
  return file === `${ownPrefix}.log` || file.startsWith(`${ownPrefix}-`);
}

/** Parse the owning PID from `server-<pid>.log` / `server-<pid>-<ts>.log`. */
function ownerPid(file: string): number | undefined {
  const match = /^server-(\d+)(?:-.*)?\.log$/.exec(file);
  return match ? Number(match[1]) : undefined;
}

/**
 * Prune log files for a directory shared by many parallel processes (one stdio
 * client per agent + the daemon).
 *
 *  (a) Cap THIS process's own files (`ownPrefix`, exact PID boundary) to
 *      `maxOwnFiles`.
 *  (b) Sweep OTHER processes' files only when their owning PID is no longer
 *      alive AND the file is stale by mtime.
 *
 * (b)'s liveness gate is essential: a still-running process can have a quiet
 * `server-<pid>.log` whose mtime is hours old, and the writer keeps appending to
 * the open fd. Deleting it by mtime alone would silently drop that live process's
 * diagnostics. So a peer's log is only removed once its process has exited.
 */
export async function pruneLogFiles(opts: LogPruneOptions): Promise<void> {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;

  let entries: string[];
  try {
    entries = await readdirAsync(opts.dir);
  } catch {
    return;
  }
  const logFiles = entries.filter(f => f.endsWith(".log"));

  // (a) Cap this process's own files (exact-PID match — never a peer's).
  const ownFiles = logFiles.filter(f => isOwnedBy(f, opts.ownPrefix)).sort();
  if (ownFiles.length > opts.maxOwnFiles) {
    for (const file of ownFiles.slice(0, ownFiles.length - opts.maxOwnFiles)) {
      await unlinkAsync(path.join(opts.dir, file)).catch(() => { /* best effort */ });
    }
  }

  // (b) Sweep logs left by EXITED processes.
  for (const file of logFiles) {
    if (isOwnedBy(file, opts.ownPrefix)) {
      continue;
    }
    const pid = ownerPid(file);
    if (pid !== undefined && isAlive(pid)) {
      continue; // live peer — never touch its log, even if its mtime is old.
    }
    const full = path.join(opts.dir, file);
    try {
      const stats = await statAsync(full);
      if (now - stats.mtimeMs > opts.abandonedMaxAgeMs) {
        await unlinkAsync(full).catch(() => { /* best effort */ });
      }
    } catch {
      // Another process may have removed it concurrently — ignore.
    }
  }
}
