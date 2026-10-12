import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { releaseReasonMayReplace } from "../../src/daemon/releaseReasons";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "s1";

describe("device session release fence (#11418)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: DeviceSessionRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    repo = new DeviceSessionRepository(db, timer);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedRow(): Promise<void> {
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      daemonSessionId: "dead-daemon",
      createdAtMs: 1_000,
      lastUsedAtMs: 1_000,
      expiresAtMs: 10_000_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: true,
    });
  }

  /** A repository whose `expired` sweep release is preceded by a peer's release with `peerReason`. */
  function racingRepository(peerReason: string): DeviceSessionRepository {
    class RacingRepository extends DeviceSessionRepository {
      override async markReleased(
        ...args: Parameters<DeviceSessionRepository["markReleased"]>
      ): Promise<void> {
        if (args[3] === "expired") {
          await super.markReleased(SESSION, "released", 2_000, peerReason);
        }
        return await super.markReleased(...args);
      }
    }
    return new RacingRepository(db, timer);
  }

  // none < non-terminal < idle terminal < other terminal; an equal strength replaces.
  const HELD = [
    "daemon-shutdown",
    "plan-auto-release",
    "expired",
    "device-restart:Pixel",
    "lazy-expiry",
    "explicit-release",
    "device-killed",
    "device-disconnected:Pixel",
    "identity-recovery-unproven",
    "heartbeat-timeout",
  ];
  const CANDIDATES = [...HELD, "unknown-future-reason"];

  for (const held of HELD) {
    for (const candidate of CANDIDATES) {
      test(`${candidate} over ${held} matches releaseReasonMayReplace`, async () => {
        await seedRow();
        await repo.markReleased(SESSION, "released", 1_500, held);

        await repo.markReleased(SESSION, "released", 2_000, candidate);

        const expected = releaseReasonMayReplace(candidate, held) ? candidate : held;
        expect((await repo.getSession(SESSION))?.release_reason).toBe(expected);
      });
    }
  }

  test("a release replaces an active row with no reason", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 2_000, "expired");
    expect((await repo.getSession(SESSION))?.release_reason).toBe("expired");
  });

  test("the expired-row sweep does not overwrite a terminal release that lands after its select", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 1_500, "daemon-shutdown");

    await racingRepository("explicit-release").listRecoverableSessions(20_000_000);

    expect((await repo.getSession(SESSION))?.release_reason).toBe("explicit-release");
  });

  test("the sweep leaves a row re-released as a non-recoverable reason alone", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 1_500, "daemon-shutdown");

    await racingRepository("plan-auto-release").listRecoverableSessions(20_000_000);

    expect((await repo.getSession(SESSION))?.release_reason).toBe("plan-auto-release");
  });

  test("the sweep still terminalizes an expired recoverable row", async () => {
    await seedRow();
    await repo.markReleased(SESSION, "released", 1_500, "daemon-shutdown");

    await repo.listRecoverableSessions(20_000_000);

    expect(await repo.getSession(SESSION)).toMatchObject({
      release_reason: "expired",
      status: "expired",
    });
  });
});
