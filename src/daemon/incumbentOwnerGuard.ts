import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PID_FILE_PATH } from "./constants";
import { isProcessRunning, readPidFileDataSync } from "./daemonFiles";
import type { SocketOwnerLiveness } from "./socketServer";
import type { PidFileData } from "./types";
import { logger } from "../utils/logger";

/**
 * Injected seams for {@link IncumbentOwnerGuard} (issue #6232). Kept behind an
 * interface so a unit test can drive the incumbent-record lifecycle
 * deterministically without touching the real `~/.auto-mobile` PID path — the
 * default implementations wrap the real file/process primitives.
 */
export interface IncumbentOwnerGuardDeps {
  /** Read the on-disk daemon PID record (or null if missing/malformed). */
  readPidFile: () => PidFileData | null;
  /** Persist a PID record back to disk synchronously (restore-on-refusal path). */
  persistPidFile: (data: PidFileData) => void;
  /** Liveness check for a recorded PID. */
  isProcessRunning: (pid: number) => boolean;
  /** This process's PID; a record naming it is our own, never a foreign owner. */
  selfPid: number;
}

/**
 * Guards the incumbent daemon's PID record across a hand-launched contender's
 * early-owner overwrite (issue #6232, the #6140 socket-brick family).
 *
 * `Daemon.start()` writes its OWN early-owner PID record (issue #2871) BEFORE it
 * reaches the socket-bind guard. That overwrite destroys the evidence the guard
 * needs: once the shared PID file names the contender, a plain re-read of it
 * (a) cannot tell the bind guard that a LIVE sibling still owns the socket — so a
 * transiently-failed reachability probe would unlink the live socket (P1) — and
 * (b) leaves `status()` / `--daemon stop` pointing at the now-dead contender
 * after a refused bind (P2).
 *
 * This guard closes both holes with a single mechanism: it SNAPSHOTS a live
 * foreign incumbent's record immediately before the overwrite, then
 *  - answers the bind guard's owner-liveness question from that snapshot
 *    ({@link asSocketOwnerLiveness}) instead of the clobbered file, and
 *  - restores the snapshot to disk if the bind is refused
 *    ({@link restoreIncumbentAfterRefusal}), re-checking liveness so it never
 *    resurrects a record for a process that has since died.
 *
 * It only ever preserves/consults a record that named a LIVE process OTHER than
 * this one at capture time, so a genuinely stale (post-crash) socket stays
 * reclaimable and this guard never fabricates a live owner.
 *
 * Overlapping hand-launched contenders (issue #6232, the overlapping
 * interleaving): the on-disk record may itself be ANOTHER contender's early
 * record (it clobbered the true incumbent before we read it). Such a record is
 * not proof of who owns the socket, so this guard distinguishes it from a
 * committed owner via {@link isCommittedOwnerRecord}: a committed owner is
 * snapshotted and restorable; a live non-owner contender only latches a
 * fail-closed flag so the lock-less bind refuses instead of restoring a
 * non-owner's PID or unlinking the real winner after that contender exits.
 */
export class IncumbentOwnerGuard {
  private incumbent: PidFileData | null = null;
  /**
   * Latched when the on-disk record at capture time named a LIVE foreign process
   * that had NOT committed the socket bind — i.e. another hand-launched contender
   * racing us, whose early-owner record (issue #2871) had already overwritten the
   * true incumbent's. Such a record is NOT proof of who owns the socket, so we
   * neither adopt it as the restorable incumbent nor let its later death read
   * back as "socket is stale". Instead we fail CLOSED for the rest of this start
   * so the lock-less bind refuses rather than unlinking a still-live winner
   * (issue #6232, the overlapping-contender interleaving). The latch stays set
   * even if that contender dies, because its death proves nothing about the true
   * owner and a refused lock-less bind is always recoverable via `--daemon restart`.
   */
  private sawLiveContender = false;
  private readonly deps: IncumbentOwnerGuardDeps;

  constructor(deps?: Partial<IncumbentOwnerGuardDeps>) {
    this.deps = {
      readPidFile: deps?.readPidFile ?? (() => readPidFileDataSync()),
      persistPidFile: deps?.persistPidFile ?? defaultPersistPidFile,
      isProcessRunning: deps?.isProcessRunning ?? isProcessRunning,
      selfPid: deps?.selfPid ?? process.pid,
    };
  }

