import { errorMessage } from "../utils/describeUnknownError";
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
 * owns — e.g. one using a non-default PID file. Such a daemon could be about to
 * write this very file, so the guard fails CLOSED on it (refuses) rather than
 * silently assuming no collision. A daemon with a KNOWN, different `dbPath`
 * still never matches, so the `AUTOMOBILE_DB_PATH` escape hatch is preserved.
 *
 * As of #2871 a daemon that is still starting up is NO LONGER a source of an
 * unknown path: `Daemon.start()` publishes its resolved `dbPath` in the PID file
 * (`writeEarlyOwnerRecord`) BEFORE it opens the DB, so any daemon that has opened
 * the DB always exposes a resolvable `dbPath`. That turns the transient
 * mid-startup over-refusal (an isolated-path launch refused during the daemon's
 * multi-second bring-up) into a precise same-file check.
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

/** Owners whose known DB file equals `ourDbPath` (file-scoped, unknown excluded). */
function filterSameFile(owners: DaemonDbOwner[], ourDbPath: string): DaemonDbOwner[] {
  return owners.filter(
    (owner) => owner.dbPath !== undefined && normalizeDbPath(owner.dbPath) === ourDbPath,
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
    const pids = conflicting.map((owner) => owner.pid).join(", ");
    throw new ActionableError(
      `A live AutoMobile daemon (pid ${pids}) already owns the database at ${ourDbPath}. ` +
        `Direct mode (--no-proxy/--direct) would open a second writer on the same SQLite file, ` +
        `causing SQLITE_BUSY stalls and competing migrations. Resolve this by either running ` +
        `without --no-proxy/--direct to share the daemon, stopping the daemon, or setting ` +
        `AUTOMOBILE_DB_PATH (or AUTOMOBILE_DB_DIR) to an isolated database for this direct-mode instance.`,
    );
  }

  // Fail closed on uncertainty. A live daemon whose owned DB path can't be
  // determined (e.g. using a non-default PID file) could be about to write this
  // same file, so refuse rather than risk a second writer. Note: as of #2871 a
  // mid-startup daemon publishes its `dbPath` BEFORE opening the DB
  // (writeEarlyOwnerRecord), so it is no longer surfaced as unknown-path here.
  // The residual TOCTOU (a daemon that opens the DB immediately after this
  // check) is covered by the migration cross-process lock (#2794).
  const unverifiable = owners.filter((owner) => owner.dbPath === undefined);
  if (unverifiable.length > 0) {
    const pids = unverifiable.map((owner) => owner.pid).join(", ");
    throw new ActionableError(
      `Cannot safely start direct mode (--no-proxy/--direct): a live AutoMobile daemon ` +
        `(pid ${pids}) is running but its database path could not be determined ` +
        `(it may still be starting up, or is using a non-default PID file), so a collision on ` +
        `${ourDbPath} cannot be ruled out. Wait for the daemon to finish starting and retry, ` +
        `stop the daemon, or set AUTOMOBILE_DB_PATH (or AUTOMOBILE_DB_DIR) to an isolated ` +
        `database for this direct-mode instance.`,
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
  options: DefaultDirectModeGuardDepsOptions = {},
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
        const detail = errorMessage(error);
        logger.warn(
          `Direct-mode guard: process-table scan failed; refusing direct mode ` +
            `because same-DB daemon ownership cannot be verified. ${detail}`,
          error,
        );
        // An indeterminate scan means we cannot rule out a live daemon on this DB
        // file. Fail CLOSED — refuse rather than risk a second writer. #2795
        throw new ActionableError(
          `Cannot verify daemon ownership before starting direct mode ` +
            `(--no-proxy/--direct): failed to inspect the process table (${detail}). ` +
            `Retry, stop any running daemon, or set AUTOMOBILE_DB_PATH (or ` +
            `AUTOMOBILE_DB_DIR) to an isolated database.`,
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

      const unresolved = livePids.filter((pid) => !resolvedPids.has(pid));
      if (unresolved.length > 0) {
        // These live daemons don't match the default PID file — e.g. one using a
        // custom AUTOMOBILE_DAEMON_PID_FILE_PATH. (A daemon still starting up now
        // publishes its `dbPath` early via writeEarlyOwnerRecord (#2871), so it
        // resolves above rather than landing here.) We can't learn which DB file
        // these own, so they're surfaced with an unknown path; the guard fails
        // CLOSED on them (assertDirectModeDbOwnership).
        // Trace it so the refusal is diagnosable. Reading every daemon's PID file
        // for a definitive per-file answer is #2794's owner-lock.
        logger.debug(
          `Direct-mode guard: ${unresolved.length} live daemon(s) could not be ` +
            `mapped to a DB path (starting up or non-default PID file); direct mode ` +
            `will refuse to be safe: ${unresolved.join(", ")}`,
        );
        for (const pid of unresolved) {
          owners.push({ pid, dbPath: undefined });
        }
      }

      return owners;
    },
  };
}
