import { WrittenStamps } from "./WrittenStamps";
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
 * compares the raw session-clock activity sequence (#11497), which never steps backward within
 * this daemon/session. Wall stamps remain display/recovery instants; a wall step cannot reject
 * newer activity or let a delayed older write replace its lease.
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

export type StampField = "created" | "lastUsed" | "expires" | "released";

/** The wall ms this daemon stored for a stamp and the session-clock instant it came from. */
export type WrittenStamp = { wallMs: number; sessionClockMs: number };

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
 * is stored as wall ms, and every row it returns has its instants on the session clock. All
 * required methods delegate to `inner`, looked up per call so spies may replace them. The
 * wrappers add no awaits of their own beyond one conversion step on reads.
 */
class SessionClockPersistence implements DeviceSessionPersistence {
  private readonly written = new WrittenStamps();

  constructor(
    private readonly inner: DeviceSessionPersistence,
    private readonly frame: SessionClockFrame,
  ) {}

  /** Reuse unchanged instants' stamps so conversion jitter cannot make a policy write stale. */
  private store(sessionUuid: string, field: StampField, sessionClockMs: number): number {
    const wallMs =
      this.written.wallStamp(sessionUuid, field, sessionClockMs) ??
      this.frame.toWall(sessionClockMs);
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
        activitySeq: record.activitySeq ?? record.lastUsedAtMs,
        createdAtMs: this.store(record.sessionUuid, "created", record.createdAtMs),
        lastUsedAtMs: this.store(record.sessionUuid, "lastUsed", record.lastUsedAtMs),
        expiresAtMs: this.store(record.sessionUuid, "expires", record.expiresAtMs),
      },
      toWallIfGiven(this.frame, nowMs),
      options,
    );
  }

  getSession(sessionUuid: string): Promise<DeviceSession | undefined> {
    return this.inner
      .getSession(sessionUuid)
      .then((row) => row && deviceSessionOnSessionClock(row, this.frame, this.written));
  }

  listRecoverableSessions(
    nowMs?: number,
    livePeerDaemonSessionIds?: () => readonly string[],
  ): Promise<DeviceSession[]> {
    return this.inner
      .listRecoverableSessions(toWallIfGiven(this.frame, nowMs), livePeerDaemonSessionIds)
      .then((rows) =>
        rows.map((row) => deviceSessionOnSessionClock(row, this.frame, this.written)),
      );
  }

  recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    return this.inner.recordActivity(sessionUuid, {
      ...update,
      activitySeq: update.activitySeq ?? update.lastUsedAtMs,
      lastUsedAtMs: this.store(sessionUuid, "lastUsed", update.lastUsedAtMs),
      expiresAtMs: this.store(sessionUuid, "expires", update.expiresAtMs),
    });
  }

  recordRestartRecoveryActivity(sessionUuid: string, activityAtMs: number): Promise<void> {
    return this.inner.recordRestartRecoveryActivity(sessionUuid, this.frame.toWall(activityAtMs));
  }

  recordLivenessOwnership(
    ...args: Parameters<DeviceSessionPersistence["recordLivenessOwnership"]>
  ): ReturnType<DeviceSessionPersistence["recordLivenessOwnership"]> {
    return this.inner.recordLivenessOwnership(...args);
  }

  claimRecoverableSession(
    ...args: Parameters<DeviceSessionPersistence["claimRecoverableSession"]>
  ): ReturnType<DeviceSessionPersistence["claimRecoverableSession"]> {
    return this.inner.claimRecoverableSession(...args);
  }

  releaseRecoverableSessionClaim(
    ...args: Parameters<DeviceSessionPersistence["releaseRecoverableSessionClaim"]>
  ): ReturnType<DeviceSessionPersistence["releaseRecoverableSessionClaim"]> {
    return this.inner.releaseRecoverableSessionClaim(...args);
  }

  replaceLivenessOwnership(
    ...args: Parameters<DeviceSessionPersistence["replaceLivenessOwnership"]>
  ): ReturnType<DeviceSessionPersistence["replaceLivenessOwnership"]> {
    return this.inner.replaceLivenessOwnership(...args);
  }

  markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    { reason, ...options }: MarkReleasedOptions & { reason: string },
  ): Promise<void> {
    return this.inner.markReleased(
      sessionUuid,
      status,
      this.store(sessionUuid, "released", releasedAtMs),
      { reason, ...options },
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
