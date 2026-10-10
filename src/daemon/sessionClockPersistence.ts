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
 * A stamp this daemon wrote itself and finds unchanged on read is returned as the session-clock
 * instant it was written from, not re-converted with the offset at read time, so a wall step
 * between its own write and read moves nothing (#11358). Only stamps another process wrote, or a
 * previous run of this one, go through the conversion.
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
  UpsertActiveSessionOptions,
} from "../db/deviceSessionRepository";

/** Converts instants between this daemon's session clock and the shared wall clock. */
export interface SessionClockFrame {
  /** A session-clock instant as wall epoch ms. */
  toWall(sessionClockMs: number): number;
  /** A wall epoch ms instant on the session clock. */
  toSessionClock(wallMs: number): number;
}

type StampField = "created" | "lastUsed" | "expires" | "released";

/** The wall ms this daemon stored for a stamp and the session-clock instant it came from. */
type WrittenStamp = { wallMs: number; sessionClockMs: number };

/** Most sessions whose own writes are remembered; the oldest entry goes first. */
const WRITTEN_STAMP_SESSION_LIMIT = 512;

/**
 * The stamps this daemon wrote, per session UUID (#11358). Converting a stamp back with the
 * clock's offset at READ time shifts it by any wall step between this daemon's write and read, so
 * a stamp still equal to what this daemon stored is returned as the session-clock instant it was
 * written from. A stamp that differs (a peer or a later write by another process replaced it) was
 * not written here and takes the ordinary conversion.
 */
class WrittenStamps {
  private readonly bySession = new Map<string, Partial<Record<StampField, WrittenStamp>>>();

  remember(sessionUuid: string, field: StampField, stamp: WrittenStamp): void {
    const entry = this.bySession.get(sessionUuid) ?? {};
    // Re-insert so the most recently written session is the last to be evicted.
    this.bySession.delete(sessionUuid);
    this.bySession.set(sessionUuid, { ...entry, [field]: stamp });
    if (this.bySession.size > WRITTEN_STAMP_SESSION_LIMIT) {
      const oldest = this.bySession.keys().next();
      if (!oldest.done) {
        this.bySession.delete(oldest.value);
      }
    }
  }

  recall(sessionUuid: string, field: StampField, wallMs: number): number | undefined {
    const stamp = this.bySession.get(sessionUuid)?.[field];
    return stamp?.wallMs === wallMs ? stamp.sessionClockMs : undefined;
  }
}

/** A row read back with its instants on the session clock. */
export function deviceSessionOnSessionClock(
  row: DeviceSession,
  frame: SessionClockFrame,
  written?: WrittenStamps,
): DeviceSession {
  const back = (field: StampField, wallMs: number) =>
    written?.recall(row.session_uuid, field, wallMs) ?? frame.toSessionClock(wallMs);
  return {
    ...row,
    created_at_ms: back("created", row.created_at_ms),
    last_used_at_ms: back("lastUsed", row.last_used_at_ms),
    expires_at_ms: back("expires", row.expires_at_ms),
    // An unreleased row may carry null or, from a partial row, no value at all: keep either as is.
    released_at_ms:
      typeof row.released_at_ms === "number"
        ? back("released", row.released_at_ms)
        : row.released_at_ms,
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
  private readonly written = new WrittenStamps();

  constructor(
    private readonly inner: DeviceSessionPersistence,
    private readonly frame: SessionClockFrame,
  ) {}

  /** `sessionClockMs` as wall ms, remembered so this daemon reads its own stamp back exactly. */
  private store(sessionUuid: string, field: StampField, sessionClockMs: number): number {
    const wallMs = this.frame.toWall(sessionClockMs);
    this.written.remember(sessionUuid, field, { wallMs, sessionClockMs });
    return wallMs;
  }

  upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs?: number,
    options?: UpsertActiveSessionOptions,
  ): Promise<number | void> {
    // The claimed incarnation is a generation and a daemon id: frame-free.
    return this.inner.upsertActiveSession(
      {
        ...record,
        createdAtMs: this.store(record.sessionUuid, "created", record.createdAtMs),
        lastUsedAtMs: this.store(record.sessionUuid, "lastUsed", record.lastUsedAtMs),
        expiresAtMs: this.store(record.sessionUuid, "expires", record.expiresAtMs),
      },
      toWallIfGiven(this.frame, nowMs),
      options,
    );
  }

  get getSession(): DeviceSessionPersistence["getSession"] {
    if (!this.inner.getSession) {
      return undefined;
    }
    const getSession = this.inner.getSession.bind(this.inner);
    return (sessionUuid) =>
      getSession(sessionUuid).then(
        (row) => row && deviceSessionOnSessionClock(row, this.frame, this.written),
      );
  }

  get listRecoverableSessions(): DeviceSessionPersistence["listRecoverableSessions"] {
    if (!this.inner.listRecoverableSessions) {
      return undefined;
    }
    const listRecoverableSessions = this.inner.listRecoverableSessions.bind(this.inner);
    return (nowMs) =>
      listRecoverableSessions(toWallIfGiven(this.frame, nowMs)).then((rows) =>
        rows.map((row) => deviceSessionOnSessionClock(row, this.frame, this.written)),
      );
  }

  recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    return this.inner.recordActivity(sessionUuid, {
      ...update,
      lastUsedAtMs: this.store(sessionUuid, "lastUsed", update.lastUsedAtMs),
      expiresAtMs: this.store(sessionUuid, "expires", update.expiresAtMs),
    });
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
      this.store(sessionUuid, "released", releasedAtMs),
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
