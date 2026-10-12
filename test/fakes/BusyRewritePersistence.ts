import type {
  DeviceSessionRecord,
  MarkReleasedOptions,
  UpsertActiveSessionOptions,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { FakeDeviceSessionPersistence } from "./FakeDeviceSessionPersistence";

/**
 * A store whose release write can be parked past the release deadline, and whose plain upserts
 * (the rewrite of a live row, #11206) can be made to fail, as a busy database does.
 */
export class BusyRewritePersistence extends FakeDeviceSessionPersistence {
  park: Promise<void> | undefined;
  /** Plain upserts still to fail; `Infinity` keeps the database busy. */
  failPlainUpserts = 0;
  plainUpserts = 0;
  /** Runs once, while the next plain upsert is in flight (before it lands or fails). */
  duringPlainUpsert: (() => Promise<void>) | undefined;
  /** Runs once, right after the next plain upsert has landed. */
  afterPlainUpsert: (() => Promise<void>) | undefined;
  /** Release writes still to fail, counted from the next one issued. */
  failReleaseWrites = 0;
  /** Runs once before an activity re-persist lands, to drive an incarnation change. */
  duringActivityUpsert: (() => Promise<void>) | undefined;
  failActivityUpserts = 0;

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options?: MarkReleasedOptions,
  ): Promise<void> {
    await this.park;
    if (this.failReleaseWrites > 0) {
      this.failReleaseWrites--;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    await super.markReleased(sessionUuid, status, releasedAtMs, reason, options);
  }

  override async upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs?: number,
    options: UpsertActiveSessionOptions = {},
  ): Promise<number> {
    if (!options.unlessTerminal) {
      this.plainUpserts++;
      const hook = this.duringPlainUpsert;
      this.duringPlainUpsert = undefined;
      await hook?.();
      if (this.failPlainUpserts > 0) {
        this.failPlainUpserts--;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      const generation = await super.upsertActiveSession(record, nowMs, options);
      const landed = this.afterPlainUpsert;
      this.afterPlainUpsert = undefined;
      await landed?.();
      return generation;
    }
    const hook = this.duringActivityUpsert;
    this.duringActivityUpsert = undefined;
    await hook?.();
    if (this.failActivityUpserts > 0) {
      this.failActivityUpserts--;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return await super.upsertActiveSession(record, nowMs, options);
  }
}
