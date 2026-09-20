import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { ProvisionedDeviceTransportTombstoneRepository } from "../../src/db/provisionedDeviceTransportTombstoneRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

describe("ProvisionedDeviceTransportTombstoneRepository", () => {
  let database: Kysely<Database>;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  test("persists and updates retired serial identity across repository instances", async () => {
    const repository = new ProvisionedDeviceTransportTombstoneRepository(database);
    await repository.retire(
      {
        deviceId: "emulator-5554",
        stableId: "phone-api-36-a",
        reason: "timeout",
      },
      1_000,
    );

    expect(
      await new ProvisionedDeviceTransportTombstoneRepository(database).get("emulator-5554"),
    ).toEqual({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-a",
      reason: "timeout",
    });

    await repository.retire(
      {
        deviceId: "emulator-5554",
        stableId: "phone-api-36-b",
        reason: "cleanup_failed",
      },
      2_000,
    );
    expect(await repository.get("emulator-5554")).toEqual({
      deviceId: "emulator-5554",
      stableId: "phone-api-36-b",
      reason: "cleanup_failed",
    });
  });
});
