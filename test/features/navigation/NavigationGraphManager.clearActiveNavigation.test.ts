import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../db/testDbHelper";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { TelemetryRecorder } from "../../../src/features/telemetry/TelemetryRecorder";
import type { Database } from "../../../src/db/types";

const APP_ID = "com.example.clear";

/**
 * clearCurrentGraph deletes every node of the app, so the SDK-correlation window
 * state (`activeNavigation`, which holds a node id) must not survive it: a
 * hierarchy fingerprint arriving inside the 1 s window would otherwise be
 * written against a node row that no longer exists.
 */
describe("NavigationGraphManager.clearCurrentGraph active navigation", () => {
  let db: Kysely<Database>;
  let manager: NavigationGraphManager;
  let telemetrySpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    // foreignKeys: true matches the production connection (database.ts), so a
    // dangling node_id is rejected instead of silently stored.
    db = await createTestDatabase({ foreignKeys: true });
    manager = NavigationGraphManager.createForTesting(
      new NavigationRepository(db),
      new TestCoverageRepository(undefined, db),
    );
    TelemetryRecorder.resetInstance();
    telemetrySpy = spyOn(
      TelemetryRecorder.getInstance(),
      "recordNavigationEvent",
    ).mockResolvedValue(undefined);
    await manager.setCurrentApp(APP_ID);
    await manager.recordNavigationEvent({
      destination: "Home",
      source: "",
      arguments: {},
      metadata: {},
      timestamp: 1000,
      sequenceNumber: 1,
      applicationId: APP_ID,
    });
  });

  afterEach(async () => {
    telemetrySpy.mockRestore();
    TelemetryRecorder.resetInstance();
    await db.destroy();
  });

  async function fingerprintRows(): Promise<number> {
    const rows = await db.selectFrom("navigation_node_fingerprints").selectAll().execute();
    return rows.length;
  }

  test("a fingerprint inside the window after clearing is not attached to the deleted node", async () => {
    await manager.clearCurrentGraph();
    expect(await manager.getKnownScreens()).toEqual([]);

    // 500 ms after the Home event: inside ACTIVE_NAVIGATION_WINDOW_MS.
    await manager.recordHierarchyNavigation({
      fromFingerprint: null,
      toFingerprint: "fp-after-clear",
      timestamp: 1500,
      packageName: APP_ID,
    });

    expect(await fingerprintRows()).toBe(0);
  });

  test("control: without clearing, the same fingerprint correlates to the live node", async () => {
    await manager.recordHierarchyNavigation({
      fromFingerprint: null,
      toFingerprint: "fp-live",
      timestamp: 1500,
      packageName: APP_ID,
    });

    expect(await fingerprintRows()).toBe(1);
  });
});
