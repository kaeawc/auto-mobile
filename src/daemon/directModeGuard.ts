import { resolve } from "node:path";
import { ActionableError } from "../models";
import { getDatabasePath } from "../db";
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

function normalizeDbPath(dbPath: string): string {
  return resolve(dbPath);
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
      `AUTOMOBILE_DB_PATH to an isolated database for this direct-mode instance.`
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
      const livePids = manager.findLiveDaemonProcesses();
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

      for (const pid of livePids) {
        if (!resolvedPids.has(pid)) {
          owners.push({ pid, dbPath: undefined });
        }
      }

      return owners;
    },
  };
}
