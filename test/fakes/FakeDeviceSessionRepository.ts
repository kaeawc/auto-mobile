import {
  DeviceSessionRepository,
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  isDeviceRestartReleaseReason,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";

/** In-memory session persistence for daemon tests. */
export class FakeDeviceSessionRepository
  extends DeviceSessionRepository
  implements DeviceSessionRepository
{
  private readonly expiresAtMs = new Map<string, number>();
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
    this.expiresAtMs.set(record.sessionUuid, record.expiresAtMs);
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
    options: MarkReleasedOptions = {},
  ): Promise<void> {
    const handoff = options.onlyIfRestartRecoveryHandoff;
    const row = this.sessions.get(sessionUuid);
    if (
      handoff &&
      (!row?.reason ||
        !isDeviceRestartReleaseReason(row.reason) ||
        row.releasedAtMs === null ||
        row.releasedAtMs > handoff.releasedAtOrBeforeMs ||
        (this.expiresAtMs.get(sessionUuid) ?? 0) <= row.releasedAtMs + handoff.recoveryWindowMs)
    ) {
      return;
    }
    this.released.push(sessionUuid);
    this.events.push("markReleased");
    this.sessions.set(sessionUuid, { status, releasedAtMs, reason });
  }

  override async markStaleActiveSessionsExpired(): Promise<void> {}
}
