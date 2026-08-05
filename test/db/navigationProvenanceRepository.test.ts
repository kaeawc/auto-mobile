import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { NavigationRepository } from "../../src/db/navigationRepository";

/**
 * AC1 coverage for #4984: per-node/edge observation records keyed by
 * (buildKey, deviceId, sessionUuid). Multiple records per node/edge; re-recording
 * the same tuple updates last_seen rather than inserting a duplicate.
 */
describe("NavigationRepository provenance observations", () => {
  let db: Kysely<Database>;
  let repo: NavigationRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new NavigationRepository(db);
    await repo.getOrCreateApp("com.example.app");
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("getOrCreateBuildKey is an atomic upsert on (app_id, version_code, content_hash)", async () => {
    const a = await repo.getOrCreateBuildKey("com.example.app", 42, "hashA");
    const again = await repo.getOrCreateBuildKey("com.example.app", 42, "hashA");
    const different = await repo.getOrCreateBuildKey("com.example.app", 42, "hashB");
    expect(again.id).toBe(a.id);
    expect(different.id).not.toBe(a.id);
  });

  test("multiple node observations per node across builds/devices/sessions", async () => {
    const node = await repo.getOrCreateNode("com.example.app", "Home", 100);
    const buildA = await repo.getOrCreateBuildKey("com.example.app", 1, "hashA");
    const buildB = await repo.getOrCreateBuildKey("com.example.app", 2, "hashB");

    await repo.recordNodeObservation(node.id, buildA.id, "device-1", "session-1", 100);
    await repo.recordNodeObservation(node.id, buildB.id, "device-1", "session-1", 110);
    await repo.recordNodeObservation(node.id, buildA.id, "device-2", "session-1", 120);
    await repo.recordNodeObservation(node.id, buildA.id, "device-1", "session-2", 130);

    const obs = await db
      .selectFrom("navigation_node_observations")
      .selectAll()
      .where("node_id", "=", node.id)
      .execute();
    expect(obs).toHaveLength(4);
  });

  test("re-recording the same node observation tuple updates last_seen (no duplicate)", async () => {
    const node = await repo.getOrCreateNode("com.example.app", "Home", 100);
    const build = await repo.getOrCreateBuildKey("com.example.app", 1, "hashA");

    await repo.recordNodeObservation(node.id, build.id, "device-1", "session-1", 100);
    await repo.recordNodeObservation(node.id, build.id, "device-1", "session-1", 250);

    const obs = await db
      .selectFrom("navigation_node_observations")
      .selectAll()
      .where("node_id", "=", node.id)
      .execute();
    expect(obs).toHaveLength(1);
    expect(obs[0].first_seen_at).toBe(100);
    expect(obs[0].last_seen_at).toBe(250);
  });

  test("out-of-order node observations keep first_seen <= last_seen (MIN/MAX)", async () => {
    const node = await repo.getOrCreateNode("com.example.app", "Home", 100);
    const build = await repo.getOrCreateBuildKey("com.example.app", 1, "hashA");

    // Arrivals out of order: later timestamp first, then an earlier one.
    await repo.recordNodeObservation(node.id, build.id, "device-1", "session-1", 200);
    await repo.recordNodeObservation(node.id, build.id, "device-1", "session-1", 50);
    await repo.recordNodeObservation(node.id, build.id, "device-1", "session-1", 120);

    const obs = await db
      .selectFrom("navigation_node_observations")
      .selectAll()
      .where("node_id", "=", node.id)
      .executeTakeFirstOrThrow();
    expect(obs.first_seen_at).toBe(50);
    expect(obs.last_seen_at).toBe(200);
  });

  test("out-of-order edge observations keep first_seen <= last_seen (MIN/MAX)", async () => {
    const edge = await repo.createEdge("com.example.app", "Home", "Details", "tapOn", null, 150);
    const build = await repo.getOrCreateBuildKey("com.example.app", 1, "hashA");

    await repo.recordEdgeObservation(edge.id, build.id, "device-1", "session-1", 300);
    await repo.recordEdgeObservation(edge.id, build.id, "device-1", "session-1", 100);

    const obs = await db
      .selectFrom("navigation_edge_observations")
      .selectAll()
      .where("edge_id", "=", edge.id)
      .executeTakeFirstOrThrow();
    expect(obs.first_seen_at).toBe(100);
    expect(obs.last_seen_at).toBe(300);
  });

  test("edge observations dedup on (edge, build, device, session)", async () => {
    const edge = await repo.createEdge("com.example.app", "Home", "Details", "tapOn", null, 150);
    const build = await repo.getOrCreateBuildKey("com.example.app", 1, "hashA");

    await repo.recordEdgeObservation(edge.id, build.id, "device-1", "session-1", 150);
    await repo.recordEdgeObservation(edge.id, build.id, "device-1", "session-1", 400);

    const obs = await db
      .selectFrom("navigation_edge_observations")
      .selectAll()
      .where("edge_id", "=", edge.id)
      .execute();
    expect(obs).toHaveLength(1);
    expect(obs[0].first_seen_at).toBe(150);
    expect(obs[0].last_seen_at).toBe(400);
  });
});
