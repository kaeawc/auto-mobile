import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { FailureEventRepository } from "../../../../src/db/failureEventRepository";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import type { AndroidSdkEventIngestor } from "../../../../src/features/observe/android/AndroidSdkEventIngestor";
import type {
  SdkAnrPayload,
  SdkCrashPayload,
} from "../../../../src/features/observe/crash/sdkCrashIngestion";
import { createTestDatabase } from "../../../db/testDbHelper";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Byte-for-byte expected encodings from WebSocketResponseTest.kt.
const CRASH_FRAME =
  '{"type":"crash_event","timestamp":1700000000000,"event":{"exceptionClass":"java.lang.NullPointerException","message":null,"stackTrace":"at com.example.Main.run(Main.java:42)","threadName":"main","currentScreen":null,"packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34},"applicationId":null}}';
const ANR_FRAME =
  '{"type":"anr_event","timestamp":1700000000500,"event":{"pid":12345,"processName":"com.example.app","importance":"FOREGROUND","trace":null,"reason":"Input dispatching timed out","packageName":"com.example.app","appVersion":null,"deviceInfo":{"model":"Pixel 7","manufacturer":"Google","osVersion":"14","sdkInt":34}}}';

class FakeCrashIngestor implements AndroidSdkEventIngestor {
  readonly crashes: SdkCrashPayload[] = [];
  readonly anrs: Array<{ event: SdkAnrPayload; packageName: string }> = [];

  async recordSdkEvent(): Promise<void> {}
  recordStorageEvent(): void {}
  async recordHandledException(): Promise<void> {}
  async recordCrashAnalytics(event: SdkCrashPayload): Promise<void> {
    this.crashes.push(event);
  }
  async recordAnrAnalytics(event: SdkAnrPayload, packageName: string): Promise<void> {
    this.anrs.push({ event, packageName });
  }
}

describe("Android CtrlProxy crash/ANR wire persistence", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let timer: FakeTimer;
  let ingestor: FakeCrashIngestor;
  let client: AndroidCtrlProxyClient;

  beforeAll(async () => {
    // Warm the migrated in-memory template outside the per-test timing budget.
    const template = await createTestDatabase();
    await template.destroy();
  });

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.advanceTime(1700000001000);
    ingestor = new FakeCrashIngestor();
    client = AndroidCtrlProxyClient.createForTesting(
      { deviceId: "crash-wire-device", platform: "android", name: "Crash Wire Device" },
      new FakeAdbExecutor(),
      () => {
        throw new Error("WebSocket connection is not needed for wire dispatch tests");
      },
      timer,
      undefined,
      undefined,
      new FailureEventRepository(timer, db),
      undefined,
      ingestor,
    );
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("persists the Kotlin crash frame using its envelope timestamp", async () => {
    await client["handleWebSocketMessage"](CRASH_FRAME);
    const rows = await db.selectFrom("crashes").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(1700000000000);
    expect(ingestor.crashes).toHaveLength(1);
    expect(ingestor.crashes[0].timestamp).toBe(rows[0].timestamp);
  });

  test("persists an older APK crash without either timestamp using FakeTimer", async () => {
    const frame: { timestamp?: number; event: { timestamp?: number } } = JSON.parse(CRASH_FRAME);
    delete frame.timestamp;
    await client["handleWebSocketMessage"](JSON.stringify(frame));
    const rows = await db.selectFrom("crashes").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(timer.now());
    expect(ingestor.crashes).toHaveLength(1);
    expect(ingestor.crashes[0].timestamp).toBe(timer.now());
  });

  test("persists the Kotlin ANR frame using its envelope timestamp", async () => {
    await client["handleWebSocketMessage"](ANR_FRAME);
    const rows = await db.selectFrom("anrs").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].timestamp).toBe(1700000000500);
    expect(ingestor.anrs).toHaveLength(1);
    expect(ingestor.anrs[0].event.timestamp).toBe(rows[0].timestamp);
    expect(ingestor.anrs[0].packageName).toBe("com.example.app");
  });

  test("persists crash and ANR frames with null-valued event keys omitted", async () => {
    for (const frame of [CRASH_FRAME, ANR_FRAME]) {
      const withoutNulls = JSON.stringify(JSON.parse(frame), (_key, value: unknown) =>
        value === null ? undefined : value,
      );
      await client["handleWebSocketMessage"](withoutNulls);
    }
    const crashes = await db.selectFrom("crashes").select("timestamp").execute();
    const anrs = await db.selectFrom("anrs").select("timestamp").execute();
    expect(crashes).toEqual([{ timestamp: 1700000000000 }]);
    expect(anrs).toEqual([{ timestamp: 1700000000500 }]);
    expect(ingestor.crashes[0].timestamp).toBe(1700000000000);
    expect(ingestor.anrs[0].event.timestamp).toBe(1700000000500);
  });

  test("passes event timestamps to persistence and analytics for both variants", async () => {
    for (const encoded of [CRASH_FRAME, ANR_FRAME]) {
      const frame: { event: { timestamp?: number } } = JSON.parse(encoded);
      frame.event.timestamp = 1700000000750;
      await client["handleWebSocketMessage"](JSON.stringify(frame));
    }
    expect(await db.selectFrom("crashes").select("timestamp").execute()).toEqual([
      { timestamp: 1700000000750 },
    ]);
    expect(await db.selectFrom("anrs").select("timestamp").execute()).toEqual([
      { timestamp: 1700000000750 },
    ]);
    expect(ingestor.crashes[0].timestamp).toBe(1700000000750);
    expect(ingestor.anrs[0].event.timestamp).toBe(1700000000750);
  });

  test("persists an older APK ANR without either timestamp using FakeTimer", async () => {
    const frame: { timestamp?: number } = JSON.parse(ANR_FRAME);
    delete frame.timestamp;
    await client["handleWebSocketMessage"](JSON.stringify(frame));
    expect(await db.selectFrom("anrs").select("timestamp").execute()).toEqual([
      { timestamp: timer.now() },
    ]);
    expect(ingestor.anrs[0].event.timestamp).toBe(timer.now());
  });
});
