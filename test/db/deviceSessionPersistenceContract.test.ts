import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  SESSION_RELEASE_REASON_FAMILY_TRAITS,
  SESSION_RELEASE_REASON_TRAITS,
  isTerminalReleaseReason,
} from "../../src/daemon/releaseReasons";
import {
  DeviceSessionRepository,
  DeviceSessionRowNotRewritableError,
  DeviceSessionRowNotReleasableError,
  DeviceSessionTerminallyReleasedError,
  isRecoverableDeviceSession,
  persistedSessionExpiryReason,
  DEVICE_SESSION_RETENTION_MAX_AGE_MS,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

// The statement-level guards of the device-session persistence (#11498), run against both the
// SQLite repository and the fake, so a unit test on the fake cannot pass where SQLite refuses.

const SESSION = "s1";
const IDLE_WINDOW_MS = 60_000;

const ALL_REASONS = [
  ...Object.keys(SESSION_RELEASE_REASON_TRAITS),
  ...Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS).map((family) => `${family}Pixel_8`),
];
const TERMINAL_REASONS = ALL_REASONS.filter((reason) => isTerminalReleaseReason(reason));
const NON_TERMINAL_REASONS = [
  ...ALL_REASONS.filter((reason) => !isTerminalReleaseReason(reason)),
  // A reason this build does not know (an older or newer daemon wrote it) is not terminal.
  "some-future-reason",
];

function record(overrides: Partial<DeviceSessionRecord> = {}): DeviceSessionRecord {
  return {
    sessionUuid: SESSION,
    deviceId: "emulator-5554",
    stableDeviceId: "Pixel_8",
    platform: "android",
    daemonSessionId: "daemon-a",
    createdAtMs: 1_000,
    lastUsedAtMs: 1_000,
    expiresAtMs: 5_000,
    sessionTimeoutMs: IDLE_WINDOW_MS,
    heartbeatTimeoutMs: IDLE_WINDOW_MS,
    hasReceivedHeartbeat: true,
    ...overrides,
  };
}

let db: Kysely<Database> | undefined;

beforeAll(async () => {
  // Warm the migrated template outside the per-test budget.
  await (await createTestDatabase()).destroy();
});

afterEach(async () => {
  await db?.destroy();
  db = undefined;
});

const implementations: Array<[string, () => Promise<DeviceSessionPersistence>]> = [
  [
    "DeviceSessionRepository (SQLite)",
    async () => {
      db = await createTestDatabase();
      return new DeviceSessionRepository(db, new FakeTimer());
    },
  ],
  ["FakeDeviceSessionPersistence", async () => new FakeDeviceSessionPersistence()],
];

