import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database, NewNavigationEdge } from "../../src/db/types";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { NavigationRetention } from "../../src/db/navigationRetention";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";

// The navigation_edges table is an append-only traversal log (one row per traversal);
// readers must see DISTINCT transitions and retention must bound the log (#10194).

const APP = "com.example.app";
const TRAVERSALS = 500;

function tapArgs(text: string): string {
  return JSON.stringify({ text });
}

function traversalRows(
  count: number,
  from: string,
  to: string,
  toolName: string | null,
  toolArgs: string | null,
  firstTimestamp = 1_000,
): NewNavigationEdge[] {
  return Array.from({ length: count }, (_, index) => ({
    app_id: APP,
    from_screen: from,
    to_screen: to,
    tool_name: toolName,
    tool_args: toolArgs,
    timestamp: firstTimestamp + index,
  }));
}

async function edgeRowCount(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom("navigation_edges")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe("navigation_edges distinct-transition readers (#10194)", () => {
  let db: Kysely<Database>;
  let repo: NavigationRepository;
  let manager: NavigationGraphManager;

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
    repo = new NavigationRepository(db);
    manager = NavigationGraphManager.createForTesting(
      repo,
      new TestCoverageRepository(undefined, db),
    );
    await repo.getOrCreateApp(APP);
    await manager.setCurrentApp(APP);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedRoundTrips(): Promise<void> {
    await db
      .insertInto("navigation_edges")
      .values([
        ...traversalRows(TRAVERSALS, "Home", "Settings", "tapOn", tapArgs("Settings"), 1_000),
        ...traversalRows(TRAVERSALS, "Settings", "Home", null, null, 100_000),
      ])
      .execute();
  }

  test("500 traversals of one transition read as one edge", async () => {
    await db
      .insertInto("navigation_edges")
      .values(traversalRows(TRAVERSALS, "Home", "Settings", "tapOn", tapArgs("Settings")))
      .execute();

    expect(await edgeRowCount(db)).toBe(TRAVERSALS);
    expect(await repo.getDistinctEdges(APP)).toHaveLength(1);
    expect(await repo.getEdgesFrom(APP, "Home")).toHaveLength(1);
    expect(await repo.getEdgesTo(APP, "Settings")).toHaveLength(1);
    expect(await repo.getStats(APP)).toMatchObject({
      edgeCount: 1,
      toolEdgeCount: 1,
      unknownEdgeCount: 0,
    });
    // The traversal log itself is untouched for readers that count traversals.
    expect(await repo.getEdges(APP)).toHaveLength(TRAVERSALS);
  });

  test("the newest traversal's row and metadata represent the transition", async () => {
    await db
      .insertInto("navigation_edges")
      .values(traversalRows(TRAVERSALS, "Home", "Settings", "tapOn", tapArgs("Settings")))
      .execute();
    const newest = await repo.createEdge(
      APP,
      "Home",
      "Settings",
      "tapOn",
      { text: "Settings" },
      // A device clock that stepped backwards must not demote the newest row.
      5,
    );

    const edges = await repo.getDistinctEdges(APP);

    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe(newest.id);
    expect(edges[0].timestamp).toBe(5);
  });

  test("mixed transitions keep distinct counts per tool call, endpoint and null tool", async () => {
    await db
      .insertInto("navigation_edges")
      .values([
        ...traversalRows(40, "Home", "Settings", "tapOn", tapArgs("Settings")),
        ...traversalRows(30, "Home", "Settings", "tapOn", tapArgs("Gear")),
        ...traversalRows(20, "Home", "Settings", null, null),
        ...traversalRows(10, "Settings", "Home", null, null),
        ...traversalRows(5, "Home", "Profile", "tapOn", tapArgs("Me")),
      ])
      .execute();

    const fromHome = await repo.getEdgesFrom(APP, "Home");
    expect(fromHome.map((edge) => [edge.to_screen, edge.tool_args]).sort()).toEqual([
      ["Profile", tapArgs("Me")],
      ["Settings", null],
      ["Settings", tapArgs("Gear")],
      ["Settings", tapArgs("Settings")],
    ]);
    expect(await repo.getEdgesTo(APP, "Settings")).toHaveLength(3);
    expect(await repo.getDistinctEdges(APP)).toHaveLength(5);
    expect(await repo.getStats(APP)).toMatchObject({
      edgeCount: 5,
      toolEdgeCount: 3,
      unknownEdgeCount: 2,
    });
  });

  test("distinct transitions never cross apps", async () => {
    await repo.getOrCreateApp("com.example.other");
    await db
      .insertInto("navigation_edges")
      .values([
        ...traversalRows(3, "Home", "Settings", "tapOn", tapArgs("Settings")),
        ...traversalRows(3, "Home", "Settings", "tapOn", tapArgs("Settings")).map((row) => ({
          ...row,
          app_id: "com.example.other",
        })),
      ])
      .execute();

    expect(await repo.getDistinctEdges(APP)).toHaveLength(1);
    expect(await repo.getDistinctEdges("com.example.other")).toHaveLength(1);
  });

  test("getEdgesFrom hydrates one edge, not one per traversal", async () => {
    await seedRoundTrips();
    const hydrate = spyOn(repo, "getUIElementsForEdge");

    const edges = await manager.getEdgesFrom("Home");

    expect(edges).toHaveLength(1);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  test("exportGraph lists each transition once and reads no traversal rows", async () => {
    await seedRoundTrips();
    const allRows = spyOn(repo, "getEdges");

    const graph = await manager.exportGraphForApp(APP);

    expect(graph.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ["Home", "Settings"],
      ["Settings", "Home"],
    ]);
    expect(allRows).not.toHaveBeenCalled();
  });

  test("findPath loads and hydrates O(distinct) edges", async () => {
    await seedRoundTrips();
    const allRows = spyOn(repo, "getEdges");
    const distinct = spyOn(repo, "getDistinctEdges");
    const hydrate = spyOn(repo, "getUIElementsForEdge");
    // A current screen on the manager side: the graph already holds Home.
    await manager.recordNavigationEvent({
      destination: "Home",
      source: "TEST",
      arguments: {},
      metadata: {},
      timestamp: 200_000,
      sequenceNumber: 1,
      applicationId: APP,
    });

    const result = await manager.findPath("Settings");

    expect(result.found).toBe(true);
    expect(result.path).toHaveLength(1);
    expect(allRows).not.toHaveBeenCalled();
    expect(await distinct.mock.results[0].value).toHaveLength(2);
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  test("the graph summary still reports the traversal count of a transition", async () => {
    await db
      .insertInto("navigation_edges")
      .values(traversalRows(7, "Home", "Settings", "tapOn", tapArgs("Settings")))
      .execute();

    const summary = await manager.exportGraphSummaryForApp(APP);

    expect(summary.edges).toHaveLength(1);
    expect(summary.edges[0].traversalCount).toBe(7);
  });
});

describe("navigation_edges traversal retention (#10194)", () => {
  let db: Kysely<Database>;
  let repo: NavigationRepository;
  let yields: number;

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
    repo = new NavigationRepository(db);
    await repo.getOrCreateApp(APP);
    yields = 0;
  });

  afterEach(async () => {
    await db.destroy();
  });

  function retention(config: {
    maxEdgeTraversalsPerTransition?: number;
    evictionChunkSize?: number;
  }) {
    return new NavigationRetention(db, config, undefined, undefined, async () => {
      yields += 1;
    });
  }

  test("500 traversals of one transition are cut to the newest N rows", async () => {
    await db
      .insertInto("navigation_edges")
      .values(traversalRows(TRAVERSALS, "Home", "Settings", "tapOn", tapArgs("Settings")))
      .execute();
    const newestId = (await repo.getDistinctEdges(APP))[0].id;

    const summary = await retention({ maxEdgeTraversalsPerTransition: 5 }).prune(1_000_000);

    expect(summary.edgeTraversalsDeleted).toBe(TRAVERSALS - 5);
    expect(await edgeRowCount(db)).toBe(5);
    const kept = await db
      .selectFrom("navigation_edges")
      .select("id")
      .orderBy("id", "desc")
      .execute();
    expect(kept[0].id).toBe(newestId);
    expect(kept.map((row) => row.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => newestId - index),
    );
  });

  test("trims in bounded chunks and yields between them", async () => {
    await db
      .insertInto("navigation_edges")
      .values(traversalRows(60, "Home", "Settings", "tapOn", tapArgs("Settings")))
      .execute();

    const summary = await retention({
      maxEdgeTraversalsPerTransition: 10,
      evictionChunkSize: 20,
    }).prune(1_000_000);

    expect(summary.edgeTraversalsDeleted).toBe(50);
    expect(await edgeRowCount(db)).toBe(10);
    expect(yields).toBeGreaterThan(1);
  });

  test("each distinct transition keeps its own newest rows; null-tool groups are one group", async () => {
    await db
      .insertInto("navigation_edges")
      .values([
        ...traversalRows(30, "Home", "Settings", "tapOn", tapArgs("Settings")),
        ...traversalRows(30, "Home", "Settings", "tapOn", tapArgs("Gear")),
        ...traversalRows(30, "Settings", "Home", null, null),
        ...traversalRows(3, "Home", "Profile", "tapOn", tapArgs("Me")),
      ])
      .execute();

    await retention({ maxEdgeTraversalsPerTransition: 4 }).prune(1_000_000);

    const counts = await db
      .selectFrom("navigation_edges")
      .select(["from_screen", "to_screen", "tool_args"])
      .select((eb) => eb.fn.countAll<number>().as("rows"))
      .groupBy(["from_screen", "to_screen", "tool_name", "tool_args"])
      .orderBy("from_screen")
      .orderBy("to_screen")
      .orderBy("tool_args")
      .execute();
    expect(
      counts.map((row) => [row.from_screen, row.to_screen, row.tool_args, Number(row.rows)]),
    ).toEqual([
      ["Home", "Profile", tapArgs("Me"), 3],
      ["Home", "Settings", tapArgs("Gear"), 4],
      ["Home", "Settings", tapArgs("Settings"), 4],
      ["Settings", "Home", null, 4],
    ]);
    expect(await repo.getDistinctEdges(APP)).toHaveLength(4);
  });

  test("a transition at or under the cap is untouched, and a second pass deletes nothing", async () => {
    await db
      .insertInto("navigation_edges")
      .values(traversalRows(5, "Home", "Settings", "tapOn", tapArgs("Settings")))
      .execute();

    const first = await retention({ maxEdgeTraversalsPerTransition: 5 }).prune(1_000_000);
    expect(first.edgeTraversalsDeleted).toBe(0);
    expect(await edgeRowCount(db)).toBe(5);

    const second = await retention({ maxEdgeTraversalsPerTransition: 2 }).prune(1_000_000);
    expect(second.edgeTraversalsDeleted).toBe(3);
    const third = await retention({ maxEdgeTraversalsPerTransition: 2 }).prune(1_000_000);
    expect(third.edgeTraversalsDeleted).toBe(0);
  });

  test("deleting a surplus row cascades its child rows and keeps the newest row's", async () => {
    const oldest = await repo.createEdge(APP, "Home", "Settings", "tapOn", { text: "S" }, 1);
    const newest = await repo.createEdge(APP, "Home", "Settings", "tapOn", { text: "S" }, 2);
    await repo.setEdgeModals(oldest.id, "from", ["old-modal"]);
    await repo.setEdgeModals(newest.id, "from", ["new-modal"]);

    await retention({ maxEdgeTraversalsPerTransition: 1 }).prune(1_000_000);

    expect(await repo.getEdgeModals(oldest.id, "from")).toEqual([]);
    expect(await repo.getEdgeModals(newest.id, "from")).toEqual(["new-modal"]);
  });

  test("a row referenced by a test-coverage session is never deleted", async () => {
    const coverage = new TestCoverageRepository(undefined, db);
    const session = await coverage.startSession("session-1", APP);
    const oldest = await repo.createEdge(APP, "Home", "Settings", "tapOn", { text: "S" }, 1);
    await repo.createEdge(APP, "Home", "Settings", "tapOn", { text: "S" }, 2);
    await repo.createEdge(APP, "Home", "Settings", "tapOn", { text: "S" }, 3);
    await coverage.recordEdgeTraversal(session.id, oldest.id, 1);

    await retention({ maxEdgeTraversalsPerTransition: 1 }).prune(1_000_000);

    const remaining = await db.selectFrom("navigation_edges").select("id").execute();
    expect(remaining.map((row) => row.id)).toContain(oldest.id);
    expect(await coverage.getCoveredEdges(session.id)).toHaveLength(1);
  });
});
