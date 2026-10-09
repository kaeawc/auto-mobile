import {
  DeviceSessionRepository,
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";

/** In-memory session persistence for daemon tests. */
export class FakeDeviceSessionRepository
  extends DeviceSessionRepository
  implements DeviceSessionRepository
{
  readonly released: string[] = [];
  readonly events: string[] = [];
  readonly sessions = new Map<
    string,
    { status: DeviceSessionStatus; releasedAtMs: number | null; reason: string | null }
  >();

  override async getSession(): Promise<undefined> {
    return undefined;
  }

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<number> {
    this.sessions.set(record.sessionUuid, { status: "active", releasedAtMs: null, reason: null });
    return 0;
  }

  override async replaceLivenessOwnership(): Promise<void> {}

  override async markAutolockSession(): Promise<void> {}

  override async recordActivity(
    _sessionUuid: string,
    _update: DeviceSessionActivityUpdate,
  ): Promise<void> {}

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    this.released.push(sessionUuid);
    this.events.push("markReleased");
    this.sessions.set(sessionUuid, { status, releasedAtMs, reason });
  }

  override async markStaleActiveSessionsExpired(): Promise<void> {}
}
