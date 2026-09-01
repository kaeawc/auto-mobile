import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../../../src/db/types";
import { createTestDatabase } from "../../../db/testDbHelper";
import { recordStorageEvent, getStorageEvents } from "../../../../src/db/storageEventRepository";
import { storageTelemetryInputFromWire } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";

/**
 * End-to-end guard for the Android `storage_changed` path (#3000): a realistic wire
 * payload — shaped exactly as the runner's `buildStorageChangedMessage`
 * (StorageChangeWireEncoder.kt) emits it — is parsed, mapped by
 * `storageTelemetryInputFromWire`, and persisted via `recordStorageEvent`. This pins
 * the cross-language field contract: if the Kotlin encoder key drifted from
 * `WsStorageChangedMessage.previousValue`, the parsed object would lack the field and
 * the runner-supplied value would NOT win over the competing prior row below.
 */
describe("Android storage_changed wire → ingest → DB (#3000)", () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  // Mirrors the exact JSON the runner emits for a STRING modify (see
  // StorageChangeWireEncoder.kt): note `previousValue` quoted, `eventTimestamp`
  // separate from the envelope `timestamp`.
  const modifyWire = JSON.stringify({
    type: "storage_changed",
    timestamp: 999,
    packageName: "com.example",
    fileName: "prefs.xml",
    key: "theme",
    value: "dark",
    valueType: "STRING",
    previousValue: "light",
    eventTimestamp: 2000,
    sequenceNumber: 3,
  });

  test("runner-supplied previousValue is stored verbatim, beating a competing prior row", async () => {
    // A stale telemetry row the auto-lookup WOULD have found.
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "STALE",
        valueType: "STRING",
        changeType: "add",
      },
      db,
    );

    const message = JSON.parse(modifyWire);
    const input = storageTelemetryInputFromWire(
      message,
      message.eventTimestamp ?? message.timestamp,
    );
    // The ingest sets device context on the recorder; here we record directly with a deviceId.
    await recordStorageEvent({ deviceId: "d1", sessionId: null, ...input }, db);

    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    expect(events[0].value).toBe("dark");
    // Runner value wins over the "STALE" the auto-lookup would have found → proves the
    // wire field reached the DB and the lookup was skipped.
    expect(events[0].previousValue).toBe("light");
  });

  test("removed STRING key: prior value survives the wire as valid JSON and is stored", async () => {
    // On a remove the runner emits value:null, valueType:UNKNOWN, but previousValue is
    // still the (quoted) prior STRING — the regression the wire encoder guards.
    const removeWire = JSON.stringify({
      type: "storage_changed",
      timestamp: 999,
      packageName: "com.example",
      fileName: "prefs.xml",
      key: "token",
      value: null,
      valueType: "UNKNOWN",
      previousValue: "secret",
      eventTimestamp: 2100,
      sequenceNumber: 4,
    });

    const message = JSON.parse(removeWire);
    const input = storageTelemetryInputFromWire(
      message,
      message.eventTimestamp ?? message.timestamp,
    );
    await recordStorageEvent({ deviceId: "d1", sessionId: null, ...input }, db);

    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    expect(events[0].value).toBeNull();
    expect(events[0].previousValue).toBe("secret");
  });

  test("legacy runner (no previousValue field) falls through to the DB auto-lookup", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "from-lookup",
        valueType: "STRING",
        changeType: "add",
      },
      db,
    );

    // No previousValue key at all — the pre-#3000 wire shape.
    const legacyWire = JSON.stringify({
      type: "storage_changed",
      timestamp: 999,
      packageName: "com.example",
      fileName: "prefs.xml",
      key: "theme",
      value: "new",
      valueType: "STRING",
      eventTimestamp: 3000,
      sequenceNumber: 5,
    });
    const message = JSON.parse(legacyWire);
    const input = storageTelemetryInputFromWire(
      message,
      message.eventTimestamp ?? message.timestamp,
    );
    // Field must be absent so the repository performs the auto-lookup.
    expect("previousValue" in input).toBe(false);
    await recordStorageEvent({ deviceId: "d1", sessionId: null, ...input }, db);

    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    expect(events[0].previousValue).toBe("from-lookup");
  });
});