  /**
   * Snapshot a live foreign incumbent's PID record. MUST be called BEFORE the
   * caller overwrites the shared PID file with its own early-owner record;
   * afterwards the on-disk record names the caller and the incumbent is lost.
   * A record that is absent, ours, or names a dead process is captured as "no
   * incumbent" so a stale socket stays reclaimable.
   */
  captureIncumbentBeforeOverwrite(): void {
    this.incumbent = null;
    this.sawLiveContender = false;
    const record = this.deps.readPidFile();
    if (!this.isLiveForeign(record)) {
      // Absent, ours, or dead: a genuinely stale (post-crash) socket stays
      // reclaimable and there is no live sibling to preserve.
      return;
    }
    if (isCommittedOwnerRecord(record)) {
      // Only a record written AFTER a committed socket bind carries build
      // identity (issue #2871's pre-bind early record never does), so its
      // presence proves the named process actually owned the socket. This is the
      // one record we trust enough to snapshot for liveness AND to restore.
      this.incumbent = record;
      logger.info(
        `Captured live incumbent daemon owner record (pid ${record.pid}) before overwriting it (issue #6232)`,
      );
      return;
    }
    // A LIVE foreign process left only an EARLY owner record: another
    // hand-launched contender is racing us and has already clobbered the true
    // incumbent's record with its own. Do NOT adopt its PID (restoring it would
    // write a non-owner over the real record) and do NOT let its later death
    // authorize unlinking the live winner — fail closed for this start instead
    // (issue #6232, overlapping-contender interleaving).
    this.sawLiveContender = true;
    logger.info(
      `Detected a live hand-launched contender (pid ${record.pid}) mid-startup; ` +
        "failing the lock-less socket bind closed rather than treating its record as the socket owner (issue #6232)",
    );
  }

  /**
   * A {@link SocketOwnerLiveness} backed by the captured snapshot, NOT the
   * (possibly self-overwritten) on-disk file. This is what lets the bind guard
   * fail closed on an inconclusive reachability probe even though our own
   * early-owner record now sits in the PID file.
   */
  asSocketOwnerLiveness(): SocketOwnerLiveness {
    return { hasLiveForeignOwner: () => this.hasLiveForeignOwner() };
  }

  /**
   * Whether a live foreign owner was captured AND is still running. Re-checks
   * liveness on every call so a sibling that dies between capture and the probe
   * is not reported as live.
   */
  hasLiveForeignOwner(): boolean {
    return this.sawLiveContender || this.isLiveForeign(this.incumbent);
  }

  /**
   * Restore the captured incumbent's record after a refused bind so
   * `status()` / `--daemon stop` keep naming the live winner instead of the
   * dead contender that overwrote it. Re-checks liveness first (identity +
   * running), so a record for a since-dead process is never written back.
   * Returns whether a record was restored.
   */
  restoreIncumbentAfterRefusal(): boolean {
    const incumbent = this.incumbent;
    if (!this.isLiveForeign(incumbent)) {
      return false;
    }
    this.deps.persistPidFile(incumbent);
    logger.info(
      `Restored live incumbent daemon owner record (pid ${incumbent.pid}) after refusing the bind (issue #6232)`,
    );
    return true;
  }

  private isLiveForeign(record: PidFileData | null): record is PidFileData {
    return (
      record !== null && record.pid !== this.deps.selfPid && this.deps.isProcessRunning(record.pid)
    );
  }
}

/**
 * Whether a PID record was written AFTER a committed socket bind. Only
 * `Daemon.writePidFile()` (post-bind) stamps build identity onto the record; the
 * pre-bind early-owner record (issue #2871) never carries `entryScript`/`buildId`.
 * Presence of BOTH build-identity fields therefore proves the named process
 * actually bound the socket, which is what separates the true incumbent from
 * another hand-launched contender's early record. Requiring both (rather than
 * either) fails safe: a real incumbent misread as a contender only makes a
 * lock-less bind refuse (recoverable), whereas a contender misread as an owner
 * would resurrect the #6232 brick.
 */
function isCommittedOwnerRecord(record: PidFileData): boolean {
  return record.entryScript !== undefined && record.buildId !== undefined;
}

function defaultPersistPidFile(data: PidFileData): void {
  mkdirSync(dirname(PID_FILE_PATH), { recursive: true });
  writeFileSync(PID_FILE_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}
