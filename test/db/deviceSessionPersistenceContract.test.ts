import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  SESSION_RELEASE_REASON_FAMILY_TRAITS,
  SESSION_RELEASE_REASON_TRAITS,
  isTerminalReleaseReason,
} from "../../src/daemon/releaseReasons";
import {
  DeviceSessionRepository,
  DeviceSessionTerminallyReleasedError,
  type DeviceSessionPersistence,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
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
        expect(result).toBeInstanceOf(DeviceSessionTerminallyReleasedError);
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
          expect(result).toBeInstanceOf(DeviceSessionTerminallyReleasedError);
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
