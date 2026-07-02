import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ActionableError } from "../models";
import { getDatabasePath } from "../db";
import { logger } from "../utils/logger";
import { DaemonManager } from "./manager";
import { readPidFileDataSync } from "./daemonFiles";
import type { PidFileData } from "./types";

/**
 * A live daemon process paired with the resolved SQLite file it owns.
 *
 * `dbPath` is `undefined` when we cannot determine which DB file the daemon
 * owns (e.g. it belongs to another worktree whose PID file we don't read). An
 * unknown path NEVER matches, so an undeterminable daemon can't trigger a
 * false-positive refusal — the guard is file-scoped, not daemon-existence.
 */
export interface DaemonDbOwner {
  pid: number;
  dbPath: string | undefined;
}

/**
 * Injectable dependencies for the direct-mode DB-ownership guard. Keeping these
 * behind an interface lets tests supply fakes with no real process table or DB.
 */
export interface DirectModeGuardDeps {
  /** Resolved DB path THIS process would open (see {@link getDatabasePath}). */
  resolveDbPath: () => string;
  /** Live daemon processes paired with the DB file each one owns. */
  findLiveDaemonDbOwners: () => DaemonDbOwner[];
}

/** Minimal surface of {@link DaemonManager} the default deps rely on. */
export interface LiveDaemonProcessSource {
  findLiveDaemonProcesses: () => number[];
}

export interface DefaultDirectModeGuardDepsOptions {
  manager?: LiveDaemonProcessSource;
  readPidFileData?: (pidFilePath?: string) => PidFileData | null;
  resolveDbPath?: () => string;
}

/**
 * Canonicalize a DB path for equality comparison. Textual `resolve()` alone
 * under-refuses when the daemon and the direct-mode process reach the same file
 * through different symlink forms (e.g. a symlinked home/data dir on macOS:
 * `/Users/x` vs `/System/Volumes/Data/Users/x`). The DB file may not exist yet,
 * so we realpath the deepest existing ancestor and re-append the remainder,
 * falling back to textual normalization only when nothing on the path exists.
 */
function normalizeDbPath(dbPath: string): string {
  const absolute = resolve(dbPath);
  try {
    return realpathSync(absolute);
  } catch {
    // File itself doesn't exist yet — canonicalize the nearest existing ancestor.
    try {
      return resolve(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      // Ancestor also missing (fresh install, no daemon can own it yet) — textual
      // normalization is the best available; both processes resolve os.homedir()
      // identically in that case.
      return absolute;
    }
  }
}

/**
 * Find the live daemons that own the SAME resolved DB file this process would
 * open. File-scoped by construction: a daemon on a different DB path never
 * matches, so the `AUTOMOBILE_DB_PATH` escape hatch is preserved (no
 * false-positive refusal), and an owner whose path is unknown never matches.
 */
export function findConflictingDaemons(deps: DirectModeGuardDeps): DaemonDbOwner[] {
  const ourDbPath = normalizeDbPath(deps.resolveDbPath());
  return deps
    .findLiveDaemonDbOwners()
    .filter(owner => owner.dbPath !== undefined && normalizeDbPath(owner.dbPath) === ourDbPath);
}

/**
 * Refuse direct mode (`--no-proxy` / `--direct`) when a live daemon already owns
 * the SAME SQLite file this process would open.
 *
 * The concurrency model is a single bun:sqlite connection guarded by an
 * in-process async mutex; it gives NO cross-process guarantee. Two processes on
 * one DB file degrade to `SQLITE_BUSY` stalls and competing per-process
 * migrations. Proxy mode gets singleton enforcement from {@link DaemonManager};
 * direct mode never did — this closes that gap (issue #2795).
 *
 * Throws an {@link ActionableError} that names the resolved DB path, the flag,
 * and the `AUTOMOBILE_DB_PATH` escape hatch. Direct-mode-vs-direct-mode peers on
 * one file with no daemon are the case the `<db>.owner.lock` in #2794 covers.
 */
export function assertDirectModeDbOwnership(deps: DirectModeGuardDeps): void {
  const conflicting = findConflictingDaemons(deps);
  if (conflicting.length === 0) {
    return;
  }

  const ourDbPath = normalizeDbPath(deps.resolveDbPath());
  const pids = conflicting.map(owner => owner.pid).join(", ");
  throw new ActionableError(
    `A live AutoMobile daemon (pid ${pids}) already owns the database at ${ourDbPath}. ` +
      `Direct mode (--no-proxy/--direct) would open a second writer on the same SQLite file, ` +
      `causing SQLITE_BUSY stalls and competing migrations. Resolve this by either running ` +
      `without --no-proxy/--direct to share the daemon, stopping the daemon, or setting ` +
      `AUTOMOBILE_DB_PATH (or AUTOMOBILE_DB_DIR) to an isolated database for this direct-mode instance.`
  );
}

/**
 * Production wiring for {@link DirectModeGuardDeps}. Reuses the canonical
 * {@link DaemonManager.findLiveDaemonProcesses} primitive (no new PID scan) plus
 * {@link readPidFileDataSync} to learn the primary daemon's owned DB path.
 *
 * Live daemons whose DB path can't be resolved from the default PID file (e.g.
 * other-worktree daemons writing a different PID file) are reported with
 * `dbPath: undefined` so they never falsely match.
 */
export function createDefaultDirectModeGuardDeps(
  options: DefaultDirectModeGuardDepsOptions = {}
): DirectModeGuardDeps {
  const manager = options.manager ?? new DaemonManager();
  const readPidFileData = options.readPidFileData ?? readPidFileDataSync;
  const resolveDbPath = options.resolveDbPath ?? getDatabasePath;

  return {
    resolveDbPath,
    findLiveDaemonDbOwners: () => {
      let livePids: number[];
      try {
        livePids = manager.findLiveDaemonProcesses();
      } catch (error) {
        // An indeterminate process table is NOT evidence that a daemon is
        // running. The issue requires direct mode NOT be blocked when no daemon
        // is known to be running, so treat a `ps` failure as "no known conflict"
        // and proceed rather than hard-failing an escape-hatch launch. #2795
        logger.warn(
          `Direct-mode guard: could not inspect the daemon process table; ` +
            `proceeding without a same-DB conflict check. ` +
            `${error instanceof Error ? error.message : String(error)}`,
          error
        );
        return [];
      }

      if (livePids.length === 0) {
        return [];
      }

      const owners: DaemonDbOwner[] = [];
      const resolvedPids = new Set<number>();

      const pidData = readPidFileData();
      if (
        pidData &&
        typeof pidData.pid === "number" &&
        pidData.dbPath !== undefined &&
        livePids.includes(pidData.pid)
      ) {
        owners.push({ pid: pidData.pid, dbPath: pidData.dbPath });
        resolvedPids.add(pidData.pid);
      }

      const unresolved = livePids.filter(pid => !resolvedPids.has(pid));
      if (unresolved.length > 0) {
        // These live daemons don't match the default PID file (e.g. they run with
        // a custom AUTOMOBILE_DAEMON_PID_FILE_PATH), so we can't learn which DB
        // file they own and can't check them for a same-file collision. Trace it
        // so the under-refusal is diagnosable rather than silent — the full fix
        // ("one owner per DB file", reading every daemon's PID file) is #2794.
        logger.debug(
          `Direct-mode guard: ${unresolved.length} live daemon(s) could not be ` +
            `mapped to a DB path (non-default PID file); not checked for a ` +
            `same-file collision: ${unresolved.join(", ")}`
        );
        for (const pid of unresolved) {
          owners.push({ pid, dbPath: undefined });
        }
      }

      return owners;
    },
  };
}
