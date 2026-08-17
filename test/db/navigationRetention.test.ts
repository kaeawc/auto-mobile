import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { NavigationRepository } from "../../src/db/navigationRepository";
import {
  NavigationRetention,
  resolveNavigationRetentionConfig,
  resolveNavigationRetentionIntervalMs,
  computeProtectedBuildKeyIds,
  buildOldestNodeEvictableQuery,
  DEFAULT_SCREENSHOT_TTL_MS,
  DEFAULT_STRUCTURE_TTL_MS,
  DEFAULT_PER_APP_MAX_OBSERVATIONS,
  DEFAULT_GLOBAL_MAX_OBSERVATIONS,
  DEFAULT_NAV_RETENTION_INTERVAL_MS,
  DEFAULT_EVICTION_CHUNK_SIZE,
  MAX_EVICTION_CHUNK_SIZE,
  MAX_INTERVAL_MS,
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
    "AUTOMOBILE_NAV_RETENTION_EVICTION_CHUNK_SIZE",
    "AUTOMOBILE_NAV_RETENTION_INTERVAL_MS",
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

  test("rejects partial-parse env values (strict full-string integer)", () => {
    // Number.parseInt would accept these as 1 / 12 — strict validation must not.
    process.env.AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS = "1e6";
    expect(resolveNavigationRetentionConfig().structureTtlMs).toBe(DEFAULT_STRUCTURE_TTL_MS);
    process.env.AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS = "12abc";
    expect(resolveNavigationRetentionConfig().structureTtlMs).toBe(DEFAULT_STRUCTURE_TTL_MS);
    process.env.AUTOMOBILE_NAV_RETENTION_INTERVAL_MS = "1e6";
    expect(resolveNavigationRetentionIntervalMs()).toBe(DEFAULT_NAV_RETENTION_INTERVAL_MS);
  });

  test("rejects invalid EXPLICIT overrides (0 / negative / NaN / float) -> default", () => {
    expect(resolveNavigationRetentionConfig({ perAppMaxObservations: 0 }).perAppMaxObservations).toBe(
      DEFAULT_PER_APP_MAX_OBSERVATIONS
    );
    expect(
      resolveNavigationRetentionConfig({ perAppMaxObservations: -3 }).perAppMaxObservations
    ).toBe(DEFAULT_PER_APP_MAX_OBSERVATIONS);
    expect(
      resolveNavigationRetentionConfig({ globalMaxObservations: Number.NaN }).globalMaxObservations
    ).toBe(DEFAULT_GLOBAL_MAX_OBSERVATIONS);
    expect(resolveNavigationRetentionConfig({ structureTtlMs: 1.5 }).structureTtlMs).toBe(
      DEFAULT_STRUCTURE_TTL_MS
    );
    // A valid override still wins.
    expect(resolveNavigationRetentionConfig({ perAppMaxObservations: 7 }).perAppMaxObservations).toBe(7);
  });

  test("rejects an interval above the Int32 setInterval ceiling (would clamp to 1ms)", () => {
    process.env.AUTOMOBILE_NAV_RETENTION_INTERVAL_MS = String(MAX_INTERVAL_MS + 1);
    expect(resolveNavigationRetentionIntervalMs()).toBe(DEFAULT_NAV_RETENTION_INTERVAL_MS);
    expect(resolveNavigationRetentionIntervalMs(3_000_000_000)).toBe(DEFAULT_NAV_RETENTION_INTERVAL_MS);
    // A large-but-in-range interval is honored.
    expect(resolveNavigationRetentionIntervalMs(MAX_INTERVAL_MS)).toBe(MAX_INTERVAL_MS);
  });

  test("clamps evictionChunkSize to the safe batch ceiling (env and override)", () => {
    expect(resolveNavigationRetentionConfig({ evictionChunkSize: 300_000 }).evictionChunkSize).toBe(
      MAX_EVICTION_CHUNK_SIZE
    );
    expect(resolveNavigationRetentionConfig({ evictionChunkSize: 2 }).evictionChunkSize).toBe(2);
    expect(resolveNavigationRetentionConfig().evictionChunkSize).toBe(DEFAULT_EVICTION_CHUNK_SIZE);
    process.env.AUTOMOBILE_NAV_RETENTION_EVICTION_CHUNK_SIZE = "999999";
    expect(resolveNavigationRetentionConfig().evictionChunkSize).toBe(MAX_EVICTION_CHUNK_SIZE);
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

  test("clears stale screenshots in bounded batches (oversized UPDATE cannot form)", async () => {
    // Node cardinality is not bounded by the observation caps, so the stale-
    // screenshot UPDATE must batch. chunkSize 2 forces several UPDATEs of <= 2 ids.
    await repo.getOrCreateApp(APP);
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const node = await repo.getOrCreateNode(APP, `S${i}`, 100);
      await repo.updateNodeScreenshotById(node.id, `/tmp/shot-${i}.webp`);
      paths.push(`/tmp/shot-${i}.webp`);
    }

    const summary = await retention({ ...CONFIG, evictionChunkSize: 2 }).prune(10_000);

    expect(summary.screenshotsCleared).toBe(5);
    expect(removed.sort()).toEqual(paths.sort());
    const remaining = await db.selectFrom("navigation_nodes").select("screenshot_path").execute();
    expect(remaining.every(r => r.screenshot_path === null)).toBe(true);
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

  test("per-app LRU cap evicts oldest observations by last_seen, keeps the active row", async () => {
    const nodeId = await seedNode("Home", 1);
    const bkOld = await buildKey(APP, 1);
    const bkNew = await buildKey(APP, 2);
    await nodeObs(nodeId, bkNew, "active", 10_000); // newest -> active, protected build
    for (let i = 0; i < 5; i++) {
      await nodeObs(nodeId, bkOld, `s${i}`, 1_000 + i);
    }

    // structureTtl huge so only the cap can evict (isolates the LRU backstop).
    // Cap counts ALL 6 rows; overflow 4 evicts the 4 oldest; the active row and
    // the newest evictable row survive.
    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 2,
    }).prune(11_000);

    expect(summary.nodeObservationsDeleted).toBe(4);
    const remaining = await db
      .selectFrom("navigation_node_observations")
      .select(["session_uuid", "last_seen_at"])
      .orderBy("last_seen_at", "asc")
      .execute();
    const sessions = remaining.map(r => r.session_uuid).sort();
    expect(sessions).toEqual(["active", "s4"]); // oldest s0..s3 gone; newest kept
  });

  test("cap bounds a continuously-used SINGLE-build app, keeping the most recent", async () => {
    // Regression: the cap must bound an app whose only build key is the protected
    // one — otherwise a single-build app grows unbounded until the long TTL.
    const nodeId = await seedNode("Home", 1);
    const bk = await buildKey(APP, 1); // the ONLY build key => it is the protected one
    for (let i = 0; i < 6; i++) {
      await nodeObs(nodeId, bk, `s${i}`, 100 + i);
    }

    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 3,
    }).prune(1_000_000);

    // total 6, cap 3 -> evict 3 oldest; the 3 newest (incl active s5) survive.
    expect(summary.nodeObservationsDeleted).toBe(3);
    const remaining = await db
      .selectFrom("navigation_node_observations")
      .select("session_uuid")
      .execute();
    expect(remaining.map(r => r.session_uuid).sort()).toEqual(["s3", "s4", "s5"]);
    // (c) the protected build key is never orphan-swept even after thinning.
    const keys = await db.selectFrom("navigation_build_keys").select("id").execute();
    expect(keys.map(k => k.id)).toEqual([bk]);
  });

  test("never evicts the active row even under an aggressive cap", async () => {
    const nodeId = await seedNode("Home", 1);
    const bk = await buildKey(APP, 1);
    await nodeObs(nodeId, bk, "old1", 100);
    await nodeObs(nodeId, bk, "old2", 200);
    await nodeObs(nodeId, bk, "active", 300); // newest -> active

    // total 3, cap 1 -> overflow 2 evicts old1/old2; the active row is shielded
    // even though the app still exceeds the cap afterward.
    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 1,
    }).prune(1_000_000);

    expect(summary.nodeObservationsDeleted).toBe(2);
    const remaining = await db
      .selectFrom("navigation_node_observations")
      .select("session_uuid")
      .execute();
    expect(remaining.map(r => r.session_uuid)).toEqual(["active"]);
  });

  test("evicts in bounded batches (chunk loop) without missing rows", async () => {
    const nodeId = await seedNode("Home", 1);
    const bk = await buildKey(APP, 1);
    for (let i = 0; i < 7; i++) {
      await nodeObs(nodeId, bk, `s${i}`, 100 + i);
    }

    // chunkSize 2 forces several batches; each DELETE binds <= 2 ids. cap 1 ->
    // evict 6 oldest, keep the active row (s6). Proves the loop deletes the full
    // victim set without exceeding the per-statement variable limit.
    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 1,
      evictionChunkSize: 2,
    }).prune(1_000_000);

    expect(summary.nodeObservationsDeleted).toBe(6);
    const remaining = await db
      .selectFrom("navigation_node_observations")
      .select("session_uuid")
      .execute();
    expect(remaining.map(r => r.session_uuid)).toEqual(["s6"]);
  });

  test("global LRU cap evicts oldest across apps, sparing each app's active build", async () => {
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

    // total 5; global cap 2 -> overflow 3 evicts the 3 oldest non-active rows
    // (a-100, b-200, a-300). Each app's active build (p1, p2) is shielded even
    // though p1 is globally older than app 2's p2.
    const summary = await retention({
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 1_000,
      globalMaxObservations: 2,
    }).prune(10_000);

    expect(summary.nodeObservationsDeleted).toBe(3);
    const rows = await db
      .selectFrom("navigation_node_observations")
      .select("session_uuid")
      .execute();
    const sessions = rows.map(r => r.session_uuid).sort();
    expect(sessions).toEqual(["p1", "p2"]);
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

describe("eviction active-row exclusion is relational (bounded bind params)", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("the oldest-evictable query binds O(protected apps), not O(active rows)", () => {
    // Compile the actual eviction-selection query. Its bound parameters must be
    // just the app scope + the protected id list + limit — NEVER one param per
    // active/observation row (which a `NOT IN (activeIds)` list would produce and
    // could exceed bun:sqlite's MAX_VARIABLE_NUMBER of 250_000).
    const protectedIds = [1, 2, 3, 4, 5];
    const compiled = buildOldestNodeEvictableQuery(db, "com.example.app", protectedIds, 100).compile();
    // app id (1) + protectedIds (5) + limit (1) = 7; the correlated max subquery
    // and the app-scope subquery bind no per-row params.
    expect(compiled.parameters.length).toBe(protectedIds.length + 2);
    // Bind shape does not depend on active-row count: a larger protected set grows
    // the param count by exactly its own size, nothing more.
    const bigger = buildOldestNodeEvictableQuery(db, "com.example.app", [1, 2, 3, 4, 5, 6, 7], 100).compile();
    expect(bigger.parameters.length).toBe(7 + 2);
  });

  test("never evicts active rows even when MANY tie at the build key's max last_seen", async () => {
    const repo = new NavigationRepository(db);
    await repo.getOrCreateApp(APP);
    const node = await repo.getOrCreateNode(APP, "Home", 1);
    const bk = await repo.getOrCreateBuildKey(APP, 1, "h"); // only build key -> protected

    // 300 observations all tied at the max instant (all "active") + 5 older rows.
    for (let i = 0; i < 300; i++) {
      await repo.recordNodeObservation(node.id, bk.id, "d", `active-${i}`, 10_000);
    }
    for (let i = 0; i < 5; i++) {
      await repo.recordNodeObservation(node.id, bk.id, "d", `old-${i}`, 1_000 + i);
    }

    // Aggressive cap; structure TTL huge so only the cap acts. All 300 tied-max
    // rows are active and must survive; the 5 older rows are evicted.
    const summary = await new NavigationRetention(db, {
      ...CONFIG,
      structureTtlMs: 10_000_000,
      perAppMaxObservations: 1,
    }).prune(1_000_000);

    expect(summary.nodeObservationsDeleted).toBe(5);
    const survivors = await db
      .selectFrom("navigation_node_observations")
      .select(["session_uuid", "last_seen_at"])
      .execute();
    expect(survivors.length).toBe(300);
    expect(survivors.every(r => r.last_seen_at === 10_000)).toBe(true);
  });
});
