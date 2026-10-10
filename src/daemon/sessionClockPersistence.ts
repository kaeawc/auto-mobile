/**
 * Persist device-session stamps as wall-clock epoch ms, and read them back onto this daemon's
 * session clock (#11162).
 *
 * In memory every session stamp (`createdAt`, `lastUsedAt`, `expiresAt`, a release time) is on the
 * daemon's session clock (#11080): wall-anchored when the daemon starts, then advancing with the
 * monotonic clock, so it parts from the wall clock by every wall step the daemon has lived
 * through. That frame is private to one process. The rows outlive it and are read by another
 * process (the next daemon after a restart, a peer daemon, the terminal-release journal's
 * replay), whose session clock has a different offset from the wall clock. So stamps cross the
 * process boundary as wall epoch ms, the one frame every process shares: converted on the way out
 * with the writer's offset, and onto the reader's session clock on the way in.
 *
 * Rows written before this conversion hold the writer's session-clock stamps. They are read as
 * wall ms. That is exact for rows from before the session clock existed (they were wall stamps),
 * and for everything since it is off only by the wall steps the writing daemon had lived through
 * when it wrote them, which is zero unless the wall clock was stepped while it ran. No better
 * reading is available: the writer's offset died with it, nothing in the row records the frame,
 * and reading them in the reader's own frame is the bug this fixes.
 *
 * Only absolute instants are converted; durations (`session_timeout_ms`, ...) are frame-free. The
 * #11129 guards keep working: the row generation is not a time, and the stale-write guard
 * (`last_used_at_ms` only moves forward) compares stamps from the same daemon, converted with the
 * same offset unless a wall step falls between two writes. A backward step there makes the newer
 * write read as stale and leaves the row's later, pre-step lease in place until the converted
 * activity passes it, so the row errs toward keeping a session, by at most the step.
 */

import type { DeviceSession, DeviceSessionStatus } from "../db/types";
import type {
  DeviceSessionActivityUpdate,
  DeviceSessionPersistence,
  DeviceSessionRecord,
  MarkReleasedOptions,
} from "../db/deviceSessionRepository";

/** Converts instants between this daemon's session clock and the shared wall clock. */
export interface SessionClockFrame {
  /** A session-clock instant as wall epoch ms. */
  toWall(sessionClockMs: number): number;
  /** A wall epoch ms instant on the session clock. */
  toSessionClock(wallMs: number): number;
}

/** A row read back with its instants on the session clock. */
export function deviceSessionOnSessionClock(
  row: DeviceSession,
  frame: SessionClockFrame,
): DeviceSession {
  return {
    ...row,
    created_at_ms: frame.toSessionClock(row.created_at_ms),
    last_used_at_ms: frame.toSessionClock(row.last_used_at_ms),
    expires_at_ms: frame.toSessionClock(row.expires_at_ms),
    // An unreleased row may carry null or, from a partial row, no value at all: keep either as is.
    released_at_ms:
      typeof row.released_at_ms === "number"
        ? frame.toSessionClock(row.released_at_ms)
        : row.released_at_ms,
  };
}

function recordOnWallClock(
  record: DeviceSessionRecord,
  frame: SessionClockFrame,
): DeviceSessionRecord {
  return {
    ...record,
    createdAtMs: frame.toWall(record.createdAtMs),
    lastUsedAtMs: frame.toWall(record.lastUsedAtMs),
    expiresAtMs: frame.toWall(record.expiresAtMs),
  };
}

function activityOnWallClock(
  update: DeviceSessionActivityUpdate,
  frame: SessionClockFrame,
): DeviceSessionActivityUpdate {
  return {
    ...update,
    lastUsedAtMs: frame.toWall(update.lastUsedAtMs),
    expiresAtMs: frame.toWall(update.expiresAtMs),
  };
}

const toWallIfGiven = (frame: SessionClockFrame, ms: number | undefined) =>
  ms === undefined ? undefined : frame.toWall(ms);

/**
 * `inner` as the session manager sees it: every instant it is handed is on the session clock and
 * is stored as wall ms, and every row it returns has its instants on the session clock. An
 * optional method is present exactly while `inner` has it, looked up per access (an
 * implementation may install one late, and a spy may replace it). The wrappers add no awaits of
 * their own beyond one conversion step on reads.
 */
class SessionClockPersistence implements DeviceSessionPersistence {
  constructor(
    private readonly inner: DeviceSessionPersistence,
    private readonly frame: SessionClockFrame,
  ) {}

  upsertActiveSession(record: DeviceSessionRecord, nowMs?: number): Promise<number | void> {
    return this.inner.upsertActiveSession(
      recordOnWallClock(record, this.frame),
      toWallIfGiven(this.frame, nowMs),
    );
  }

  get getSession(): DeviceSessionPersistence["getSession"] {
    if (!this.inner.getSession) {
      return undefined;
    }
    const getSession = this.inner.getSession.bind(this.inner);
    return (sessionUuid) =>
      getSession(sessionUuid).then((row) => row && deviceSessionOnSessionClock(row, this.frame));
  }

  get listRecoverableSessions(): DeviceSessionPersistence["listRecoverableSessions"] {
    if (!this.inner.listRecoverableSessions) {
      return undefined;
    }
    const listRecoverableSessions = this.inner.listRecoverableSessions.bind(this.inner);
    return (nowMs) =>
      listRecoverableSessions(toWallIfGiven(this.frame, nowMs)).then((rows) =>
        rows.map((row) => deviceSessionOnSessionClock(row, this.frame)),
      );
  }

  recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    return this.inner.recordActivity(sessionUuid, activityOnWallClock(update, this.frame));
  }

  get recordRestartRecoveryActivity(): DeviceSessionPersistence["recordRestartRecoveryActivity"] {
    if (!this.inner.recordRestartRecoveryActivity) {
      return undefined;
    }
    const record = this.inner.recordRestartRecoveryActivity.bind(this.inner);
    return (sessionUuid, activityAtMs) => record(sessionUuid, this.frame.toWall(activityAtMs));
  }

  get recordLivenessOwnership(): DeviceSessionPersistence["recordLivenessOwnership"] {
    if (!this.inner.recordLivenessOwnership) {
      return undefined;
    }
    return this.inner.recordLivenessOwnership.bind(this.inner);
  }

  get claimRecoverableSession(): DeviceSessionPersistence["claimRecoverableSession"] {
    if (!this.inner.claimRecoverableSession) {
      return undefined;
    }
    // Generations and daemon ids are frame-free.
    return this.inner.claimRecoverableSession.bind(this.inner);
  }

  get releaseRecoverableSessionClaim(): DeviceSessionPersistence["releaseRecoverableSessionClaim"] {
    if (!this.inner.releaseRecoverableSessionClaim) {
      return undefined;
    }
    // Generations and daemon ids are frame-free.
    return this.inner.releaseRecoverableSessionClaim.bind(this.inner);
  }

  get replaceLivenessOwnership(): DeviceSessionPersistence["replaceLivenessOwnership"] {
    if (!this.inner.replaceLivenessOwnership) {
      return undefined;
    }
    return this.inner.replaceLivenessOwnership.bind(this.inner);
  }

  markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options?: MarkReleasedOptions,
  ): Promise<void> {
    return this.inner.markReleased(
      sessionUuid,
      status,
      this.frame.toWall(releasedAtMs),
      reason,
      options,
    );
  }
}

/** See {@link SessionClockPersistence}. */
export function onSessionClock(
  inner: DeviceSessionPersistence,
  frame: SessionClockFrame,
): DeviceSessionPersistence {
  return new SessionClockPersistence(inner, frame);
}
