import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "../../db/testDbHelper";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import type { Database } from "../../../src/db/types";
import { DefaultPathOptimizer } from "../../../src/features/navigation/DefaultPathOptimizer";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { TelemetryRecorder } from "../../../src/features/telemetry/TelemetryRecorder";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_ID = "com.example.backpath";

/**
 * The back-button heuristic verifies that the target screen reaches the current
 * one by forward edges (the route the user took down the stack). These tests drive
 * the REAL NavigationGraphManager so the search direction is exercised against
 * the manager's actual edges, not a stub that can hide a reversed lookup.
 */
describe("DefaultPathOptimizer against a real navigation graph", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;
  let sequence = 0;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
    manager = harness.manager;
  });

  afterAll(async () => {
    await harness.dispose();
  });

  beforeEach(async () => {
    sequence = 0;
    await manager.setCurrentApp(APP_ID);
    await manager.clearCurrentGraph();
  });

  /** Visit `screen` (creating an edge from the previous one) and record its depth. */
  async function visit(screen: string, depth: number): Promise<void> {
    sequence += 1;
    await manager.recordNavigationEvent({
      destination: screen,
      source: "",
      arguments: {},
      metadata: {},
      timestamp: 1000 + sequence,
      sequenceNumber: sequence,
      applicationId: APP_ID,
    });
    await manager.recordBackStack({ depth, currentTaskId: 1 });
  }

  test("uses two Back presses when the target leads to the current screen in two edges", async () => {
    await visit("Feed", 1);
    await visit("Detail", 2);
    await visit("Settings", 3);

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result).toMatchObject({ shouldUseBack: true, backPresses: 2 });
    expect(result.reason).toMatch(/matches depth difference/);
  });

  test("does not press Back when only the opposite direction (current to target) has a matching path", async () => {
    // Settings -> Profile -> Feed, then Feed -> Settings: Feed reaches Settings in ONE
    // edge, so the two-level gap is not a retraced stack. Searching from the current
    // screen finds the unrelated two-edge route Settings -> Profile -> Feed instead.
    await visit("Settings", 3);
    await visit("Profile", 2);
    await visit("Feed", 1);
    await visit("Settings", 3);

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result.shouldUseBack).toBe(false);
    expect(result.backPresses).toBe(0);
    expect(result.reason).toMatch(/doesn't match depth difference/);
  });

  test("keeps the depth-1 fallback when no forward path is recorded", async () => {
    await visit("Feed", 1);
    await visit("Detail", 2);
    // Forget every edge but keep the nodes' depths.
    await harness.db.deleteFrom("navigation_edges").execute();

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton("Detail", "Feed", 2);

    expect(result).toMatchObject({ shouldUseBack: true, backPresses: 1 });
    expect(result.reason).toMatch(/Depth difference is 1/);
  });

  test("declines a depth-2 gap with no recorded forward path", async () => {
    await visit("Feed", 1);
    await visit("Detail", 2);
    await visit("Settings", 3);
    await harness.db.deleteFrom("navigation_edges").execute();

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result.shouldUseBack).toBe(false);
    expect(result.reason).toMatch(/No known navigation path to verify safety/);
  });
});

/**
 * The Back decision only needs adjacency, so it must not pay for edge hydration
 * (modal / UI-element / scroll-position queries, JSON.parse of tool payloads).
 */
describe("DefaultPathOptimizer adjacency reads", () => {
  let db: Kysely<Database>;
  let repository: NavigationRepository;
  let manager: NavigationGraphManager;
  let telemetrySpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = await createTestDatabase();
    repository = new NavigationRepository(db);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, db),
    );
    TelemetryRecorder.resetInstance();
    telemetrySpy = spyOn(
      TelemetryRecorder.getInstance(),
      "recordNavigationEvent",
    ).mockResolvedValue(undefined);
    await manager.setCurrentApp(APP_ID);
  });

  afterEach(async () => {
    telemetrySpy.mockRestore();
    TelemetryRecorder.resetInstance();
    await db.destroy();
  });

  async function visit(screen: string, depth: number, timestamp: number): Promise<void> {
    await manager.recordNavigationEvent({
      destination: screen,
      source: "",
      arguments: {},
      metadata: {},
      timestamp,
      sequenceNumber: timestamp,
      applicationId: APP_ID,
    });
    await manager.recordBackStack({ depth, currentTaskId: 1 });
  }

  /** Add `count` extra rows for an existing transition (repeated traversals). */
  async function duplicateEdge(from: string, to: string, count: number): Promise<void> {
    await db
      .insertInto("navigation_edges")
      .values(
        Array.from({ length: count }, (_, index) => ({
          app_id: APP_ID,
          from_screen: from,
          to_screen: to,
          tool_name: null,
          tool_args: null,
          timestamp: 10_000 + index,
        })),
      )
      .execute();
  }

  test("issues one adjacency read per visited screen and never hydrates edges", async () => {
    await visit("Feed", 1, 1001);
    await visit("Detail", 2, 1002);
    await visit("Settings", 3, 1003);
    const hydrating = spyOn(repository, "getEdgesFrom");
    const adjacency = spyOn(repository, "getEdgeTargetsFrom");

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton(
      "Settings",
      "Feed",
      3,
    );

    expect(result).toMatchObject({ shouldUseBack: true, backPresses: 2 });
    // Hop 1 expands Feed; hop 2 expands its only new neighbour, Detail.
    expect(adjacency.mock.calls.map((call) => call[1])).toEqual(["Feed", "Detail"]);
    expect(hydrating).not.toHaveBeenCalled();
  });

  test("a screen pair with many duplicate rows costs one adjacency row", async () => {
    await visit("Feed", 1, 1001);
    await visit("Detail", 2, 1002);
    await duplicateEdge("Feed", "Detail", 200);

    const targets = await manager.getEdgeTargetsFrom("Feed");

    expect(targets).toEqual([{ toScreen: "Detail", toolName: null, toolArgs: null }]);
  });

  test("a malformed edge payload cannot throw out of the Back decision", async () => {
    await visit("Feed", 1, 1001);
    await visit("Detail", 2, 1002);
    await db
      .updateTable("navigation_edges")
      .set({ tool_name: "tapOn", tool_args: "{not json" })
      .execute();

    const result = await new DefaultPathOptimizer(manager).shouldUseBackButton("Detail", "Feed", 2);

    expect(result).toMatchObject({ shouldUseBack: true, backPresses: 1 });
    expect(result.reason).toMatch(/matches depth difference/);
  });

  test("adjacency keeps the tool name and raw args so callers can filter without hydrating", async () => {
    await visit("Feed", 1, 1001);
    await visit("Detail", 2, 1002);
    await db
      .updateTable("navigation_edges")
      .set({ tool_name: "pressButton", tool_args: '{"button":"back"}' })
      .execute();

    expect(await manager.getEdgeTargetsFrom("Feed")).toEqual([
      { toScreen: "Detail", toolName: "pressButton", toolArgs: '{"button":"back"}' },
    ]);
  });
});
