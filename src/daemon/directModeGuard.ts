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
 * owns — most importantly a daemon that is still starting up (`Daemon.start()`
 * opens and migrates the DB seconds before it records its `dbPath` in the PID
 * file), or one using a non-default PID file. Such a daemon could be about to
 * write this very file, so the guard fails CLOSED on it (refuses) rather than
 * silently assuming no collision. A daemon with a KNOWN, different `dbPath`
 * still never matches, so the `AUTOMOBILE_DB_PATH` escape hatch is preserved.
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
  /** Host platform; injected so tests can exercise the Windows `ps`-absent path. */
  platform?: NodeJS.Platform;
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

/** Owners whose known DB file equals `ourDbPath` (file-scoped, unknown excluded). */
function filterSameFile(owners: DaemonDbOwner[], ourDbPath: string): DaemonDbOwner[] {
  return owners.filter(
    owner => owner.dbPath !== undefined && normalizeDbPath(owner.dbPath) === ourDbPath
  );
}

/**
 * Find the live daemons that own the SAME resolved DB file this process would
 * open. File-scoped by construction: a daemon on a different DB path never
 * matches, so the `AUTOMOBILE_DB_PATH` escape hatch is preserved (no
 * false-positive refusal), and an owner whose path is unknown never matches.
 */
export function findConflictingDaemons(deps: DirectModeGuardDeps): DaemonDbOwner[] {
  return filterSameFile(deps.findLiveDaemonDbOwners(), normalizeDbPath(deps.resolveDbPath()));
}

/**
 * Refuse direct mode (`--no-proxy` / `--direct`) when a live daemon already owns
 * the SAME SQLite file this process would open — OR when a live daemon's owned
 * file cannot be determined (fail closed on uncertainty).
 *
 * The concurrency model is a single bun:sqlite connection guarded by an
 * in-process async mutex; it gives NO cross-process guarantee. Two processes on
 * one DB file degrade to `SQLITE_BUSY` stalls and competing per-process
 * migrations. Proxy mode gets singleton enforcement from {@link DaemonManager};
 * direct mode never did — this closes that gap (issue #2795).
 *
 * A daemon with a KNOWN, different `dbPath` never triggers a refusal, so the
 * `AUTOMOBILE_DB_PATH` escape hatch stays usable. Direct-mode-vs-direct-mode
 * peers on one file with no daemon are the case the `<db>.owner.lock` in #2794
 * covers.
 */
export function assertDirectModeDbOwnership(deps: DirectModeGuardDeps): void {
  const ourDbPath = normalizeDbPath(deps.resolveDbPath());
  const owners = deps.findLiveDaemonDbOwners();

  const conflicting = filterSameFile(owners, ourDbPath);
  if (conflicting.length > 0) {
    const pids = conflicting.map(owner => owner.pid).join(", ");
    throw new ActionableError(
      `A live AutoMobile daemon (pid ${pids}) already owns the database at ${ourDbPath}. ` +
        `Direct mode (--no-proxy/--direct) would open a second writer on the same SQLite file, ` +
        `causing SQLITE_BUSY stalls and competing migrations. Resolve this by either running ` +
        `without --no-proxy/--direct to share the daemon, stopping the daemon, or setting ` +
        `AUTOMOBILE_DB_PATH (or AUTOMOBILE_DB_DIR) to an isolated database for this direct-mode instance.`
    );
  }

  // Fail closed on uncertainty. A live daemon whose owned DB path can't be
  // determined may be mid-startup — it opens and migrates the DB seconds before
  // it records `dbPath` (daemon.ts opens at start(), writes the PID file only
  // after device discovery) — so it could be about to write this same file.
  // Refuse rather than risk a second writer. The residual TOCTOU (a daemon that
  // opens the DB immediately after this check) is #2794's owner-lock.
  const unverifiable = owners.filter(owner => owner.dbPath === undefined);
  if (unverifiable.length > 0) {
    const pids = unverifiable.map(owner => owner.pid).join(", ");
    throw new ActionableError(
      `Cannot safely start direct mode (--no-proxy/--direct): a live AutoMobile daemon ` +
        `(pid ${pids}) is running but its database path could not be determined ` +
        `(it may still be starting up, or is using a non-default PID file), so a collision on ` +
        `${ourDbPath} cannot be ruled out. Wait for the daemon to finish starting and retry, ` +
        `stop the daemon, or set AUTOMOBILE_DB_PATH (or AUTOMOBILE_DB_DIR) to an isolated ` +
        `database for this direct-mode instance.`
    );
  }
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
  const platform = options.platform ?? process.platform;

  return {
    resolveDbPath,
    findLiveDaemonDbOwners: () => {
      let livePids: number[];
      try {
        livePids = manager.findLiveDaemonProcesses();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (platform === "win32") {
          // `ps` is unavailable on Windows, where the daemon manager's own scan
          // also fails — so direct mode is effectively the only path and a scan
          // failure is expected, not an anomaly. There is no ps-discoverable
          // daemon to collide with; fail OPEN so direct mode still starts. #2795
          logger.warn(
            `Direct-mode guard: process-table scan unavailable on this platform; ` +
              `proceeding without a same-DB conflict check. ${detail}`,
            error
          );
          return [];
        }
        // On a platform where `ps` should work, an indeterminate scan means we
        // cannot rule out a live daemon on this DB file. Fail CLOSED — refuse
        // rather than risk a second writer. #2795
        throw new ActionableError(
          `Cannot verify daemon ownership before starting direct mode ` +
            `(--no-proxy/--direct): failed to inspect the process table (${detail}). ` +
            `Retry, stop any running daemon, or set AUTOMOBILE_DB_PATH (or ` +
            `AUTOMOBILE_DB_DIR) to an isolated database.`
        );
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
        // These live daemons don't match the default PID file — most importantly
        // one still starting up (its `dbPath` isn't recorded until after device
        // discovery), or one using a custom AUTOMOBILE_DAEMON_PID_FILE_PATH. We
        // can't learn which DB file they own, so they're surfaced with an unknown
        // path; the guard fails CLOSED on them (assertDirectModeDbOwnership).
        // Trace it so the refusal is diagnosable. Reading every daemon's PID file
        // for a definitive per-file answer is #2794's owner-lock.
        logger.debug(
          `Direct-mode guard: ${unresolved.length} live daemon(s) could not be ` +
            `mapped to a DB path (starting up or non-default PID file); direct mode ` +
            `will refuse to be safe: ${unresolved.join(", ")}`
        );
        for (const pid of unresolved) {
          owners.push({ pid, dbPath: undefined });
        }
      }

      return owners;
    },
  };
}
