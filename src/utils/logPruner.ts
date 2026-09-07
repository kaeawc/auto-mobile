import path from "path";
import { readdirAsync, statAsync, unlinkAsync } from "./io";

/**
 * Result of enumerating the daemon pid files that could own a `daemon-launch-*.log`
 * in a shared log dir, plus whether that enumeration is COMPLETE.
 *
 * `uncertain` is the fail-closed signal (issue #6194): it is set when daemon
 * discovery could not be exhaustive — a custom pid-file namespace whose siblings
 * may live in directories this scan can't see, or a failed directory scan. When
 * uncertain, a launch log is retained past the ordinary {@link LogPruneOptions.abandonedMaxAgeMs}
 * even if none of the discovered pids is alive, because a live daemon in an
 * undiscoverable namespace may still hold the inherited fd. It is NOT retained
 * forever, though: the production enumerator (`listDaemonPidFilesSync`) can
 * never resolve `uncertain` to `false` for a custom pid-file namespace, so
 * treating uncertainty as permanent retention would leak one launch log per
 * daemon start, unbounded, on every host that uses a custom namespace — see
 * {@link LogPruneOptions.uncertainAbandonedMaxAgeMs}. A launch log is unlinked
 * on the ordinary, shorter horizon only when it is CONFIDENTLY established
 * (uncertain === false and no discovered/own daemon alive) that no live daemon
 * owns it.
 */
export interface DaemonPidFileEnumeration {
  /** Daemon pid files this enumeration could discover (always includes the caller's own). */
  pidFiles: readonly string[];
  /** True when discovery is incomplete/failed — retain launch logs past the extended horizon. */
  uncertain: boolean;
}

/**
 * Extended retention horizon applied to a `daemon-launch-*.log` when daemon
 * discovery is UNCERTAIN rather than confidently clear. A custom pid-file
 * namespace can never make `uncertain` resolve to `false` (its siblings may
 * live in a directory a scan never visits), so gating cleanup on `uncertain`
 * alone — as the prior fix for issue #6194 did — retains every uncertain
 * namespace's launch logs forever and reopens the unbounded-growth problem the
 * ordinary `abandonedMaxAgeMs` sweep exists to prevent (issue #6194, round 3).
 * Seven days is long enough that no real daemon session plausibly still holds
 * the fd, while still bounding disk usage on a long-lived host.
 */
