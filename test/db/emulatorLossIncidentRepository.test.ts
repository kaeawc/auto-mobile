import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Kysely } from "kysely";
import { EmulatorLossIncidentRepository } from "../../src/db/emulatorLossIncidentRepository";
import type { Database } from "../../src/db/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { createTestDatabase } from "./testDbHelper";

describe("EmulatorLossIncidentRepository", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("persists recovery attempts and prunes oldest records", async () => {
    const repository = new EmulatorLossIncidentRepository(
      new FakeTimer(),
      new CountingIdGenerator("incident"),
      2,
      db,
    );
    const first = await repository.open({
      deviceId: "emulator-5554",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });
    const second = await repository.open({
      deviceId: "emulator-5556",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });
    const third = await repository.open({
      deviceId: "emulator-5558",
      detectionPath: "adb-transport-failure",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });

    await repository.recordRecoveryAttempt(third.id, { attempt: 1, outcome: "failed" });
    await repository.completeRecovery(third.id, "exhausted");

    expect(await repository.get(first.id)).toBeUndefined();
    expect((await repository.list()).map((incident) => incident.id)).toEqual([third.id, second.id]);
    expect((await repository.get(third.id))?.recovery).toEqual({
      policy: { onLoss: true, maxAttempts: 2 },
      attempts: [{ attempt: 1, outcome: "failed" }],
      outcome: "exhausted",
    });
  });

  test("retains the most recently inserted incident when timestamps tie", async () => {
    const ids = ["z-first", "a-second"];
    const repository = new EmulatorLossIncidentRepository(
      new FakeTimer(),
      { next: () => ids.shift()! },
      1,
      db,
    );
    const first = await repository.open({
      deviceId: "emulator-5554",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });
    const second = await repository.open({
      deviceId: "emulator-5556",
      detectionPath: "device-discovery-miss",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });

    expect(await repository.get(first.id)).toBeUndefined();
    expect((await repository.list()).map((incident) => incident.id)).toEqual([second.id]);
  });

  test("preserves concurrent recovery updates", async () => {
    const timer = new FakeTimer();
    const repository = new EmulatorLossIncidentRepository(
      timer,
      new CountingIdGenerator("incident"),
      2,
      db,
    );
    const concurrentRepository = new EmulatorLossIncidentRepository(
      timer,
      new CountingIdGenerator("concurrent"),
      2,
      db,
    );
    const incident = await repository.open({
      deviceId: "emulator-5554",
      detectionPath: "watched-process-exit",
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
    });

    await Promise.all([
      repository.recordRecoveryAttempt(incident.id, { attempt: 1, outcome: "failed" }),
      concurrentRepository.completeRecovery(incident.id, "exhausted"),
    ]);

    expect((await repository.get(incident.id))?.recovery).toEqual({
      policy: { onLoss: true, maxAttempts: 2 },
      attempts: [{ attempt: 1, outcome: "failed" }],
      outcome: "exhausted",
    });
  });
});
