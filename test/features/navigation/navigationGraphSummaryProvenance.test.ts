import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

/**
 * AC1 (#4985): exportGraphSummaryForApp returns the app-level union with per-node
 * and per-edge provenance (build / device / session / lastSeen). Additive — the
 * legacy shape (id / screenName / visitCount / from / to / toolName / counts) is
 * unchanged.
 */
describe("exportGraphSummaryForApp provenance (#4985)", () => {
  let harness: InMemoryNavManagerHarness;
  let seedRepo: NavigationRepository;
  const APP = "com.example.app";

  beforeEach(async () => {
    harness = await installInMemoryNavManager();
    // Seed via a repository sharing the harness's single connection.
    seedRepo = new NavigationRepository(harness.db);
    await seedRepo.getOrCreateApp(APP);
  });

  afterEach(async () => {
    await harness.dispose();
  });

  test("attaches per-node provenance records", async () => {
    const home = await seedRepo.getOrCreateNode(APP, "Home", 100);
    const buildA = await seedRepo.getOrCreateBuildKey(APP, 1, "hashA");
    const buildB = await seedRepo.getOrCreateBuildKey(APP, 2, "hashB");
    await seedRepo.recordNodeObservation(home.id, buildA.id, "device-1", "session-1", 100);
    await seedRepo.recordNodeObservation(home.id, buildB.id, "device-2", "session-2", 200);

    const summary = await harness.manager.exportGraphSummaryForApp(APP);
    const node = summary.nodes.find(n => n.screenName === "Home");
    expect(node).toBeDefined();
    expect(node!.provenance).toHaveLength(2);
    // Recency-first ordering.
    expect(node!.provenance![0].lastSeen).toBe(200);
    expect(node!.provenance![0].buildKey).toEqual({
      packageId: APP,
      versionCode: 2,
      contentHash: "hashB",
    });
    expect(node!.provenance![0].deviceId).toBe("device-2");
    expect(node!.provenance![0].sessionUuid).toBe("session-2");
  });

  test("legacy summary fields are preserved (backward compatible)", async () => {
    const home = await seedRepo.getOrCreateNode(APP, "Home", 100);
    const buildA = await seedRepo.getOrCreateBuildKey(APP, 1, "hashA");
    await seedRepo.recordNodeObservation(home.id, buildA.id, "device-1", "session-1", 100);

    const summary = await harness.manager.exportGraphSummaryForApp(APP);
    const node = summary.nodes.find(n => n.screenName === "Home")!;
    expect(node.id).toBe(home.id);
    expect(node.screenName).toBe("Home");
    expect(node.visitCount).toBe(1);
  });

  test("a node with no observations gets an empty provenance array", async () => {
    await seedRepo.getOrCreateNode(APP, "Home", 100);
    const summary = await harness.manager.exportGraphSummaryForApp(APP);
    const node = summary.nodes.find(n => n.screenName === "Home")!;
    expect(node.provenance).toEqual([]);
  });

  test("edge provenance is unioned and deduped across aggregated edge rows", async () => {
    // Two distinct edge rows for the SAME transition aggregate into one summary edge.
    const edge1 = await seedRepo.createEdge(APP, "Home", "Details", "tapOn", null, 150);
    const edge2 = await seedRepo.createEdge(APP, "Home", "Details", "tapOn", null, 160);
    const buildA = await seedRepo.getOrCreateBuildKey(APP, 1, "hashA");
    const buildB = await seedRepo.getOrCreateBuildKey(APP, 2, "hashB");
    // Same (build, device, session) on both edge rows → deduped to one record.
    await seedRepo.recordEdgeObservation(edge1.id, buildA.id, "device-1", "session-1", 150);
    await seedRepo.recordEdgeObservation(edge2.id, buildA.id, "device-1", "session-1", 400);
    // A different build on edge2 → a second distinct record.
    await seedRepo.recordEdgeObservation(edge2.id, buildB.id, "device-1", "session-1", 500);

    const summary = await harness.manager.exportGraphSummaryForApp(APP);
    const edges = summary.edges.filter(e => e.from === "Home" && e.to === "Details");
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge.traversalCount).toBe(2);
    expect(edge.provenance).toHaveLength(2);
    // Deduped record keeps the max lastSeen (400 > 150) and sorts first (500 newest).
    expect(edge.provenance![0].lastSeen).toBe(500);
    expect(edge.provenance![0].buildKey.versionCode).toBe(2);
    expect(edge.provenance![1].lastSeen).toBe(400);
    expect(edge.provenance![1].buildKey.versionCode).toBe(1);
  });

  test("empty appId returns empty summary with no provenance", async () => {
    const summary = await harness.manager.exportGraphSummaryForApp(null);
    expect(summary.nodes).toEqual([]);
    expect(summary.edges).toEqual([]);
  });
});
