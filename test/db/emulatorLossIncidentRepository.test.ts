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

  test("round-trips adopted output availability and tolerates unknown values", async () => {
    const repository = new EmulatorLossIncidentRepository(
      new FakeTimer(),
      new CountingIdGenerator("incident"),
      50,
      db,
    );
    const incident = await repository.open({
      deviceId: "emulator-5554",
      detectionPath: "device-discovery-miss",
      outputUnavailable: "adopted",
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
    });
    expect((await repository.get(incident.id))?.outputUnavailable).toBe("adopted");
    expect((await repository.list())[0].outputUnavailable).toBe("adopted");
    for (const value of ["future-value", undefined]) {
      await db
        .updateTable("emulator_loss_incidents")
        .set({
          incident_json: JSON.stringify({ ...incident, outputUnavailable: value }),
        })
        .where("incident_id", "=", incident.id)
        .execute();
      expect((await repository.get(incident.id))?.outputUnavailable).toBeUndefined();
    }
  });
});
