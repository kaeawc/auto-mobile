import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import {
  DeviceSessionRepository,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

const initialIso = "2031-01-02T03:04:05.000Z";
const initialMs = Date.parse(initialIso);

describe("DeviceSessionRepository injected timestamp clock", () => {
  let db: Kysely<Database>;
  let repo: DeviceSessionRepository;
  let timer: FakeTimer;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(() => {
    timer = new FakeTimer();
    timer.advanceTime(initialMs);
    repo = new DeviceSessionRepository(db, timer);
  });

  function record(sessionUuid: string): DeviceSessionRecord {
    return {
      sessionUuid,
      deviceId: "emulator-5554",
      platform: "android",
      daemonSessionId: "previous-daemon",
      createdAtMs: initialMs,
      lastUsedAtMs: timer.now(),
      expiresAtMs: timer.now() + 60_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      hasReceivedHeartbeat: false,
    };
  }

  test("upsertActiveSession stamps creation and updates from the injected clock", async () => {
    const sessionUuid = "timestamp-upsert";
    await repo.upsertActiveSession(record(sessionUuid));
    expect(await repo.getSession(sessionUuid)).toMatchObject({
      created_at: initialIso,
      updated_at: initialIso,
    });

    timer.advanceTime(1234);
    await repo.upsertActiveSession(record(sessionUuid));
    expect(await repo.getSession(sessionUuid)).toMatchObject({
      created_at: initialIso,
      updated_at: "2031-01-02T03:04:06.234Z",
    });
  });

  const mutations: {
    name: string;
    mutate: (sessionUuid: string) => Promise<void>;
  }[] = [
    {
      name: "recordActivity",
      mutate: (sessionUuid) => repo.recordActivity(sessionUuid, record(sessionUuid)),
    },
    {
      name: "replaceLivenessOwnership",
      mutate: (sessionUuid) => repo.replaceLivenessOwnership(sessionUuid, "owner-token"),
    },
    {
      name: "markAutolockSession",
      mutate: (sessionUuid) => repo.markAutolockSession(sessionUuid, record(sessionUuid)),
    },
    {
      name: "markReleased",
      mutate: (sessionUuid) =>
        repo.markReleased(sessionUuid, "released", timer.now(), "explicit-release"),
    },
    {
      name: "markStaleActiveSessionsExpired",
      mutate: () => repo.markStaleActiveSessionsExpired("current-daemon", timer.now()),
    },
  ];

  test.each(mutations)(
    "$name stamps updates from the advancing injected clock",
    async (mutation) => {
      const sessionUuid = `timestamp-${mutation.name}`;
      await repo.upsertActiveSession(record(sessionUuid));

      timer.advanceTime(1234);
      await mutation.mutate(sessionUuid);
      expect((await repo.getSession(sessionUuid))?.updated_at).toBe("2031-01-02T03:04:06.234Z");

      // Reactivate terminal rows so both expiry and release exercise a fresh write.
      await repo.upsertActiveSession(record(sessionUuid));
      timer.advanceTime(1234);
      await mutation.mutate(sessionUuid);
      expect(await repo.getSession(sessionUuid)).toMatchObject({
        created_at: initialIso,
        updated_at: "2031-01-02T03:04:07.468Z",
      });
    },
  );
});
