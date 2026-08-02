import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../db/testDbHelper";
import type { Database } from "../../../src/db/types";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { TelemetryRecorder } from "../../../src/features/telemetry/TelemetryRecorder";
import type { NavigationEvent } from "../../../src/utils/interfaces/NavigationGraph";

/**
 * AC3 coverage for #4984: every graph mutation records provenance
 * (buildKey + deviceId + sessionUuid + seenAt) in the SAME transaction as the
 * mutation, and the #4931 fold-in touches navigation_apps.updated_at on
 * promoteSuggestion / recordBackStack / updateNodeScreenshot.
 */
const APP = "com.example.app";
const SESSION = "session-xyz";

function navEvent(destination: string, timestamp: number): NavigationEvent {
  return {
    destination,
    source: "prev",
    arguments: {},
    metadata: {},
    timestamp,
    sequenceNumber: timestamp,
    applicationId: APP,
  };
}

describe("NavigationGraphManager provenance write path", () => {
  let db: Kysely<Database>;
  let manager: NavigationGraphManager;
  let telemetrySpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = await createTestDatabase();
    const navRepo = new NavigationRepository(db);
    const coverageRepo = new TestCoverageRepository(undefined, db);
    manager = NavigationGraphManager.createForTesting(navRepo, coverageRepo, undefined, SESSION);
    NavigationGraphManager.setInstanceForTesting(manager);
    TelemetryRecorder.resetInstance();
    telemetrySpy = spyOn(TelemetryRecorder.getInstance(), "recordNavigationEvent").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    telemetrySpy.mockRestore();
    TelemetryRecorder.resetInstance();
    NavigationGraphManager.resetInstance();
    await db.destroy();
  });

  async function ageUpdatedAt(): Promise<string> {
    const old = "2000-01-01T00:00:00.000Z";
    await db.updateTable("navigation_apps").set({ updated_at: old }).where("app_id", "=", APP).execute();
    return old;
  }

  async function updatedAt(): Promise<string> {
    const row = await db.selectFrom("navigation_apps").select("updated_at").where("app_id", "=", APP).executeTakeFirstOrThrow();
    return row.updated_at;
  }

  test("records node + edge observations under the current build key/device/session", async () => {
    await manager.setCurrentApp(APP);
    manager.setBuildContext({ deviceId: "emu-1", versionCode: 7, contentHash: "hashA" });

    await manager.recordNavigationEvent(navEvent("Home", 100));
    await manager.recordNavigationEvent(navEvent("Details", 200));

    const buildKeys = await db.selectFrom("navigation_build_keys").selectAll().execute();
    expect(buildKeys).toHaveLength(1);
    expect(buildKeys[0].version_code).toBe(7);
    expect(buildKeys[0].content_hash).toBe("hashA");

    const nodeObs = await db.selectFrom("navigation_node_observations").selectAll().execute();
    expect(nodeObs.length).toBeGreaterThanOrEqual(2);
    for (const o of nodeObs) {
      expect(o.build_key_id).toBe(buildKeys[0].id);
      expect(o.device_id).toBe("emu-1");
      expect(o.session_uuid).toBe(SESSION);
    }

    const edgeObs = await db.selectFrom("navigation_edge_observations").selectAll().execute();
    expect(edgeObs).toHaveLength(1);
    expect(edgeObs[0].device_id).toBe("emu-1");
    expect(edgeObs[0].session_uuid).toBe(SESSION);
  });

  test("falls back to the default build key when no build context is set", async () => {
    await manager.setCurrentApp(APP);
    await manager.recordNavigationEvent(navEvent("Home", 100));

    const buildKeys = await db.selectFrom("navigation_build_keys").selectAll().execute();
    expect(buildKeys).toHaveLength(1);
    expect(buildKeys[0].version_code).toBe(0);
    expect(buildKeys[0].content_hash).toBe("");

    const nodeObs = await db.selectFrom("navigation_node_observations").selectAll().execute();
    expect(nodeObs.length).toBeGreaterThanOrEqual(1);
    expect(nodeObs[0].device_id).toBe("legacy");
  });

  test("#4931: recordBackStack touches navigation_apps.updated_at", async () => {
    await manager.setCurrentApp(APP);
    await manager.recordNavigationEvent(navEvent("Home", 100)); // sets currentScreen
    const old = await ageUpdatedAt();
    await manager.recordBackStack({ depth: 1, currentTaskId: 1 });
    expect(await updatedAt()).not.toBe(old);
  });

  test("#4931: updateNodeScreenshot touches updated_at but records NO reach observation", async () => {
    await manager.setCurrentApp(APP);
    await manager.recordNavigationEvent(navEvent("Home", 100));
    const before = await db.selectFrom("navigation_node_observations").selectAll().execute();
    const old = await ageUpdatedAt();

    await manager.updateNodeScreenshot(APP, "Home", "/tmp/home.png");

    expect(await updatedAt()).not.toBe(old);
    const after = await db.selectFrom("navigation_node_observations").selectAll().execute();
    expect(after).toHaveLength(before.length);
  });

  test("#4931: promoteSuggestion touches updated_at", async () => {
    await manager.setCurrentApp(APP);
    const repo = new NavigationRepository(db);
    const suggestion = await repo.addOrUpdateSuggestion(APP, "fp-hash", "{}", 100);
    const old = await ageUpdatedAt();

    await manager.promoteSuggestion(suggestion.id, "Home");

    expect(await updatedAt()).not.toBe(old);
  });
});
