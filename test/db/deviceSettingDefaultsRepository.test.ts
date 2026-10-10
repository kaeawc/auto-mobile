import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { DeviceSettingDefaultsRepository } from "../../src/db/deviceSettingDefaultsRepository";
import { logger } from "../../src/utils/logger";

describe("DeviceSettingDefaultsRepository (#11145)", () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("round-trips, upserts and deletes the per-device record across instances", async () => {
    await new DeviceSettingDefaultsRepository(db).put("emulator-5554", {
      platform: "android",
      name: "Pixel",
      sessionId: "a",
      values: { fontScale: "default", density: 480, timeFormat: null },
    });
    await new DeviceSettingDefaultsRepository(db).put("emulator-5554", {
      platform: "android",
      name: "Pixel",
      sessionId: "b",
      values: { nightMode: "light" },
    });
    const reopened = new DeviceSettingDefaultsRepository(db);
    expect(await reopened.get("emulator-5554")).toEqual({
      platform: "android",
      name: "Pixel",
      sessionId: "b",
      values: { nightMode: "light" },
    });
    expect(await reopened.get("emulator-5556")).toBeNull();
    await reopened.delete("emulator-5554");
    expect(await reopened.get("emulator-5554")).toBeNull();
  });

  test("an unreadable row is ignored with a warning", async () => {
    await sql`insert into device_configs (device_id, platform, config_json) values ('x', 'ios', '{}')`.execute(
      db,
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await new DeviceSettingDefaultsRepository(db).get("x")).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
