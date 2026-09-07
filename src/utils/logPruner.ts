import path from "path";
import { readdirAsync, statAsync, unlinkAsync } from "./io";

export interface LogPruneOptions {
  /** Directory containing the `.log` files. */
  dir: string;
  /** Prefix identifying the current process's files, e.g. `stdio-12345` or `daemon` (no trailing `.`/`-`). */
  ownPrefix: string;
  /** Cap on the number of this process's own files to retain. */
  maxOwnFiles: number;
  /** Other processes' files older than this (by mtime) are swept once their owner has exited. */
  abandonedMaxAgeMs: number;
  /** Injectable clock for testing. */
  now?: number;
  /** Injectable liveness check for testing; defaults to a signal-0 probe. */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Whether a daemon is currently running (owns the pidfile and is alive).
   *
   * A `daemon-launch-<pid>.log` names the spawning MANAGER's pid, but the fd on
   * that file is inherited by the detached DAEMON child, which keeps writing to
   * it (e.g. an uncaught exception) long after the manager exits — the manager
   * routinely exits right after the daemon reports ready. So the manager pid
   * being dead says nothing about whether the daemon still holds that fd, and
   * the launch log's mtime goes stale quickly even while the daemon is live
   * (steady-state logging goes to `daemon.log`). Unlinking it under those
   * conditions silently loses output the running daemon is still capturing
   * (issue #6194). While a daemon is running, no `daemon-launch-*.log` is swept;
   * once no daemon is running, they become eligible for the ordinary dead-owner
   * + stale-mtime sweep (preserving issue #2724's leak cleanup). Injectable so
   * this module stays decoupled from the daemon pidfile module. Defaults to
   * treating no daemon as running when unset.
   *
   * Only checks the pruning process's OWN daemon namespace. When isolated
   * daemons share a log dir, prefer {@link daemonPidFiles} + {@link readDaemonPid}
   * so a live daemon in ANOTHER namespace also protects its launch log
   * (issue #6194); this predicate is the single-namespace fallback and is
   * OR-ed with the namespace-aware check when both are supplied.
   */
  isDaemonRunning?: () => boolean;
  /**
   * Daemon pid files of every namespace that could own a `daemon-launch-*.log`
   * in `dir` — the pruning process's own plus any co-located sibling namespaces
   * sharing this log dir (issue #6194). A launch log is retained if ANY of these
   * namespaces' daemons is alive, not just the pruning process's own. Injectable
   * (with {@link readDaemonPid}) so this module stays decoupled from the daemon
   * pidfile module and tests stay deterministic.
   */
  daemonPidFiles?: readonly string[];
  /**
   * Read the owning daemon PID from a pid file listed in {@link daemonPidFiles};
   * `undefined` when the file is missing/malformed. Liveness is then checked via
   * the same {@link isProcessAlive} seam used for peer logs.
   */
  readDaemonPid?: (pidFilePath: string) => number | undefined;
  /** Optional diagnostic sink. Kept injectable so log pruning does not import the logger that calls it. */
  logger?: { debug(message: string, ...args: unknown[]): void };
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
 * `stdio-12` never claims `stdio-123`'s files. Filenames are `<prefix>.log`
 * (active) and `<prefix>-<rotation suffix>.log` (rotated).
 *
 * `daemon-launch-<pid>.log` is the manager's launch-capture log — owned by
 * whichever process spawned it, not the daemon — but it textually starts with
 * `daemon-` too, so a bare `startsWith(\`${ownPrefix}-\`)` wrongly claims it for
 * the `daemon` owner. Excluding that one named sub-role keeps the exact-PID-
 * boundary match for everything else (issue #6120).
 */
function isOwnedBy(file: string, ownPrefix: string): boolean {
  if (file === `${ownPrefix}.log`) {
    return true;
  }
  if (!file.startsWith(`${ownPrefix}-`)) {
    return false;
  }
  const rest = file.slice(ownPrefix.length + 1);
  return !/^launch-\d+\.log$/.test(rest);
}

/**
 * Parse the owning PID from a process-scoped log filename:
 * `stdio-<pid>.log` / `stdio-<pid>-<ts>.log`, or the daemon launch-capture log
 * `daemon-launch-<pid>.log` (PID is the spawning manager process). Letting the
 * sweep recognize the launch log keeps it from leaking in the now-stable logs
 * dir once its owner has exited (issue #2724).
 */
function ownerPid(file: string): number | undefined {
  const match = /^(?:stdio|server|daemon-launch)-(\d+)(?:-.*)?\.log$/.exec(file);
  return match ? Number(match[1]) : undefined;
}

/**
 * Whether `file` is a daemon launch-capture log (`daemon-launch-<pid>.log`).
 * The `<pid>` is the spawning manager, but the detached daemon inherits the fd,
 * so these must not be swept purely on the manager's exit (issue #6194).
 */
function isDaemonLaunchLog(file: string): boolean {
  return /^daemon-launch-\d+(?:-.*)?\.log$/.test(file);
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
 * `stdio-<pid>.log` whose mtime is hours old, and the writer keeps appending to
 * the open fd. Deleting it by mtime alone would silently drop that live process's
 * diagnostics. So a peer's log is only removed once its process has exited.
 */
export async function pruneLogFiles(opts: LogPruneOptions): Promise<void> {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const isDaemonRunning = opts.isDaemonRunning ?? (() => false);

  // A daemon-launch log's inherited fd may be held by a LIVE daemon in a namespace
  // OTHER than the pruning process's own when isolated daemons share this log dir
  // (issue #6194). Consider every co-located namespace's pid file, treating a
  // launch log as protected if ANY of those daemons is alive; fall back to the
  // single-namespace `isDaemonRunning` when no pid files were enumerated.
  const anyDaemonHoldsLaunchLog = (): boolean => {
    const pidFiles = opts.daemonPidFiles;
    const readDaemonPid = opts.readDaemonPid;
    if (pidFiles && pidFiles.length > 0 && readDaemonPid) {
      try {
        const anyAlive = pidFiles.some((pidFilePath) => {
          const pid = readDaemonPid(pidFilePath);
          // Reject non-positive/non-integer PIDs (corrupt lock) before probing —
          // `process.kill(0|-1, 0)` targets a whole process group (issue #6260).
          return pid !== undefined && Number.isInteger(pid) && pid > 0 && isAlive(pid);
        });
        if (anyAlive) {
          return true;
        }
      } catch (error) {
        // A pidfile read/probe failure must not green-light unlinking a launch
        // log a live daemon may still hold — retain on ambiguity (issue #6194).
        opts.logger?.debug(`daemon pidfile enumeration for log pruning failed: ${error}`, error);
        return true;
      }
    }
    return isDaemonRunning();
  };

  let entries: string[];
  try {
    entries = await readdirAsync(opts.dir);
  } catch (error) {
    // Startup log pruning is best-effort; an unreadable directory only skips cleanup.
    opts.logger?.debug(
      `log pruning skipped because the log directory could not be read: ${error}`,
      error,
    );
    return;
  }
  const logFiles = entries.filter((f) => f.endsWith(".log"));

  // (a) Cap this process's own files (exact-PID match — never a peer's).
  const ownFiles = logFiles.filter((f) => isOwnedBy(f, opts.ownPrefix)).sort();
  if (ownFiles.length > opts.maxOwnFiles) {
    for (const file of ownFiles.slice(0, ownFiles.length - opts.maxOwnFiles)) {
      await unlinkAsync(path.join(opts.dir, file)).catch(() => {
        /* best effort */
      });
    }
  }

  // (b) Sweep logs left by EXITED processes.
  for (const file of logFiles) {
    if (isOwnedBy(file, opts.ownPrefix)) {
      continue;
    }
    const pid = ownerPid(file);
    if (pid === undefined) {
      continue;
    }
    if (isAlive(pid)) {
      continue; // live peer — never touch its log, even if its mtime is old.
    }
    // A daemon-launch log's fd is held by the detached daemon, not the manager
    // named in the filename. While a daemon is running it may still be writing
    // to that inherited fd, so unlinking on the manager's exit + stale mtime
    // would silently drop live daemon output (issue #6194). Retain all launch
    // logs until no daemon is running.
    if (isDaemonLaunchLog(file) && anyDaemonHoldsLaunchLog()) {
      continue;
    }
    const full = path.join(opts.dir, file);
    try {
      const stats = await statAsync(full);
      if (now - stats.mtimeMs > opts.abandonedMaxAgeMs) {
        await unlinkAsync(full).catch(() => {
          /* best effort */
        });
      }
    } catch {
      // Another process may have removed it concurrently — ignore.
    }
  }
}
