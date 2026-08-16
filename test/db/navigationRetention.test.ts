import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { NavigationRepository } from "../../src/db/navigationRepository";
import {
  NavigationRetention,
  resolveNavigationRetentionConfig,
  computeProtectedBuildKeyIds,
  DEFAULT_SCREENSHOT_TTL_MS,
  DEFAULT_STRUCTURE_TTL_MS,
  DEFAULT_PER_APP_MAX_OBSERVATIONS,
  DEFAULT_GLOBAL_MAX_OBSERVATIONS,
} from "../../src/db/navigationRetention";

const APP = "com.example.app";
const APP2 = "com.example.other";

// Small TTLs so an explicit `now` (the injected fake clock) crosses them without
// any real waiting. Caps default huge unless a test overrides them.
const CONFIG = {
  screenshotTtlMs: 1_000,
  structureTtlMs: 5_000,
  perAppMaxObservations: 1_000,
  globalMaxObservations: 10_000,
};

describe("navigationRetention config", () => {
  const ENV_KEYS = [
    "AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS",
    "AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS",
    "AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS",
    "AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS",
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  test("falls back to conservative defaults", () => {
    const config = resolveNavigationRetentionConfig();
    expect(config.screenshotTtlMs).toBe(DEFAULT_SCREENSHOT_TTL_MS);
    expect(config.structureTtlMs).toBe(DEFAULT_STRUCTURE_TTL_MS);
    expect(config.perAppMaxObservations).toBe(DEFAULT_PER_APP_MAX_OBSERVATIONS);
    expect(config.globalMaxObservations).toBe(DEFAULT_GLOBAL_MAX_OBSERVATIONS);
    // Defaults are the intended conservative policy (weeks/months, generous caps).
    expect(config.screenshotTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(config.structureTtlMs).toBe(90 * 24 * 60 * 60 * 1000);
  });

  test("env overrides defaults; explicit overrides win over env", () => {
    process.env.AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS = "42";
    expect(resolveNavigationRetentionConfig().structureTtlMs).toBe(42);
    expect(resolveNavigationRetentionConfig({ structureTtlMs: 7 }).structureTtlMs).toBe(7);
  });

  test("rejects non-positive / non-numeric env values", () => {
    process.env.AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS = "-5";
    expect(resolveNavigationRetentionConfig().perAppMaxObservations).toBe(
      DEFAULT_PER_APP_MAX_OBSERVATIONS
    );
    process.env.AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS = "abc";
    expect(resolveNavigationRetentionConfig().perAppMaxObservations).toBe(
      DEFAULT_PER_APP_MAX_OBSERVATIONS
    );
  });
});

describe("NavigationRetention prune", () => {
  let db: Kysely<Database>;
  let repo: NavigationRepository;
  let removed: string[];

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
    repo = new NavigationRepository(db);
    removed = [];
  });
  afterEach(async () => {
    await db.destroy();
  });

  function retention(config = CONFIG): NavigationRetention {
    return new NavigationRetention(db, config, async filePath => {
      removed.push(filePath);
    });
  }

  async function seedNode(screen: string, timestamp: number): Promise<number> {
    await repo.getOrCreateApp(APP);
    const node = await repo.getOrCreateNode(APP, screen, timestamp);
    return node.id;
  }

  async function buildKey(app: string, versionCode: number): Promise<number> {
    await repo.getOrCreateApp(app);
    const bk = await repo.getOrCreateBuildKey(app, versionCode, `hash-${versionCode}`);
    return bk.id;
  }

  async function nodeObs(
    nodeId: number,
    buildKeyId: number,
    session: string,
    seenAt: number
  ): Promise<void> {
    await repo.recordNodeObservation(nodeId, buildKeyId, "device-1", session, seenAt);
  }

  async function countNodeObs(): Promise<number> {
    const row = await db
      .selectFrom("navigation_node_observations")
      .select(eb => eb.fn.countAll<number>().as("c"))
      .executeTakeFirst();
    return Number(row?.c ?? 0);
  }

  // ---- Active-context protection (AC3) ----

  test("never prunes the most-recent build even when all data is past TTL", async () => {
    const nodeId = await seedNode("Home", 100);
    const bkOld = await buildKey(APP, 1);
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkOld, "s-old", 100);
    await nodeObs(nodeId, bkNew, "s-new", 200); // newest -> protected

    // now far beyond structureTtlMs for BOTH observations.
    const summary = await retention().prune(1_000_000);

    // Old build's observation pruned; protected (newest) build's kept.
    expect(summary.nodeObservationsDeleted).toBe(1);
    const remaining = await db
      .selectFrom("navigation_node_observations")
      .innerJoin("navigation_build_keys as bk", "bk.id", "navigation_node_observations.build_key_id")
      .select("bk.version_code as v")
      .execute();
    expect(remaining.map(r => r.v)).toEqual([2]);
  });

  test("computeProtectedBuildKeyIds picks the newest-seen build per app", async () => {
    const nodeId = await seedNode("Home", 100);
    const bk1 = await buildKey(APP, 1);
    const bk2 = await buildKey(APP, 2);
    await nodeObs(nodeId, bk1, "s1", 500);
    await nodeObs(nodeId, bk2, "s2", 100); // older last_seen despite higher version
    const protectedIds = await computeProtectedBuildKeyIds(db);
    expect(protectedIds).toEqual([bk1]); // argmax by last_seen, not version
  });

  // ---- SHORT tier: screenshots ----

  test("clears stale screenshot pointer and unlinks the file", async () => {
    const nodeId = await seedNode("Home", 100);
    await repo.updateNodeScreenshotById(nodeId, "/tmp/shot-home.webp");

    const summary = await retention().prune(10_000); // node.last_seen 100 < 10000-1000

    expect(summary.screenshotsCleared).toBe(1);
    expect(removed).toEqual(["/tmp/shot-home.webp"]);
    const node = await repo.getNodeById(APP, nodeId);
    expect(node?.screenshot_path).toBeNull();
    // The light node row itself survives.
    expect(node).toBeDefined();
  });

  test("keeps screenshot for a node in the active (protected) build", async () => {
    const nodeId = await seedNode("Home", 100);
    await repo.updateNodeScreenshotById(nodeId, "/tmp/shot-home.webp");
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkNew, "s-new", 100); // node belongs to the only/protected build

    const summary = await retention().prune(10_000);

    expect(summary.screenshotsCleared).toBe(0);
    expect(removed).toEqual([]);
    const node = await repo.getNodeById(APP, nodeId);
    expect(node?.screenshot_path).toBe("/tmp/shot-home.webp");
  });

  test("keeps a recent screenshot (within short TTL)", async () => {
    const nodeId = await seedNode("Home", 9_500);
    await repo.updateNodeScreenshotById(nodeId, "/tmp/shot-home.webp");
    const summary = await retention().prune(10_000); // 9500 >= 10000-1000
    expect(summary.screenshotsCleared).toBe(0);
    const node = await repo.getNodeById(APP, nodeId);
    expect(node?.screenshot_path).toBe("/tmp/shot-home.webp");
  });

  // ---- LONG tier: observation TTL ----

  test("prunes old node + edge observations, keeps recent ones", async () => {
    const nodeId = await seedNode("Home", 100);
    const edge = await repo.createEdge(APP, "Home", "Detail", "tapOn", null, 100);
    const bkOld = await buildKey(APP, 1);
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkOld, "s-old", 100);
    await nodeObs(nodeId, bkNew, "s-new", 100_000); // newest -> protected
    await repo.recordEdgeObservation(edge.id, bkOld, "device-1", "s-old", 100);
    await repo.recordEdgeObservation(edge.id, bkNew, "device-1", "s-new", 100_000);

    const summary = await retention().prune(50_000); // cutoff 45000

    expect(summary.nodeObservationsDeleted).toBe(1);
    expect(summary.edgeObservationsDeleted).toBe(1);
    const nodeCount = await countNodeObs();
    const edgeCount = await db
      .selectFrom("navigation_edge_observations")
      .select(eb => eb.fn.countAll<number>().as("c"))
      .executeTakeFirst();
    expect(nodeCount).toBe(1);
    expect(Number(edgeCount?.c)).toBe(1);
  });

  // ---- LRU size cap (backstop) ----

  test("per-app LRU cap evicts oldest evictable observations by last_seen", async () => {
    const nodeId = await seedNode("Home", 1);
    const bkOld = await buildKey(APP, 1);
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkNew, "protected", 10_000); // protected
    // 5 evictable observations, recent (within TTL) so only the cap can evict them.
    for (let i = 0; i < 5; i++) {
      await nodeObs(nodeId, bkOld, `s${i}`, 1_000 + i);
    }

    // structureTtl huge so only the cap can evict (isolates the LRU backstop).
    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 2,
    }).prune(11_000);

    // 5 evictable - cap 2 = 3 oldest evicted; protected untouched.
    expect(summary.nodeObservationsDeleted).toBe(3);
    const remaining = await db
      .selectFrom("navigation_node_observations")
      .select(["session_uuid", "last_seen_at"])
      .orderBy("last_seen_at", "asc")
      .execute();
    const sessions = remaining.map(r => r.session_uuid).sort();
    expect(sessions).toEqual(["protected", "s3", "s4"]); // oldest s0,s1,s2 gone
  });

  test("global LRU cap evicts oldest across apps, sparing protected builds", async () => {
    // App 1
    const n1 = await seedNode("A", 1);
    const bk1old = await buildKey(APP, 1);
    const bk1new = await buildKey(APP, 2);
    await nodeObs(n1, bk1new, "p1", 9_000);
    await nodeObs(n1, bk1old, "a-100", 100);
    await nodeObs(n1, bk1old, "a-300", 300);
    // App 2
    await repo.getOrCreateApp(APP2);
    const n2 = await repo.getOrCreateNode(APP2, "B", 1);
    const bk2old = await buildKey(APP2, 1);
    const bk2new = await buildKey(APP2, 2);
    await repo.recordNodeObservation(n2.id, bk2new, "d", "p2", 9_500);
    await repo.recordNodeObservation(n2.id, bk2old, "d", "b-200", 200);

    // 3 evictable rows total (a-100, a-300, b-200); global cap 2 -> evict 1 oldest (a-100).
    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000, // isolate the global cap from the TTL tier
      perAppMaxObservations: 1_000,
      globalMaxObservations: 2,
    }).prune(10_000);

    expect(summary.nodeObservationsDeleted).toBe(1);
    const rows = await db
      .selectFrom("navigation_node_observations")
      .select("session_uuid")
      .execute();
    const sessions = rows.map(r => r.session_uuid).sort();
    expect(sessions).toEqual(["a-300", "b-200", "p1", "p2"]);
  });

  // ---- FK-safe orphan build-key cleanup + idempotency ----

  test("sweeps orphaned build keys after pruning observations (FK-safe), keeps protected", async () => {
    const nodeId = await seedNode("Home", 100);
    const bkOld = await buildKey(APP, 1);
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkOld, "s-old", 100);
    await nodeObs(nodeId, bkNew, "s-new", 100_000);

    const summary = await retention().prune(1_000_000);

    // bkOld's only observation pruned -> bkOld orphaned and swept; bkNew protected.
    expect(summary.buildKeysDeleted).toBe(1);
    const keys = await db.selectFrom("navigation_build_keys").select("id").execute();
    expect(keys.map(k => k.id)).toEqual([bkNew]);
  });

  test("is idempotent: a second pass at the same clock deletes nothing", async () => {
    const nodeId = await seedNode("Home", 100);
    const bkOld = await buildKey(APP, 1);
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkOld, "s-old", 100);
    await nodeObs(nodeId, bkNew, "s-new", 100_000);
    await repo.updateNodeScreenshotById(nodeId, "/tmp/x.webp");

    const first = await retention().prune(1_000_000);
    expect(first.nodeObservationsDeleted + first.buildKeysDeleted + first.screenshotsCleared)
      .toBeGreaterThan(0);

    removed.length = 0;
    const second = await retention().prune(1_000_000);
    expect(second).toMatchObject({
      screenshotsCleared: 0,
      nodeObservationsDeleted: 0,
      edgeObservationsDeleted: 0,
      buildKeysDeleted: 0,
    });
    expect(removed).toEqual([]);
  });

  test("no-ops cleanly on an empty database", async () => {
    const summary = await retention().prune(1_000_000);
    expect(summary).toMatchObject({
      screenshotsCleared: 0,
      nodeObservationsDeleted: 0,
      edgeObservationsDeleted: 0,
      buildKeysDeleted: 0,
    });
  });
});
