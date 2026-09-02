import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import {
  normalizeStorageEvent,
  normalizeValueType,
  recordStorageEvent,
  getStorageEvents,
  type RecordStorageEventInput,
} from "../../src/db/storageEventRepository";

const base: Omit<RecordStorageEventInput, "valueType" | "changeType"> = {
  deviceId: "d1",
  timestamp: 1000,
  applicationId: "com.example",
  sessionId: null,
  fileName: "prefs.xml",
  key: "theme",
  value: "dark",
};

describe("normalizeValueType (#3173)", () => {
  test("lower-cases platform casing so STRING and string collapse", () => {
    expect(normalizeValueType("STRING")).toBe("string");
    expect(normalizeValueType("string")).toBe("string");
    expect(normalizeValueType("Boolean")).toBe("boolean");
  });

  test("absent / blank / null all canonicalize to unknown (no NULL split)", () => {
    expect(normalizeValueType(null)).toBe("unknown");
    expect(normalizeValueType(undefined)).toBe("unknown");
    expect(normalizeValueType("")).toBe("unknown");
    expect(normalizeValueType("   ")).toBe("unknown");
    expect(normalizeValueType("unknown")).toBe("unknown");
    expect(normalizeValueType("UNKNOWN")).toBe("unknown");
  });
});

describe("normalizeStorageEvent (#3173)", () => {
  test("defaults changeType to modify and canonicalizes valueType", () => {
    const out = normalizeStorageEvent({ ...base, valueType: "STRING", changeType: undefined });
    expect(out.changeType).toBe("modify");
    expect(out.valueType).toBe("string");
  });

  test("preserves an explicit changeType", () => {
    const out = normalizeStorageEvent({ ...base, valueType: "INT", changeType: "add" });
    expect(out.changeType).toBe("add");
    expect(out.valueType).toBe("int");
  });

  test("blank changeType falls back to modify", () => {
    const out = normalizeStorageEvent({ ...base, valueType: null, changeType: "  " });
    expect(out.changeType).toBe("modify");
    expect(out.valueType).toBe("unknown");
  });
});

describe("recordStorageEvent persists canonical value_type (#3173)", () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("Android STRING and iOS string persist the same token", async () => {
    await recordStorageEvent(
      {
        ...base,
        deviceId: "android",
        valueType: "STRING",
        changeType: "modify",
      },
      db,
    );
    await recordStorageEvent(
      {
        ...base,
        deviceId: "ios",
        valueType: "string",
        changeType: "modify",
      },
      db,
    );

    const android = await getStorageEvents({ deviceId: "android", limit: 1 }, db);
    const ios = await getStorageEvents({ deviceId: "ios", limit: 1 }, db);
    expect(android[0].valueType).toBe("string");
    expect(ios[0].valueType).toBe("string");
    expect(android[0].valueType).toBe(ios[0].valueType);
  });

  test("null valueType lands as canonical unknown, not NULL", async () => {
    await recordStorageEvent(
      {
        ...base,
        deviceId: "d2",
        value: null,
        valueType: null,
        changeType: "modify",
      },
      db,
    );
    const rows = await getStorageEvents({ deviceId: "d2", limit: 1 }, db);
    expect(rows[0].valueType).toBe("unknown");
  });
});
