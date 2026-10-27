import { type StampField, type WrittenStamp } from "./sessionClockPersistence";

/** Most sessions whose own writes are remembered; the oldest entry goes first. */
const WRITTEN_STAMP_SESSION_LIMIT = 512;

/**
 * The stamps this daemon wrote, per session UUID (#11358). Converting a stamp back with the
 * clock's offset at READ time shifts it by any wall step between this daemon's write and read, so
 * a stamp still equal to what this daemon stored is returned as the session-clock instant it was
 * written from. A stamp that differs (a peer or a later write by another process replaced it) was
 * not written here and takes the ordinary conversion.
 */
export class WrittenStamps {
  private readonly bySession = new Map<string, Partial<Record<StampField, WrittenStamp>>>();

  remember(sessionUuid: string, field: StampField, stamp: WrittenStamp): void {
    const entry = this.bySession.get(sessionUuid) ?? {};
    // Activity rows keep their newer last-used stamp when a stale write finally retries.
    if (
      field === "lastUsed" &&
      entry.lastUsed &&
      stamp.sessionClockMs < entry.lastUsed.sessionClockMs
    ) {
      return;
    }
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

  wallStamp(sessionUuid: string, field: StampField, sessionClockMs: number): number | undefined {
    const stamp = this.bySession.get(sessionUuid)?.[field];
    return stamp?.sessionClockMs === sessionClockMs ? stamp.wallMs : undefined;
  }
}
