import { describe, expect, test } from "bun:test";
import {
  DeviceSessionNotActiveError,
  type DeviceSessionActivityUpdate,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";

export interface DeviceSessionLivenessHandle {
  repository: DeviceSessionPersistence;
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

function activity(overrides: Partial<DeviceSessionActivityUpdate> = {}) {
  return {
    lastUsedAtMs: 2_000,
    expiresAtMs: 150_000,
    sessionTimeoutMs: 99_000,
    heartbeatTimeoutMs: 30_000,
    hasReceivedHeartbeat: true,
    ...overrides,
  };
}

/**
 * Shared behavioural contract for the liveness-contract generation, activity ordering, liveness
 * ownership and recoverable-claim surface of {@link DeviceSessionPersistence} (#11868): the
 * counters and guards that the basic persistence contract does not cover.
 */
export function runDeviceSessionLivenessContract(
  name: string,
  make: () => Promise<DeviceSessionLivenessHandle>,
): void {
  const withRepository = async (
    body: (repository: DeviceSessionPersistence) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`DeviceSession liveness contract: ${name}`, () => {
    test("every upsert and every accepted activity write advances the liveness contract generation", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record());
        const inserted = (await repository.getSession("s1"))!.liveness_contract_generation ?? 0;

        await repository.upsertActiveSession(record());
        const upserted = (await repository.getSession("s1"))!.liveness_contract_generation ?? 0;
        expect(upserted).toBe(inserted + 1);

        await repository.recordActivity("s1", activity());
        expect((await repository.getSession("s1"))!.liveness_contract_generation).toBe(
          upserted + 1,
        );
      }));

    test("a stale activity write keeps the newer deadlines but still advances the generation", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record());
        await repository.recordActivity("s1", activity({ lastUsedAtMs: 5_000 }));
        const before = (await repository.getSession("s1"))!.liveness_contract_generation ?? 0;

        await repository.recordActivity(
          "s1",
          activity({ lastUsedAtMs: 3_000, expiresAtMs: 120_000 }),
        );
        const row = (await repository.getSession("s1"))!;
        expect(row.last_used_at_ms).toBe(5_000);
        expect(row.expires_at_ms).toBe(150_000);
        expect(row.activity_seq).toBe(5_000);
        expect(row.liveness_contract_generation).toBe(before + 1);
      }));

    test("re-upserting keeps the original creation time and liveness owner", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record({ createdAtMs: 1_000 }));
        await repository.recordLivenessOwnership("s1", "owner-a");
        await repository.upsertActiveSession(record({ createdAtMs: 9_000, lastUsedAtMs: 9_000 }));
        const row = (await repository.getSession("s1"))!;
        expect(row.created_at_ms).toBe(1_000);
        expect(row.last_used_at_ms).toBe(9_000);
        expect(row.liveness_owner_token).toBe("owner-a");
      }));

    test("liveness ownership is recorded, replaced and cleared on active rows only", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record());
        await repository.replaceLivenessOwnership("s1", "owner-a");
        expect((await repository.getSession("s1"))!.liveness_owner_token).toBe("owner-a");
        await repository.replaceLivenessOwnership("s1", null);
        expect((await repository.getSession("s1"))!.liveness_owner_token).toBeNull();

        await expect(repository.recordLivenessOwnership("missing", "x")).rejects.toBeInstanceOf(
          DeviceSessionNotActiveError,
        );
        await repository.markReleased("s1", "released", 4_000, { reason: "explicit" });
        await expect(repository.replaceLivenessOwnership("s1", "x")).rejects.toBeInstanceOf(
          DeviceSessionNotActiveError,
        );
      }));

    test("a claim needs the exact row incarnation and a re-issuable release", () =>
      withRepository(async (repository) => {
        await repository.upsertActiveSession(record({ daemonSessionId: "daemon-a" }));
        const incarnation = { rowGeneration: 0, daemonSessionId: "daemon-a" };

        // Active rows are never claimable.
        expect(await repository.claimRecoverableSession("s1", incarnation, "daemon-b")).toBe(
          undefined,
        );

        await repository.markReleased("s1", "released", 4_000, { reason: "daemon-shutdown" });
        expect(
          await repository.claimRecoverableSession(
            "s1",
            { rowGeneration: 7, daemonSessionId: "daemon-a" },
            "daemon-b",
          ),
        ).toBeUndefined();

        const claimed = await repository.claimRecoverableSession("s1", incarnation, "daemon-b");
        expect(claimed).toBe(1);
        const row = (await repository.getSession("s1"))!;
        expect(row.daemon_session_id).toBe("daemon-b");
        expect(row.stable_identity_generation).toBe(1);

        // The stale incarnation can no longer claim or give the claim back.
        expect(
          await repository.claimRecoverableSession("s1", incarnation, "daemon-c"),
        ).toBeUndefined();
        expect(await repository.releaseRecoverableSessionClaim("s1", incarnation, "daemon-a")).toBe(
          false,
        );
        expect(
          await repository.releaseRecoverableSessionClaim(
            "s1",
            { rowGeneration: 1, daemonSessionId: "daemon-b" },
            "daemon-a",
          ),
        ).toBe(true);
        const restored = (await repository.getSession("s1"))!;
        expect(restored.daemon_session_id).toBe("daemon-a");
        expect(restored.stable_identity_generation).toBe(2);
      }));
  });
}
