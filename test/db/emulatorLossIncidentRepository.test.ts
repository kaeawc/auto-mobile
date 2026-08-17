import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { EmulatorLossIncidentRepository } from "../../src/db/emulatorLossIncidentRepository";
import { up as emulatorLossIncidentsUp } from "../../src/db/migrations/2026_08_17_000_emulator_loss_incidents";
import type { Database } from "../../src/db/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

describe("EmulatorLossIncidentRepository", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await emulatorLossIncidentsUp(db as unknown as Kysely<unknown>);
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
});
