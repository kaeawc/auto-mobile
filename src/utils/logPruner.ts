import path from "path";
import { readdirAsync, statAsync, unlinkAsync } from "./io";

export interface LogPruneOptions {
  /** Directory containing the `.log` files. */
  dir: string;
  /** Filename prefix that identifies the current process's own files, e.g. `server-12345`. */
  ownPrefix: string;
  /** Cap on the number of this process's own files to retain. */
  maxOwnFiles: number;
  /** Other processes' files older than this (by mtime) are swept. */
  abandonedMaxAgeMs: number;
  /** Injectable clock for testing. */
  now?: number;
}

/**
 * Prune log files for a directory shared by many parallel processes (one stdio
 * proxy per agent + the daemon).
 *
 *  (a) Cap THIS process's own files (`ownPrefix*`) to `maxOwnFiles`.
 *  (b) Delete OTHER processes' files only when they are stale by mtime.
 *
 * It never deletes another live process's current file: a live process keeps its
 * active log's mtime recent, so the age check spares it. This avoids the
 * cross-process deletion races of a global "sort all and trim" prune.
 */
export async function pruneLogFiles(opts: LogPruneOptions): Promise<void> {
  const now = opts.now ?? Date.now();

  let entries: string[];
  try {
    entries = await readdirAsync(opts.dir);
  } catch {
    return;
  }
  const logFiles = entries.filter(f => f.endsWith(".log"));

  // (a) Cap this process's own files (safe — only our PID's files).
  const ownFiles = logFiles.filter(f => f.startsWith(opts.ownPrefix)).sort();
  if (ownFiles.length > opts.maxOwnFiles) {
    for (const file of ownFiles.slice(0, ownFiles.length - opts.maxOwnFiles)) {
      await unlinkAsync(path.join(opts.dir, file)).catch(() => { /* best effort */ });
    }
  }

  // (b) Sweep stale logs left by exited processes.
  for (const file of logFiles) {
    if (file.startsWith(opts.ownPrefix)) {
      continue;
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
