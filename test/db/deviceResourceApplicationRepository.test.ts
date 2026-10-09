import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { DeviceResourceApplicationRepository } from "../../src/db/deviceResourceApplicationRepository";
import type { SimulatorResourceIdentity } from "../../src/models/DeviceResourceReconciliation";
import { logger } from "../../src/utils/logger";

const identity: SimulatorResourceIdentity = {
  platform: "ios",
  udid: "12345678-1234-1234-1234-123456789ABC",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};

describe("DeviceResourceApplicationRepository", () => {
  let db: Kysely<Database>;
  let repository: DeviceResourceApplicationRepository;
  beforeEach(async () => {
    db = await createTestDatabase();
    repository = new DeviceResourceApplicationRepository(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("round-trips and upserts a record per incarnation", async () => {
    await repository.put({
      identity,
      resources: { wallpaperRendering: "disabled" },
      profileFingerprint: "a",
      updatedAtMs: 1,
    });
    await repository.put({
      identity,
      resources: { widgets: "disabled" },
      profileFingerprint: "b",
      updatedAtMs: 2,
    });
    expect(await repository.get(identity)).toEqual({
      identity,
      resources: { widgets: "disabled" },
      profileFingerprint: "b",
      updatedAtMs: 2,
    });
    expect(
      await repository.get({
        ...identity,
        runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      }),
    ).toBeNull();
    await repository.delete(identity);
    expect(await repository.get(identity)).toBeNull();
  });

  test("an unreadable record is ignored, never trusted", async () => {
    await repository.put({
      identity,
      resources: { wallpaperRendering: "disabled" },
      profileFingerprint: "a",
      updatedAtMs: 1,
    });
    await db
      .updateTable("device_resource_applications")
      .set({ resources_json: '{"wallpaperRendering":"maybe"}' })
      .execute();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await repository.get(identity)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
