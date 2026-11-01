import { describe, expect, test } from "bun:test";
import {
  DeviceSessionNotActiveError,
  deviceRestartReleaseReason,
  type DeviceSessionRecord,
  type DeviceSessionRepository,
} from "../../src/db/deviceSessionRepository";

type Persistence = Pick<
  DeviceSessionRepository,
  "upsertActiveSession" | "getSession" | "markReleased" | "recordActivity"
>;

export interface DeviceSessionPersistenceHandle {
  repository: Persistence;
  dispose?: () => Promise<void>;
}

function record(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
  return {
    sessionUuid: "s1",
    deviceId: "emulator-5554",
    platform: "android",
    createdAtMs: 1_000,
    lastUsedAtMs: 1_000,
    expiresAtMs: 100_000,
    sessionTimeoutMs: 99_000,
    heartbeatTimeoutMs: 30_000,
    hasReceivedHeartbeat: false,
    ...overrides,
  };
}

async function view(repository: Persistence, sessionUuid: string) {
  const row = await repository.getSession(sessionUuid);
  return row
    ? {
        deviceId: row.device_id,
        platform: row.platform,
        status: row.status,
        releasedAtMs: row.released_at_ms,
        reason: row.release_reason,
        expiresAtMs: row.expires_at_ms,
        lastUsedAtMs: row.last_used_at_ms,
        daemonSessionId: row.daemon_session_id,
        policy: row.liveness_policy ?? null,
      }
    : undefined;
}

/**
 * Shared behavioural contract for the persistence surface the daemon tests drive through
 * `FakeDeviceSessionRepository` (#11868): create, read back, release, restart-handoff release
 * and activity. Release-reason strength, claims and ownership guards are not covered here.
 */
export function runDeviceSessionPersistenceContract(
  name: string,
  make: () => Promise<DeviceSessionPersistenceHandle>,
): void {
  const withRepository = async (
    body: (repository: Persistence) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`DeviceSession persistence contract: ${name}`, () => {
    test("an unknown session has no row", () =>
      withRepository(async (repository) => {
        expect(await repository.getSession("missing")).toBeUndefined();
      }));

    test("upsertActiveSession creates an active row that reads back", () =>
      withRepository(async (repository) => {
        const generation = await repository.upsertActiveSession(
          record({ daemonSessionId: "daemon-a", livenessPolicy: "heartbeat" }),
        );
        expect(generation).toBe(0);
        expect(await view(repository, "s1")).toEqual({
          deviceId: "emulator-5554",
          platform: "android",
          status: "active",
          releasedAtMs: null,
          reason: null,
          expiresAtMs: 100_000,
          lastUsedAtMs: 1_000,
          daemonSessionId: "daemon-a",
          policy: "heartbeat",
        });
      }));

    test("re-upserting a session advances its row generation and rebinds it", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record());
        const second = await repository.upsertActiveSession(
          record({ deviceId: "emulator-5556", expiresAtMs: 200_000 }),
        );
        expect(second).toBe(1);
        const third = await repository.upsertActiveSession(record());
        expect(third).toBe(2);
        expect((await view(repository, "s1"))?.deviceId).toBe("emulator-5554");
      }));

    test("markReleased records status, time and reason, and re-upserting revives the row", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record());
        await repository.markReleased("s1", "released", 5_000, { reason: "explicit" });
        expect(await view(repository, "s1")).toMatchObject({
          status: "released",
          releasedAtMs: 5_000,
          reason: "explicit",
        });
        await repository.upsertActiveSession(record());
        expect(await view(repository, "s1")).toMatchObject({
          status: "active",
          releasedAtMs: null,
          reason: null,
        });
      }));

    test("markReleased never creates a row for an unknown session", () =>
      withRepository(async (repository) => {
        await repository.markReleased("ghost", "released", 5_000, { reason: "explicit" });
        expect(await repository.getSession("ghost")).toBeUndefined();
      }));

    test("a restart-handoff release applies only inside its window", () =>
      withRepository(async (repository) => {
        const restart = deviceRestartReleaseReason("avd-1");
        const handoff = { releasedAtOrBeforeMs: 10_000, recoveryWindowMs: 20_000 };
        const releaseThenGuard = async (
          uuid: string,
          options: { releasedAt: number; expiresAtMs: number; reason: string },
        ) => {
          await repository.upsertActiveSession(
            record({ sessionUuid: uuid, expiresAtMs: options.expiresAtMs }),
          );
          await repository.markReleased(uuid, "released", options.releasedAt, {
            reason: options.reason,
          });
          await repository.markReleased(uuid, "expired", 50_000, {
            reason: "expired",
            onlyIfRestartRecoveryHandoff: handoff,
          });
          return view(repository, uuid);
        };

        // Idle deadline past released_at + window: the handoff is stale, so it is terminalized.
        expect(
          await releaseThenGuard("ok", { releasedAt: 5_000, expiresAtMs: 40_000, reason: restart }),
        ).toMatchObject({ status: "expired", reason: "expired" });
        // Deadline inside the window (activity could not extend it): left alone.
        expect(
          await releaseThenGuard("inside", {
            releasedAt: 5_000,
            expiresAtMs: 20_000,
            reason: restart,
          }),
        ).toMatchObject({ status: "released", reason: restart });
        // Released after the threshold: left alone.
        expect(
          await releaseThenGuard("late", {
            releasedAt: 15_000,
            expiresAtMs: 90_000,
            reason: restart,
          }),
        ).toMatchObject({ status: "released", reason: restart });
        // Not a device-restart reason: left alone.
        expect(
          await releaseThenGuard("other", {
            releasedAt: 5_000,
            expiresAtMs: 90_000,
            reason: "explicit",
          }),
        ).toMatchObject({ status: "released", reason: "explicit" });
      }));

    test("recordActivity updates an active row and rejects a missing or released one", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record());
        await repository.recordActivity("s1", {
          lastUsedAtMs: 2_000,
          expiresAtMs: 150_000,
          sessionTimeoutMs: 99_000,
          heartbeatTimeoutMs: 30_000,
          hasReceivedHeartbeat: true,
        });
        expect(await view(repository, "s1")).toMatchObject({
          lastUsedAtMs: 2_000,
          expiresAtMs: 150_000,
        });

        const update = {
          lastUsedAtMs: 3_000,
          expiresAtMs: 160_000,
          sessionTimeoutMs: 99_000,
          heartbeatTimeoutMs: 30_000,
          hasReceivedHeartbeat: true,
        };
        await expect(repository.recordActivity("missing", update)).rejects.toBeInstanceOf(
          DeviceSessionNotActiveError,
        );
        await repository.markReleased("s1", "released", 4_000, { reason: "explicit" });
        await expect(repository.recordActivity("s1", update)).rejects.toBeInstanceOf(
          DeviceSessionNotActiveError,
        );
        expect((await view(repository, "s1"))?.expiresAtMs).toBe(150_000);
      }));
  });
}