describe.each(implementations)("device-session persistence contract: %s", (_name, create) => {
  async function rowOf(persistence: DeviceSessionPersistence) {
    return await persistence.getSession?.(SESSION);
  }

  test("activity sequence accepts a backward wall step and rejects a delayed older write", async () => {
    const persistence = await create();
    await persistence.upsertActiveSession(record({ activitySeq: 1_000 }));
    await persistence.recordActivity(
      SESSION,
      record({
        lastUsedAtMs: 500,
        activitySeq: 2_000,
        expiresAtMs: 60_500,
        livenessPolicy: "managed-execution",
      }),
    );
    await persistence.recordActivity(
      SESSION,
      record({
        lastUsedAtMs: 3_000,
        activitySeq: 1_500,
        expiresAtMs: 63_000,
      }),
    );
    expect(await rowOf(persistence)).toMatchObject({
      activity_seq: 2_000,
      last_used_at_ms: 500,
      expires_at_ms: 60_500,
      liveness_policy: "managed-execution",
    });
    // Strict >: a policy rewrite at the same activity instant still applies.
    await persistence.recordActivity(
      SESSION,
      record({
        lastUsedAtMs: 500,
        activitySeq: 2_000,
        expiresAtMs: 70_500,
      }),
    );
    expect(await rowOf(persistence)).toMatchObject({
      expires_at_ms: 70_500,
      liveness_policy: null,
    });
  });

  test("omitted sequences use lastUsedAtMs and an upsert resets the daemon-local sequence", async () => {
    const persistence = await create();
    await persistence.upsertActiveSession(record());
    await persistence.recordActivity(SESSION, record({ lastUsedAtMs: 2_000 }));
    await persistence.recordActivity(SESSION, record({ lastUsedAtMs: 1_500, expiresAtMs: 1_501 }));
    expect(await rowOf(persistence)).toMatchObject({
      activity_seq: 2_000,
      last_used_at_ms: 2_000,
      expires_at_ms: 5_000,
    });
    await persistence.upsertActiveSession(record({ activitySeq: 1 }));
    await persistence.recordActivity(SESSION, record({ activitySeq: 2, lastUsedAtMs: 500 }));
    expect(await rowOf(persistence)).toMatchObject({ activity_seq: 2, last_used_at_ms: 500 });
  });

  test.each(["managed-execution", "heartbeat"])(
    "expired idle deadline recovery for %s",
    async (policy) => {
      const persistence = await create();
      await persistence.upsertActiveSession(
        record({ livenessPolicy: policy as "managed-execution" | "heartbeat" }),
      );
      await persistence.markReleased(SESSION, "released", 2_000, "daemon-shutdown");
      const rows = await persistence.listRecoverableSessions(30 * 60_000);
      const managed = policy === "managed-execution";
      expect(rows.map((row) => row.session_uuid)).toEqual(managed ? [SESSION] : []);
      expect((await rowOf(persistence))?.release_reason).toBe(
        managed ? "daemon-shutdown" : "expired",
      );
    },
  );

  test("managed predicates and SELECTs keep restart and terminal bounds beyond idle expiry", async () => {
    const persistence = await create();
    await persistence.upsertActiveSession(record({ livenessPolicy: "managed-execution" }));
    await persistence.markReleased(SESSION, "released", 2_000, "device-restart:Pixel_8");
    const row = (await rowOf(persistence))!;
    expect(isRecoverableDeviceSession(row, 6_000)).toBe(true);
    expect(persistedSessionExpiryReason(row, 6_000)).toBeUndefined();
    expect(isRecoverableDeviceSession(row, 2_001 + DEVICE_SESSION_RETENTION_MAX_AGE_MS)).toBe(
      false,
    );
    expect(
      (await persistence.listRecoverableSessions(6_000)).map((entry) => entry.session_uuid),
    ).toEqual([SESSION]);
    const windowEnd = 2_000 + DEFAULT_DEVICE_READY_TIMEOUT_MS;
    expect(persistedSessionExpiryReason(row, windowEnd)).toBe("restart-recovery-timeout");
    expect(await persistence.listRecoverableSessions(windowEnd)).toEqual([]);
    expect((await rowOf(persistence))?.release_reason).toBe("restart-recovery-timeout");
  });

  test("managed terminal releases are never returned despite idle exemption", async () => {
    const persistence = await create();
    await persistence.upsertActiveSession(record({ livenessPolicy: "managed-execution" }));
    await persistence.markReleased(SESSION, "released", 2_000, "heartbeat-timeout");
    expect(await persistence.listRecoverableSessions(30 * 60_000)).toEqual([]);
    expect((await rowOf(persistence))?.release_reason).toBe("heartbeat-timeout");
  });

  test("managed idle exemption never bypasses released-row retention", async () => {
    const persistence = await create();
    await persistence.upsertActiveSession(record({ livenessPolicy: "managed-execution" }));
    await persistence.markReleased(SESSION, "released", 2_000, "daemon-shutdown");
    expect(
      await persistence.listRecoverableSessions(2_001 + DEVICE_SESSION_RETENTION_MAX_AGE_MS),
    ).toEqual([]);
  });

  test.each(["unchanged", "resumed", "new-handoff", "idle-first", "generation", "peer"])(
    "restart window statement preserves a %s row",
    async (change) => {
      const persistence = await create();
      const generation = await persistence.upsertActiveSession(record({ expiresAtMs: 301_000 }));
      await persistence.markReleased(SESSION, "released", 1_000, "device-restart:Pixel_8");
      if (change === "resumed" || change === "generation" || change === "peer") {
        await persistence.upsertActiveSession(
          record({
            expiresAtMs: 301_000,
            daemonSessionId: change === "peer" ? "peer" : "daemon-a",
          }),
        );
        if (change !== "resumed") {
          await persistence.markReleased(SESSION, "released", 1_000, "device-restart:Pixel_8");
        }
      } else if (change === "new-handoff") {
        await persistence.markReleased(SESSION, "released", 2_000, "device-restart:Pixel_8");
      } else if (change === "idle-first") {
        await persistence.upsertActiveSession(record({ expiresAtMs: 181_000 }));
        await persistence.markReleased(SESSION, "released", 1_000, "device-restart:Pixel_8");
      }
      const before = structuredClone(await rowOf(persistence));
      await persistence.markReleased(SESSION, "expired", 181_001, "restart-recovery-timeout", {
        expectedRowGeneration:
          change === "generation"
            ? typeof generation === "number"
              ? generation
              : 0
            : (before?.stable_identity_generation ?? 0),
        onlyIfOwnedByDaemon: "daemon-a",
        onlyIfRecoverable: true,
        onlyIfRestartRecoveryHandoff: {
          releasedAtOrBeforeMs: 1_000,
          recoveryWindowMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
        },
      });
      if (change === "unchanged") {
        expect(await rowOf(persistence)).toMatchObject({
          status: "expired",
          release_reason: "restart-recovery-timeout",
        });
      } else {
        expect(await rowOf(persistence)).toEqual(before);
      }
    },
  );

  test.each([null, "daemon-a", "daemon-other"])(
    "own-or-unowned statement predicates with owner %p",
    async (owner) => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ daemonSessionId: owner }));
      const before = structuredClone(await rowOf(persistence));
      const guard = {
        supersededReasons: [],
        livePeerDaemonSessionIds: [],
        ownDaemonSessionId: "daemon-a",
      };
      const upsert = persistence.upsertActiveSession(
        record({ deviceId: "new-device" }),
        undefined,
        {
          rewriteOverSupersededRelease: guard,
        },
      );
      if (owner === "daemon-other") {
        await expect(upsert).rejects.toBeInstanceOf(DeviceSessionRowNotRewritableError);
        expect(await rowOf(persistence)).toEqual(before);
      } else {
        await upsert;
        expect(await rowOf(persistence)).toMatchObject({ device_id: "new-device" });
      }
      const release = persistence.markReleased(SESSION, "released", 3_000, "explicit-release", {
        unlessTerminalOrOwnedByLivePeer: guard,
      });
      if (owner === "daemon-other") {
        await expect(release).rejects.toBeInstanceOf(DeviceSessionRowNotReleasableError);
        expect(await rowOf(persistence)).toEqual(before);
      } else {
        await release;
        expect(await rowOf(persistence)).toMatchObject({ release_reason: "explicit-release" });
      }
    },
  );

  test.each([null, "daemon-a", "daemon-other"])(
    "release own-or-unowned statement predicate with owner %p",
    async (owner) => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ daemonSessionId: owner }));
      const before = structuredClone(await rowOf(persistence));
      const release = persistence.markReleased(SESSION, "released", 3_000, "explicit-release", {
        unlessTerminalOrOwnedByLivePeer: {
          livePeerDaemonSessionIds: [],
          ownDaemonSessionId: "daemon-a",
        },
      });
      if (owner === "daemon-other") {
        await expect(release).rejects.toBeInstanceOf(DeviceSessionRowNotReleasableError);
        expect(await rowOf(persistence)).toEqual(before);
      } else {
        await release;
        expect(await rowOf(persistence)).toMatchObject({ release_reason: "explicit-release" });
      }
    },
  );

  test("two-step release writers receive a typed generation miss", async () => {
    const persistence = await create();
    const generation = await persistence.upsertActiveSession(record());
    const before = structuredClone(await rowOf(persistence));
    await expect(
      persistence.markReleased(SESSION, "released", 3_000, "explicit-release", {
        expectedRowGeneration: Number(generation) + 1,
        unlessTerminalOrOwnedByLivePeer: { livePeerDaemonSessionIds: [], reportRefusal: true },
      }),
    ).rejects.toBeInstanceOf(DeviceSessionRowNotReleasableError);
    expect(await rowOf(persistence)).toEqual(before);
  });

  describe("markReleased preserving terminal releases and live peers", () => {
    test.each([
      { reason: null, owner: "daemon-a", refused: false },
      { reason: null, owner: null, refused: false },
      { reason: null, owner: "daemon-dead", refused: false },
      { reason: null, owner: "daemon-peer", refused: true },
      { reason: "explicit-release", owner: "daemon-a", refused: true },
      { reason: "explicit-release", owner: "daemon-peer", refused: true },
      { reason: "device-disconnected:emulator-5554", owner: "daemon-a", refused: true },
      { reason: "plan-auto-release", owner: "daemon-a", refused: false },
    ])("guarded release with %p", async ({ reason, owner, refused }) => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ daemonSessionId: owner }));
      if (reason) {
        await persistence.markReleased(SESSION, "released", 2_000, reason);
      }
      const before = structuredClone(await rowOf(persistence));
      const result = await persistence
        .markReleased(SESSION, "released", 3_000, "device-disconnected:emulator-5554", {
          unlessTerminalOrOwnedByLivePeer: { livePeerDaemonSessionIds: ["daemon-peer"] },
        })
        .then(
          () => "written",
          (error: unknown) => error,
        );
      if (refused) {
        expect(result).toBeInstanceOf(DeviceSessionRowNotReleasableError);
        expect(await rowOf(persistence)).toEqual(before);
      } else {
        expect(result).toBe("written");
        expect(await rowOf(persistence)).toMatchObject({
          status: "released",
          release_reason: "device-disconnected:emulator-5554",
        });
      }
    });

    test.each(["daemon-a", "daemon-peer"])(
      "a committed terminal release replaces only our superseded row: %s",
      async (owner) => {
        const persistence = await create();
        await persistence.upsertActiveSession(record({ daemonSessionId: owner }));
        await persistence.markReleased(
          SESSION,
          "released",
          2_000,
          "device-disconnected:emulator-5554",
        );
        const before = structuredClone(await rowOf(persistence));
        const result = await persistence
          .markReleased(SESSION, "released", 3_000, "explicit-release", {
            unlessTerminalOrOwnedByLivePeer: {
              livePeerDaemonSessionIds: ["daemon-peer"],
              supersededReasons: ["device-disconnected:emulator-5554"],
            },
          })
          .then(
            () => "written",
            (error: unknown) => error,
          );
        if (owner === "daemon-peer") {
          expect(result).toBeInstanceOf(DeviceSessionRowNotReleasableError);
          expect(await rowOf(persistence)).toEqual(before);
        } else {
          expect(result).toBe("written");
          expect(await rowOf(persistence)).toMatchObject({ release_reason: "explicit-release" });
        }
      },
    );

    test("the existing generation mismatch stays a silent no-op with the new guard", async () => {
      const persistence = await create();
      const generation = await persistence.upsertActiveSession(record());
      const before = structuredClone(await rowOf(persistence));
      await persistence.markReleased(SESSION, "released", 3_000, "explicit-release", {
        expectedRowGeneration: Number(generation) + 1,
        unlessTerminalOrOwnedByLivePeer: { livePeerDaemonSessionIds: [] },
      });
      expect(await rowOf(persistence)).toEqual(before);
    });
  });

  describe("markReleased with onlyIfExpiredAtMs", () => {
    test("releases a row whose deadline is at or before the instant", async () => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ expiresAtMs: 5_000 }));

      await persistence.markReleased(SESSION, "expired", 5_000, "expired", {
        onlyIfExpiredAtMs: 5_000,
      });

      expect(await rowOf(persistence)).toMatchObject({
        status: "expired",
        release_reason: "expired",
        released_at_ms: 5_000,
      });
    });

    test("leaves an active row whose lease an activity write extended past the instant", async () => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ expiresAtMs: 5_000 }));
      await persistence.recordActivity(SESSION, {
        lastUsedAtMs: 4_900,
        expiresAtMs: 4_900 + IDLE_WINDOW_MS,
        sessionTimeoutMs: IDLE_WINDOW_MS,
        heartbeatTimeoutMs: IDLE_WINDOW_MS,
        hasReceivedHeartbeat: true,
      });

      await persistence.markReleased(SESSION, "expired", 6_000, "expired", {
        onlyIfExpiredAtMs: 6_000,
      });

      expect(await rowOf(persistence)).toMatchObject({
        status: "active",
        release_reason: null,
        released_at_ms: null,
        expires_at_ms: 4_900 + IDLE_WINDOW_MS,
      });
    });

    test("leaves a device-restart row whose recovery window activity extended past the instant", async () => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ expiresAtMs: 5_000 }));
      await persistence.markReleased(SESSION, "released", 2_000, "device-restart:Pixel_8");
      await persistence.recordRestartRecoveryActivity?.(SESSION, 4_900);

      await persistence.markReleased(SESSION, "expired", 6_000, "expired", {
        onlyIfExpiredAtMs: 6_000,
      });

      expect(await rowOf(persistence)).toMatchObject({
        status: "released",
        release_reason: "device-restart:Pixel_8",
        released_at_ms: 2_000,
        expires_at_ms: 4_900 + IDLE_WINDOW_MS,
      });
    });
  });

  describe("upsertActiveSession with unlessTerminal", () => {
    test("writes a row that does not exist yet", async () => {
      const persistence = await create();

      await persistence.upsertActiveSession(record(), 1_000, { unlessTerminal: true });

      expect(await rowOf(persistence)).toMatchObject({ status: "active", release_reason: null });
    });

    test("replaces an active row", async () => {
      const persistence = await create();
      await persistence.upsertActiveSession(record());

      await persistence.upsertActiveSession(record({ lastUsedAtMs: 2_000 }), 2_000, {
        unlessTerminal: true,
      });

      expect(await rowOf(persistence)).toMatchObject({
        status: "active",
        release_reason: null,
        last_used_at_ms: 2_000,
      });
    });

    test.each(NON_TERMINAL_REASONS)(
      "makes a row released for the non-terminal reason %s active again",
      async (reason) => {
        const persistence = await create();
        await persistence.upsertActiveSession(record());
        await persistence.markReleased(SESSION, "released", 2_000, reason);

        await persistence.upsertActiveSession(record({ lastUsedAtMs: 3_000 }), 3_000, {
          unlessTerminal: true,
        });

        expect(await rowOf(persistence)).toMatchObject({
          status: "active",
          release_reason: null,
          released_at_ms: null,
          last_used_at_ms: 3_000,
        });
      },
    );

    test.each(TERMINAL_REASONS)(
      "refuses to revive a row released for the terminal reason %s",
      async (reason) => {
        const persistence = await create();
        await persistence.upsertActiveSession(record());
        await persistence.markReleased(SESSION, "released", 2_000, reason);
        const before = await rowOf(persistence);

        const refusal = await persistence
          .upsertActiveSession(record({ lastUsedAtMs: 3_000 }), 3_000, { unlessTerminal: true })
          .then(
            () => undefined,
            (error: unknown) => error,
          );

        expect(refusal).toBeInstanceOf(DeviceSessionTerminallyReleasedError);
        // Nothing was written: the release, its stamps and the row generation all stand.
        expect(await rowOf(persistence)).toEqual(before);
        expect(before).toMatchObject({ status: "released", release_reason: reason });
      },
    );

    test("without the option a terminal row is still replaced, as a fresh creation needs", async () => {
      const persistence = await create();
      await persistence.upsertActiveSession(record());
      await persistence.markReleased(SESSION, "released", 2_000, "explicit-release");

      await persistence.upsertActiveSession(record({ lastUsedAtMs: 3_000 }), 3_000);

      expect(await rowOf(persistence)).toMatchObject({ status: "active", release_reason: null });
    });
  });

  describe("upsertActiveSession with rewriteOverSupersededRelease", () => {
    test.each([
      { owner: "daemon-a", generationChanged: false, refused: false },
      { owner: "daemon-a", generationChanged: true, refused: true },
      { owner: "daemon-peer", generationChanged: false, refused: true },
      { owner: "daemon-dead", generationChanged: false, refused: false },
    ])(
      "activity replacement matches its generation and excludes live peers: %p",
      async ({ owner, generationChanged, refused }) => {
        const persistence = await create();
        const generation = await persistence.upsertActiveSession(
          record({ daemonSessionId: owner }),
        );
        await persistence.markReleased(SESSION, "released", 2_000, "daemon-restart");
        if (generationChanged) {
          await persistence.upsertActiveSession(
            record({ deviceId: "replacement", daemonSessionId: owner }),
          );
        }
        const before = structuredClone(await rowOf(persistence));
        const result = await persistence
          .upsertActiveSession(record({ lastUsedAtMs: 3_000 }), 3_000, {
            unlessTerminal: true,
            rewriteOverSupersededRelease: {
              supersededReasons: [],
              livePeerDaemonSessionIds: ["daemon-peer"],
              expectedRowGeneration: Number(generation),
            },
          })
          .then(
            () => "written",
            (error: unknown) => error,
          );
        if (refused) {
          expect(result).toBeInstanceOf(DeviceSessionRowNotRewritableError);
          expect(await rowOf(persistence)).toEqual(before);
        } else {
          expect(result).toBe("written");
          expect(await rowOf(persistence)).toMatchObject({
            status: "active",
            release_reason: null,
          });
        }
      },
    );

    const cases = [
      { reason: "device-disconnected:emulator-5554", owner: "daemon-a", replaced: true },
      { reason: "explicit-release", owner: "daemon-a", replaced: false },
      { reason: "plan-auto-release", owner: "daemon-a", replaced: true },
      { reason: null, owner: "daemon-a", replaced: true },
      { reason: null, owner: "daemon-peer", replaced: false },
      { reason: "plan-auto-release", owner: "daemon-peer", replaced: false },
      { reason: "device-disconnected:emulator-5554", owner: "daemon-peer", replaced: false },
      { reason: null, owner: null, replaced: true },
      { reason: "device-disconnected:emulator-5554", owner: null, replaced: true },
      { reason: null, owner: "daemon-dead", replaced: true },
      { reason: "plan-auto-release", owner: "daemon-dead", replaced: true },
    ];

    test.each(cases)("conditions replacement on the reason and owner: %p", async (scenario) => {
      const persistence = await create();
      await persistence.upsertActiveSession(record({ daemonSessionId: scenario.owner }));
      if (scenario.reason) {
        await persistence.markReleased(SESSION, "released", 2_000, scenario.reason);
      }
      const before = structuredClone(await rowOf(persistence));

      const result = await persistence
        .upsertActiveSession(record({ deviceId: "replacement", lastUsedAtMs: 3_000 }), 3_000, {
          rewriteOverSupersededRelease: {
            supersededReasons: ["device-disconnected:emulator-5554"],
            livePeerDaemonSessionIds: ["daemon-peer"],
          },
        })
        .then(
          () => "written",
          (error: unknown) => error,
        );

      if (scenario.replaced) {
        expect(result).toBe("written");
        expect(await rowOf(persistence)).toMatchObject({
          status: "active",
          release_reason: null,
          device_id: "replacement",
          daemon_session_id: "daemon-a",
          stable_identity_generation: (before?.stable_identity_generation ?? 0) + 1,
        });
      } else {
        expect(result).toHaveProperty("name", "DeviceSessionRowNotRewritableError");
        expect(result).toBeInstanceOf(DeviceSessionRowNotRewritableError);
        expect(await rowOf(persistence)).toEqual(before);
      }
    });

    test("inserts a missing row with the rewrite guard", async () => {
      const persistence = await create();
      await persistence.upsertActiveSession(record(), 1_000, {
        rewriteOverSupersededRelease: {
          supersededReasons: [],
          livePeerDaemonSessionIds: ["daemon-peer"],
        },
      });
      expect(await rowOf(persistence)).toMatchObject({ status: "active", release_reason: null });
    });

    test.each([null, "plan-auto-release", "explicit-release"])(
      "empty lists behave like unlessTerminal for reason %p, with no owner guard",
      async (reason) => {
        const persistence = await create();
        await persistence.upsertActiveSession(record({ daemonSessionId: "daemon-peer" }));
        if (reason) {
          await persistence.markReleased(SESSION, "released", 2_000, reason);
        }
        const before = structuredClone(await rowOf(persistence));
        const result = await persistence
          .upsertActiveSession(record({ lastUsedAtMs: 3_000 }), 3_000, {
            rewriteOverSupersededRelease: {
              supersededReasons: [],
              livePeerDaemonSessionIds: [],
            },
          })
          .then(
            () => "written",
            (error: unknown) => error,
          );
        if (reason === "explicit-release") {
          expect(result).toHaveProperty("name", "DeviceSessionRowNotRewritableError");
          expect(result).toBeInstanceOf(DeviceSessionRowNotRewritableError);
          expect(await rowOf(persistence)).toEqual(before);
        } else {
          expect(result).toBe("written");
          expect(await rowOf(persistence)).toMatchObject({
            status: "active",
            release_reason: null,
          });
        }
      },
    );
  });
});
