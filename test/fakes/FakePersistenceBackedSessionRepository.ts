import {
  DeviceSessionRepository,
  type DeviceSessionActivityUpdate,
  type DeviceSessionRecord,
  type MarkReleasedOptions,
  type RecoverableRowIncarnation,
  type UpsertActiveSessionOptions,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSession, DeviceSessionStatus } from "../../src/db/types";
import { FakeDeviceSessionPersistence } from "./FakeDeviceSessionPersistence";

/**
 * A {@link DeviceSessionRepository} (what `Daemon` takes) whose persistence contract is served by
 * a {@link FakeDeviceSessionPersistence}, including recoverable-row listing and claims, so a
 * daemon can rehydrate seeded rows with no database. The other repository methods stay inert.
 */
export class FakePersistenceBackedSessionRepository
  extends DeviceSessionRepository
  implements DeviceSessionRepository
{
  constructor(
    readonly persistence: FakeDeviceSessionPersistence = new FakeDeviceSessionPersistence(),
  ) {
    super();
  }

  override upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs?: number,
    options?: UpsertActiveSessionOptions,
  ): Promise<number> {
    return this.persistence
      .upsertActiveSession(record, nowMs, options)
      .then((generation) => generation ?? 0);
  }

  override getSession(sessionUuid: string): Promise<DeviceSession | undefined> {
    return this.persistence.getSession(sessionUuid);
  }

  override listRecoverableSessions(
    nowMs?: number,
    livePeerDaemonSessionIds?: () => readonly string[],
  ): Promise<DeviceSession[]> {
    return this.persistence.listRecoverableSessions(nowMs, livePeerDaemonSessionIds);
  }

  override recordActivity(sessionUuid: string, update: DeviceSessionActivityUpdate): Promise<void> {
    return this.persistence.recordActivity(sessionUuid, update);
  }

  override recordRestartRecoveryActivity(sessionUuid: string, activityAtMs: number): Promise<void> {
    return this.persistence.recordRestartRecoveryActivity(sessionUuid, activityAtMs);
  }

  override claimRecoverableSession(
    sessionUuid: string,
    expected: RecoverableRowIncarnation,
    daemonSessionId: string,
  ): Promise<number | undefined> {
    return this.persistence.claimRecoverableSession(sessionUuid, expected, daemonSessionId);
  }

  override releaseRecoverableSessionClaim(
    sessionUuid: string,
    claimed: RecoverableRowIncarnation,
    previousOwner: string | null,
  ): Promise<boolean> {
    return this.persistence.releaseRecoverableSessionClaim(sessionUuid, claimed, previousOwner);
  }

  override recordLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    return this.persistence.recordLivenessOwnership(sessionUuid, ownerToken);
  }

  override replaceLivenessOwnership(sessionUuid: string, ownerToken: string | null): Promise<void> {
    return this.persistence.replaceLivenessOwnership(sessionUuid, ownerToken);
  }

  override markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options?: MarkReleasedOptions,
  ): Promise<void> {
    return this.persistence.markReleased(sessionUuid, status, releasedAtMs, reason, options);
  }

  override async markAutolockSession(): Promise<void> {}

  override async markStaleActiveSessionsExpired(): Promise<void> {}
}