const DEFAULT_UNCERTAIN_ABANDONED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface LogPruneOptions {
  /** Directory containing the `.log` files. */
  dir: string;
  /** Prefix identifying the current process's files, e.g. `stdio-12345` or `daemon` (no trailing `.`/`-`). */
  ownPrefix: string;
  /** Cap on the number of this process's own files to retain. */
  maxOwnFiles: number;
  /** Other processes' files older than this (by mtime) are swept once their owner has exited. */
  abandonedMaxAgeMs: number;
  /**
   * Age threshold applied to a `daemon-launch-*.log` specifically when daemon
   * discovery reports `uncertain` (not confidently clear, not confidently
   * alive) — see {@link DEFAULT_UNCERTAIN_ABANDONED_MAX_AGE_MS}. Defaults to
   * that 7-day constant when unset; independent of `abandonedMaxAgeMs` so a
   * caller (e.g. a test) can shrink the ordinary sweep window without also
   * shortening the fail-closed uncertain horizon.
   */
  uncertainAbandonedMaxAgeMs?: number;
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
   * Enumerate the daemon pid files of every namespace that could own a
   * `daemon-launch-*.log` in `dir` — the pruning process's own plus any
   * co-located sibling namespaces sharing this log dir (issue #6194) — together
   * with whether that enumeration is complete ({@link DaemonPidFileEnumeration}).
   *
   * A launch log is retained if ANY discovered namespace's daemon is alive OR the
   * enumeration reports `uncertain` (an undiscoverable custom namespace may hold
   * the fd). Passed as a THUNK, evaluated LAZILY inside {@link pruneLogFiles} at
   * sweep time — never at logger-module init, whose eager evaluation crashed the
   * cyclic `logger`↔`daemonFiles` import before `logger` was initialized
   * (issue #6194). Injectable (with {@link readDaemonPid}) so this module stays
   * decoupled from the daemon pidfile module and tests stay deterministic.
   */
  daemonPidFiles?: () => DaemonPidFileEnumeration;
  /**
   * Read the owning daemon PID from a pid file listed in
   * {@link DaemonPidFileEnumeration.pidFiles}. Returns `undefined` only for a
   * CONFIDENTLY-absent file (no daemon recorded in that namespace); a present but
   * unreadable/malformed file is AMBIGUOUS and must THROW so the launch log is
   * retained (fail closed) rather than treated as absent and pruned (issue #6194).
   * Liveness of a returned pid is checked via the same {@link isProcessAlive} seam
   * used for peer logs.
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
  //
  // Tri-state rather than boolean: "alive" (skip unconditionally — a confirmed
  // live daemon may hold the fd), "clear" (confidently no daemon anywhere —
  // ordinary `abandonedMaxAgeMs` sweep applies), or "uncertain" (discovery could
  // not be exhaustive — swept only past the longer
  // `uncertainAbandonedMaxAgeMs` horizon, not retained forever; see
  // {@link DEFAULT_UNCERTAIN_ABANDONED_MAX_AGE_MS}).
  const computeDaemonLaunchLogProtection = (): "alive" | "uncertain" | "clear" => {
    const enumerate = opts.daemonPidFiles;
    const readDaemonPid = opts.readDaemonPid;
    if (enumerate && readDaemonPid) {
      try {
        // Evaluated lazily here (not at logger init) so the cyclic
        // `logger`↔`daemonFiles` import can't reach it before `logger` exists.
        const { pidFiles, uncertain } = enumerate();
        const anyAlive = pidFiles.some((pidFilePath) => {
          // A present-but-unreadable pid file THROWS out of readDaemonPid and is
          // caught below as ambiguity; only a CONFIDENTLY-absent file is undefined.
          const pid = readDaemonPid(pidFilePath);
          // Reject non-positive/non-integer PIDs (corrupt lock) before probing —
          // `process.kill(0|-1, 0)` targets a whole process group (issue #6260).
          return pid !== undefined && Number.isInteger(pid) && pid > 0 && isAlive(pid);
        });
        if (anyAlive) {
          return "alive";
        }
        // Discovery was incomplete (an undiscoverable custom namespace, a failed
        // scan): a live daemon we could not enumerate may still hold the fd, so
        // retain past the extended horizon rather than the ordinary one.
        if (uncertain) {
          return "uncertain";
        }
        return "clear";
      } catch (error) {
        // A pidfile enumeration/read/probe failure must not green-light unlinking
        // a launch log a live daemon may still hold — retain on ambiguity (#6194).
        opts.logger?.debug(`daemon pidfile enumeration for log pruning failed: ${error}`, error);
        return "uncertain";
      }
    }
    return isDaemonRunning() ? "alive" : "clear";
  };

  // The retention decision above is invariant for the whole sweep: it depends
  // only on daemon-namespace state, never on which file is being considered. A
  // directory with a backlog of dead-manager launch logs would otherwise redo a
  // full PID-directory scan + per-file reads once PER launch log (issue #6194) —
  // O(launch logs × pid files) synchronous filesystem work blocking the event
  // loop. Compute it at most once, lazily (only if a launch log is actually
  // encountered), and reuse the cached verdict for the rest of this sweep.
  let cachedProtection: "alive" | "uncertain" | "clear" | undefined;
  const daemonLaunchLogProtection = (): "alive" | "uncertain" | "clear" => {
    if (cachedProtection === undefined) {
      cachedProtection = computeDaemonLaunchLogProtection();
    }
    return cachedProtection;
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
    // would silently drop live daemon output (issue #6194). A CONFIRMED live
    // daemon retains the log unconditionally; UNCERTAIN discovery retains it
    // only past a much longer horizon rather than forever, so a genuinely
    // undiscoverable custom namespace still gets swept eventually instead of
    // leaking one launch log per daemon start (issue #6194, round 3).
    let effectiveMaxAgeMs = opts.abandonedMaxAgeMs;
    if (isDaemonLaunchLog(file)) {
      const protection = daemonLaunchLogProtection();
      if (protection === "alive") {
        continue;
      }
      if (protection === "uncertain") {
        effectiveMaxAgeMs =
          opts.uncertainAbandonedMaxAgeMs ?? DEFAULT_UNCERTAIN_ABANDONED_MAX_AGE_MS;
      }
    }
    const full = path.join(opts.dir, file);
    try {
      const stats = await statAsync(full);
      if (now - stats.mtimeMs > effectiveMaxAgeMs) {
        await unlinkAsync(full).catch(() => {
          /* best effort */
        });
      }
    } catch {
      // Another process may have removed it concurrently — ignore.
    }
  }
}
