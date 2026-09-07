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
 * undiscoverable namespace may still hold the inherited fd. It remains retained
 * until an owner is positively absent or dead; age is not ownership evidence.
 */
export interface DaemonPidFileEnumeration {
  /** Daemon pid files this enumeration could discover (always includes the caller's own). */
  pidFiles: readonly string[];
  /** True when discovery is incomplete/failed — retain launch logs. */
  uncertain: boolean;
}

/**
 * Ownership declaration read from a daemon PID file for launch-log retention.
 * `launchLogPath: null` means this daemon was directly launched and owns no
 * manager capture log. An absent field belongs to an older PID record and is
 * intentionally represented as `undefined`: its ownership is unknown.
 */
export interface DaemonLaunchLogOwner {
  pid: number;
  launchLogPath: string | null | undefined;
}

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
  /** Single-namespace fallback used only when ownership discovery is unavailable. */
  isDaemonRunning?: () => boolean;
  /**
   * Enumerate the daemon pid files of every namespace that could own a
   * `daemon-launch-*.log` in `dir` — the pruning process's own plus any
   * co-located sibling namespaces sharing this log dir (issue #6194) — together
   * with whether that enumeration is complete ({@link DaemonPidFileEnumeration}).
   *
   * Passed as a THUNK, evaluated LAZILY inside {@link pruneLogFiles} at
   * sweep time — never at logger-module init, whose eager evaluation crashed the
   * cyclic `logger`↔`daemonFiles` import before `logger` was initialized
   * (issue #6194). Injectable (with {@link readDaemonOwner}) so this module stays
   * decoupled from the daemon pidfile module and tests stay deterministic.
   */
  daemonPidFiles?: () => DaemonPidFileEnumeration;
  /**
   * Read the owner declaration from a pid file listed in
   * {@link DaemonPidFileEnumeration.pidFiles}. `undefined` means the file is
   * confidently absent; an unreadable/malformed file must THROW. An owner record
   * without `launchLogPath` is legacy/ambiguous and retains launch logs.
   */
  readDaemonOwner?: (pidFilePath: string) => DaemonLaunchLogOwner | undefined;
  /**
   * Read the durable, exact owner declaration left alongside one launch log
   * when its daemon removes the transient PID record during shutdown. Like a
   * PID record reader, an unreadable or malformed tombstone must THROW so the
   * sweep retains the log rather than guessing that its owner exited.
   */
  readDaemonLaunchLogOwnerTombstone?: (launchLogPath: string) => DaemonLaunchLogOwner | undefined;
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

async function removeLaunchLogTombstone(launchLogPath: string): Promise<void> {
  await unlinkAsync(`${launchLogPath}.owner`).catch(() => {
    /* the sidecar is owned by the launch log and may already be gone */
  });
}

async function pruneStaleLog(
  fullPath: string,
  file: string,
  now: number,
  abandonedMaxAgeMs: number,
): Promise<void> {
  try {
    const stats = await statAsync(fullPath);
    if (now - stats.mtimeMs <= abandonedMaxAgeMs) {
      return;
    }
    const removed = await unlinkAsync(fullPath)
      .then(() => true)
      .catch(() => false);
    if (removed && isDaemonLaunchLog(file)) {
      await removeLaunchLogTombstone(fullPath);
    }
  } catch {
    // Another process may have removed it concurrently — ignore.
  }
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

  type LaunchLogProtection = "alive" | "dead" | "unknown";

  // A launch log is protected only by its associated daemon, never by a live
  // daemon from another namespace. Discovery/read uncertainty and legacy PID
  // records are carried to the individual verdict rather than flattened into a
  // global "some daemon is alive" boolean.
  let discovery: { owners: readonly DaemonLaunchLogOwner[]; uncertain: boolean } | undefined;
  const discoverDaemonLaunchLogOwners = (): {
    owners: readonly DaemonLaunchLogOwner[];
    uncertain: boolean;
  } => {
    if (discovery !== undefined) {
      return discovery;
    }
    const enumerate = opts.daemonPidFiles;
    const readDaemonOwner = opts.readDaemonOwner;
    if (enumerate && readDaemonOwner) {
      try {
        // Evaluated lazily here (not at logger init) so the cyclic
        // `logger`↔`daemonFiles` import can't reach it before `logger` exists.
        const { pidFiles, uncertain } = enumerate();
        discovery = {
          owners: pidFiles.flatMap((pidFilePath) => {
            const owner = readDaemonOwner(pidFilePath);
            return owner === undefined ? [] : [owner];
          }),
          uncertain,
        };
      } catch (error) {
        // A pidfile enumeration/read failure must not green-light unlinking.
        opts.logger?.debug(`daemon pidfile enumeration for log pruning failed: ${error}`, error);
        discovery = { owners: [], uncertain: true };
      }
      return discovery;
    }
    discovery = { owners: [], uncertain: isDaemonRunning() };
    return discovery;
  };

  const daemonLaunchLogProtection = (file: string): LaunchLogProtection => {
    const { owners, uncertain } = discoverDaemonLaunchLogOwners();
    const filePath = path.resolve(opts.dir, file);
    const exactOwners = owners.filter(
      (candidate) =>
        typeof candidate.launchLogPath === "string" &&
        path.resolve(candidate.launchLogPath) === filePath,
    );
    try {
      const tombstone = opts.readDaemonLaunchLogOwnerTombstone?.(filePath);
      // A tombstone is tied only to a path today, not to a particular file
      // generation. A manager PID can be reused and truncate the same path
      // before a stale namespace cleanup publishes its former owner's
      // tombstone. In that case the sidecar cannot disprove an undiscovered
      // live owner, so it must not override incomplete discovery.
      if (tombstone !== undefined && !uncertain) {
        exactOwners.push(tombstone);
      }
    } catch (error) {
      opts.logger?.debug(`launch-log ownership tombstone read failed: ${error}`, error);
      return "unknown";
    }
    if (exactOwners.length > 0) {
      // Several namespaces can retain declarations for the same manager PID
      // after PID reuse. Every exact claim must be considered: one live daemon
      // still holds the inherited fd, even if an earlier stale claim is dead.
      return exactOwners.some(
        (owner) => Number.isInteger(owner.pid) && owner.pid > 0 && isAlive(owner.pid),
      )
        ? "alive"
        : "dead";
    }
    // Without an exact owner association, incomplete discovery means an
    // undiscovered daemon may still hold this inherited descriptor.
    if (uncertain) {
      return "unknown";
    }
    // A missing field is a legacy record: it may own any launch log. A complete
    // set of explicit claims (path or null) proves this log has no live owner.
    return owners.some((candidate) => candidate.launchLogPath === undefined) ? "unknown" : "dead";
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
    // would silently drop live daemon output (issue #6194). A matching live
    // owner, incomplete discovery, or legacy record retains this log; only a
    // matching dead owner or a complete set of explicit non-claims permits the
    // ordinary abandoned-log cleanup.
    if (isDaemonLaunchLog(file)) {
      const protection = daemonLaunchLogProtection(file);
      if (protection !== "dead") {
        continue;
      }
    }
    await pruneStaleLog(path.join(opts.dir, file), file, now, opts.abandonedMaxAgeMs);
  }
}
