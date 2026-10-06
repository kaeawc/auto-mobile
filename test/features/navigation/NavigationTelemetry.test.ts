import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../db/testDbHelper";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import type { Database } from "../../../src/db/types";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { DefaultIosSdkEventIngestor } from "../../../src/features/observe/ios/IosSdkEventIngestor";
import {
  TelemetryRecorder,
  getNoOpTelemetryRepository,
  type TelemetryRepository,
} from "../../../src/features/telemetry/TelemetryRecorder";
import type { RecordNavigationEventInput } from "../../../src/db/navigationEventRepository";
import { FakeFailureRecorder } from "../../fakes/FakeFailureRecorder";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "com.example.telemetry";
const DEVICE_A = "emulator-5554";
const DEVICE_B = "emulator-5556";
const IOS_DEVICE = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";

/**
 * Navigation telemetry is recorded once per SDK navigation event, stamped with the device the
 * event came from (#10195) — not with whichever device last set the recorder's ambient context.
 */
describe("navigation telemetry device and count (#10195)", () => {
  let db: Kysely<Database>;
  let manager: NavigationGraphManager;
  let records: RecordNavigationEventInput[];

  beforeEach(async () => {
    db = await createTestDatabase();
    manager = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
      new FakeTimer(),
    );
    records = [];
    const repository: TelemetryRepository = {
      ...getNoOpTelemetryRepository(),
      recordNavigationEvent: async (input) => {
        records.push(input);
      },
    };
    TelemetryRecorder.setDefaultRepositoryOverride(repository);
  });

  afterEach(async () => {
    TelemetryRecorder.setDefaultRepositoryOverride(getNoOpTelemetryRepository());
    await db.destroy();
  });

  async function androidNavigation(destination: string, deviceId?: string): Promise<void> {
    await manager.recordNavigationEvent({
      applicationId: APP,
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: 1000,
      sequenceNumber: 0,
      ...(deviceId ? { deviceId } : {}),
    });
  }

  test("an event is stamped with its own device, not the recorder's last context", async () => {
    // Device B's hierarchy update was the last to set the recorder's context.
    TelemetryRecorder.getInstance().setContext(DEVICE_B, "session-b");

    await androidNavigation("Settings", DEVICE_A);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ deviceId: DEVICE_A, destination: "Settings" });
    // The ambient session belongs to device B, so it must not be attached to device A's event.
    expect(records[0].sessionId).toBeNull();
  });

  test("an event from the ambient device keeps the ambient session", async () => {
    TelemetryRecorder.getInstance().setContext(DEVICE_A, "session-a");

    await androidNavigation("Settings", DEVICE_A);

    expect(records[0]).toMatchObject({ deviceId: DEVICE_A, sessionId: "session-a" });
  });

  test("interleaved events from two devices each keep their own device", async () => {
    TelemetryRecorder.getInstance().setContext(DEVICE_B, null);
    await androidNavigation("Home", DEVICE_A);
    TelemetryRecorder.getInstance().setContext(DEVICE_A, null);
    await androidNavigation("Settings", DEVICE_B);

    expect(records.map((record) => [record.destination, record.deviceId])).toEqual([
      ["Home", DEVICE_A],
      ["Settings", DEVICE_B],
    ]);
  });

  test("an event with no device falls back to the recorder's context", async () => {
    TelemetryRecorder.getInstance().setContext(DEVICE_B, null);

    await androidNavigation("Settings");

    expect(records[0].deviceId).toBe(DEVICE_B);
  });

  function iosIngestor(): DefaultIosSdkEventIngestor {
    return new DefaultIosSdkEventIngestor({
      deviceId: IOS_DEVICE,
      timer: new FakeTimer(),
      failureRecorder: new FakeFailureRecorder(),
      getNavigationGraphManager: () => manager,
      captureScreenshot: async () => ({ success: false }),
      navigationScreenshotsEnabled: () => false,
    });
  }

  test("Android records one navigation telemetry event per SDK event", async () => {
    await androidNavigation("Home", DEVICE_A);
    await androidNavigation("Settings", DEVICE_A);

    expect(records.map((record) => record.destination)).toEqual(["Home", "Settings"]);
  });

  test("iOS records one navigation telemetry event per SDK event, stamped with its device", async () => {
    TelemetryRecorder.getInstance().setContext(DEVICE_B, null);

    await iosIngestor().recordSdkEvent(
      { type: "navigation", timestamp: 2000, payload: { destination: "Settings" } },
      APP,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      deviceId: IOS_DEVICE,
      applicationId: APP,
      destination: "Settings",
    });
    // The ingestor restores the ambient context it borrowed.
    expect(TelemetryRecorder.getInstance().getContext().deviceId).toBe(DEVICE_B);
  });

  test("an iOS navigation with no app is still recorded exactly once", async () => {
    await iosIngestor().recordSdkEvent(
      { type: "navigation", timestamp: 2000, payload: { destination: "Settings" } },
      null,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ deviceId: IOS_DEVICE, destination: "Settings" });
  });
});
