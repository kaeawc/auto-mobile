import {
  expect,
  describe,
  test,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  it,
  spyOn,
} from "bun:test";
import type { Kysely } from "kysely";
import {
  NavigationGraphManager,
  NavigationEvent,
} from "../../../src/features/navigation/NavigationGraphManager";
import { runMigrations } from "../../helpers/database";
import { createTestDatabase } from "../../db/testDbHelper";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { TelemetryRecorder } from "../../../src/features/telemetry/TelemetryRecorder";
import { defaultTimer, type Timer } from "../../../src/utils/SystemTimer";
import type { Database, NavigationEdge as DBNavigationEdge } from "../../../src/db/types";
import { ActionableError } from "../../../src/models/ActionableError";
import { useTempFileDatabase, type TempFileDatabaseHandle } from "../../helpers/tempFileDatabase";
import { readFileSync } from "fs";
import { join } from "path";

describe("NavigationGraphManager", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;

  beforeEach(async () => {
    // Fresh in-memory, already-migrated DB per test (issue #2969): the manager is
    // built via createForTesting on an isolated connection and installed as the
    // getInstance() singleton, so no test can observe leftover state from a prior
    // test, file, or worktree run (the cold-first-run flake this suite used to
    // have when it shared the real getDatabase() singleton).
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    await manager.setCurrentApp("com.test.app");
  });

  afterEach(async () => {
    await harness.dispose();
  });

  /**
   * A fresh no-current-app manager on the SAME in-memory connection, for tests
   * that need pristine in-memory state. These paths used to be exercised via
   * resetInstance()+getInstance(), but a lazily rebuilt default instance binds
   * its repositories to the real getDatabase() singleton — the shared-state
   * dependency this suite is isolated from (and the unit-test DB guard, #3067,
   * rejects).
   */
  function makeFreshManager(): NavigationGraphManager {
    return NavigationGraphManager.createForTesting(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
    );
  }

  describe("singleton pattern", () => {
    test("should return the same instance", () => {
      const instance1 = NavigationGraphManager.getInstance();
      const instance2 = NavigationGraphManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    test("should reset instance correctly", async () => {
      const instance1 = NavigationGraphManager.getInstance();
      await instance1.setCurrentApp("com.test.app");
      await instance1.recordNavigationEvent(createEvent("Screen1"));

      NavigationGraphManager.resetInstance();

      // getInstance() lazily rebuilds a default instance here. Only accessors
      // that never resolve its (real-getDatabase-bound) repositories are safe:
      // getCurrentAppId() is in-memory, and getKnownScreens() short-circuits to
      // [] while currentAppId is null.
      const instance2 = NavigationGraphManager.getInstance();
      expect(instance2).not.toBe(instance1);
      expect(instance2.getCurrentAppId()).toBeNull();
      expect(await instance2.getKnownScreens()).toEqual([]);
    });
  });

  describe("session lifecycle (#4984)", () => {
    test("a released session's stray event resolves to the unattributed global, not a recreated session manager", () => {
      NavigationGraphManager.resetInstance();
      const global = NavigationGraphManager.getInstance();
      const a = NavigationGraphManager.getInstanceForSession("session-A");
      expect(a).not.toBe(global);

      NavigationGraphManager.releaseSession("session-A");

      // A stray post-release event must NOT mint a new manager attributed to A.
      const strayA = NavigationGraphManager.getInstanceForSession("session-A");
      expect(strayA).toBe(global);

      // A genuinely new session still gets its own dedicated manager.
      const b = NavigationGraphManager.getInstanceForSession("session-B");
      expect(b).not.toBe(global);
      expect(b).not.toBe(a);

      NavigationGraphManager.resetInstance();
    });

    test("clearReleasedSession lets a reused uuid (setActiveDevice) get a real manager again", () => {
      NavigationGraphManager.resetInstance();
      const global = NavigationGraphManager.getInstance();
      NavigationGraphManager.getInstanceForSession("session-A");
      NavigationGraphManager.releaseSession("session-A");
      expect(NavigationGraphManager.getInstanceForSession("session-A")).toBe(global);

      // setActiveDevice re-creates the session with the same uuid; bindSession clears
      // the tombstone, so the live replacement gets its own manager, not the global.
      NavigationGraphManager.clearReleasedSession("session-A");
      const revived = NavigationGraphManager.getInstanceForSession("session-A");
      expect(revived).not.toBe(global);

      NavigationGraphManager.resetInstance();
    });
  });

  describe("listAppsWithGraph", () => {
    test("maps persisted apps with nodes to summaries and omits display name", async () => {
      const repo = new NavigationRepository(harness.db);
      await repo.getOrCreateApp("com.example.graph");
      await repo.getOrCreateNode("com.example.graph", "Home", 1000);
      await harness.db
        .updateTable("navigation_apps")
        .set({ updated_at: "2026-01-05T00:00:00.000Z" })
        .where("app_id", "=", "com.example.graph")
        .execute();

      const apps = await manager.listAppsWithGraph();

      const seeded = apps.find((app) => app.appId === "com.example.graph");
      expect(seeded).toEqual({
        appId: "com.example.graph",
        displayName: null,
        lastUpdated: "2026-01-05T00:00:00.000Z",
      });
    });

    test("excludes apps that have a row but no persisted nodes", async () => {
      // beforeEach sets current app "com.test.app" via setCurrentApp, which
      // creates the app row but records no nodes — so it must not appear.
      const apps = await manager.listAppsWithGraph();
      expect(apps.some((app) => app.appId === "com.test.app")).toBe(false);
    });
  });

  describe("setCurrentApp", () => {
    test("should set the current app", async () => {
      await manager.setCurrentApp("com.example.app");
      expect(manager.getCurrentAppId()).toBe("com.example.app");
    });

    test("should create separate graphs for different apps", async () => {
      await manager.setCurrentApp("com.app1");
      await manager.recordNavigationEvent(createEvent("Screen1"));

      await manager.setCurrentApp("com.app2");
      await manager.recordNavigationEvent(createEvent("Screen2"));

      // App2 should only know Screen2
      expect(await manager.getKnownScreens()).toEqual(["Screen2"]);

      // Switch back to app1
      await manager.setCurrentApp("com.app1");
      expect(await manager.getKnownScreens()).toEqual(["Screen1"]);
    });
  });

  describe("recordNavigationEvent", () => {
    test("should record a navigation event and create a node", async () => {
      const event = createEvent("HomeScreen");
      await manager.recordNavigationEvent(event);

      const screens = await manager.getKnownScreens();
      expect(screens).toEqual(["HomeScreen"]);
      expect(manager.getCurrentScreen()).toBe("HomeScreen");
    });

    test("should auto-set current app from applicationId in event", async () => {
      const freshManager = makeFreshManager();

      // No app set initially
      expect(freshManager.getCurrentAppId()).toBeNull();

      // Record event with applicationId
      const event = createEvent("HomeScreen");
      event.applicationId = "com.auto.detected.app";
      await freshManager.recordNavigationEvent(event);

      // App should be auto-set
      expect(freshManager.getCurrentAppId()).toBe("com.auto.detected.app");
      expect(await freshManager.getKnownScreens()).toEqual(["HomeScreen"]);
    });

    test("should switch apps when applicationId changes", async () => {
      await manager.recordNavigationEvent(createEventWithApp("Screen1", "com.app1"));
      expect(manager.getCurrentAppId()).toBe("com.app1");
      expect(await manager.getKnownScreens()).toEqual(["Screen1"]);

      // Switch to different app
      await manager.recordNavigationEvent(createEventWithApp("Screen2", "com.app2"));
      expect(manager.getCurrentAppId()).toBe("com.app2");
      expect(await manager.getKnownScreens()).toEqual(["Screen2"]);

      // Original app's graph should still exist
      await manager.setCurrentApp("com.app1");
      expect(await manager.getKnownScreens()).toEqual(["Screen1"]);
    });

    test("should update node on revisit", async () => {
      const event1 = createEvent("HomeScreen", 1000);
      await manager.recordNavigationEvent(event1);

      const event2 = createEvent("HomeScreen", 2000);
      await manager.recordNavigationEvent(event2);

      const node = await manager.getNode("HomeScreen");
      expect(node).toBeDefined();
      expect(node!.visitCount).toBe(2);
      expect(node!.firstSeenAt).toBe(1000);
      expect(node!.lastSeenAt).toBe(2000);
    });

    test("should create edge when navigating between screens", async () => {
      await manager.recordNavigationEvent(createEvent("Screen1", 1000));
      await manager.recordNavigationEvent(createEvent("Screen2", 2000));

      const edges = await manager.getEdgesFrom("Screen1");
      expect(edges).toHaveLength(1);
      expect(edges[0].from).toBe("Screen1");
      expect(edges[0].to).toBe("Screen2");
      expect(edges[0].edgeType).toBe("unknown"); // No tool call recorded
    });

    test("should not create edge for same screen navigation", async () => {
      await manager.recordNavigationEvent(createEvent("Screen1", 1000));
      await manager.recordNavigationEvent(createEvent("Screen1", 2000));

      const edges = await manager.getEdgesFrom("Screen1");
      expect(edges).toHaveLength(0);
    });

    test("should handle event with missing timestamp by using timer fallback", async () => {
      // Simulate WebSocket message where timestamp is on the outer message, not the event
      const event = {
        destination: "HomeScreen",
        source: "COMPOSE_NAVIGATION",
        arguments: {},
        metadata: {},
        sequenceNumber: 0,
      } as unknown as NavigationEvent;
      // event.timestamp is undefined, simulating the real WebSocket scenario

      await manager.recordNavigationEvent(event);

      const screens = await manager.getKnownScreens();
      expect(screens).toContain("HomeScreen");
      expect(manager.getCurrentScreen()).toBe("HomeScreen");

      const node = await manager.getNode("HomeScreen");
      expect(node).toBeDefined();
      expect(node!.visitCount).toBeGreaterThanOrEqual(1);
      // Timestamp should be filled in by the timer fallback
      expect(node!.firstSeenAt).toBeGreaterThan(0);
    });
  });

  describe("recordToolCall", () => {
    test("should record a tool call", async () => {
      manager.recordToolCall("tapOn", { text: "Button" });

      const stats = await manager.getStats();
      expect(stats.toolCallHistorySize).toBe(1);
    });

    test("should correlate tool call with navigation event", async () => {
      const now = Date.now();

      // Record tool call
      manager.recordToolCall("tapOn", { text: "Settings" });

      // Navigation event occurs 500ms after tool call
      await manager.recordNavigationEvent(createEvent("Screen1", now));
      await manager.recordNavigationEvent(createEvent("SettingsScreen", now + 500));

      const edges = await manager.getEdgesFrom("Screen1");
      expect(edges).toHaveLength(1);
      expect(edges[0].edgeType).toBe("tool");
      expect(edges[0].interaction).toBeDefined();
      expect(edges[0].interaction!.toolName).toBe("tapOn");
      expect(edges[0].interaction!.args).toEqual({ text: "Settings" });
    });

    test("should not correlate tool call outside correlation window", async () => {
      const now = Date.now();

      // Record tool call
      manager.recordToolCall("tapOn", { text: "Settings" });

      // Navigation event occurs 3000ms after tool call (outside 2000ms window)
      await manager.recordNavigationEvent(createEvent("Screen1", now));
      await manager.recordNavigationEvent(createEvent("SettingsScreen", now + 3000));

      const edges = await manager.getEdgesFrom("Screen1");
      expect(edges).toHaveLength(1);
      expect(edges[0].edgeType).toBe("unknown");
      expect(edges[0].interaction).toBeUndefined();
    });

    test("should use most recent tool call within window", async () => {
      const now = Date.now();

      // Record multiple tool calls
      manager.recordToolCall("tapOn", { text: "First" });
      manager.recordToolCall("tapOn", { text: "Second" });

      // Navigation event
      await manager.recordNavigationEvent(createEvent("Screen1", now));
      await manager.recordNavigationEvent(createEvent("Screen2", now + 500));

      const edges = await manager.getEdgesFrom("Screen1");
      expect(edges).toHaveLength(1);
      expect(edges[0].interaction!.args.text).toBe("Second");
    });
  });

  describe("findPath", () => {
    test("should find path when already on target screen", async () => {
      await manager.recordNavigationEvent(createEvent("HomeScreen"));

      const result = await manager.findPath("HomeScreen");
      expect(result.found).toBe(true);
      expect(result.path).toHaveLength(0);
      expect(result.startScreen).toBe("HomeScreen");
      expect(result.targetScreen).toBe("HomeScreen");
    });

    test("should find direct path to adjacent screen", async () => {
      await manager.recordNavigationEvent(createEvent("Screen1", 1000));
      await manager.recordNavigationEvent(createEvent("Screen2", 2000));
      // Go back to Screen1 to test path finding
      await manager.recordNavigationEvent(createEvent("Screen1", 3000));

      const result = await manager.findPath("Screen2");
      expect(result.found).toBe(true);
      expect(result.path).toHaveLength(1);
      expect(result.path[0].from).toBe("Screen1");
      expect(result.path[0].to).toBe("Screen2");
    });

    test("should find multi-hop path", async () => {
      // Create navigation: Home -> Settings -> Advanced
      await manager.recordNavigationEvent(createEvent("Home", 1000));
      await manager.recordNavigationEvent(createEvent("Settings", 2000));
      await manager.recordNavigationEvent(createEvent("Advanced", 3000));
      // Go back to Home
      await manager.recordNavigationEvent(createEvent("Home", 4000));

      const result = await manager.findPath("Advanced");
      expect(result.found).toBe(true);
      expect(result.path).toHaveLength(2);
      expect(result.path[0].from).toBe("Home");
      expect(result.path[0].to).toBe("Settings");
      expect(result.path[1].from).toBe("Settings");
      expect(result.path[1].to).toBe("Advanced");
    });

    test("should read DB edge sources linearly while searching a long path", async () => {
      await manager.recordNavigationEvent(createEvent("Screen0", 1000));

      let fromScreenReadCount = 0;
      const edges = Array.from({ length: 40 }, (_, index) =>
        createCountingDBEdge(index + 1, `Screen${index}`, `Screen${index + 1}`, () => {
          fromScreenReadCount++;
        }),
      );

      const getEdgesSpy = spyOn(NavigationRepository.prototype, "getEdges").mockResolvedValue(
        edges,
      );

      const result = await manager.findPath("Screen40").finally(() => getEdgesSpy.mockRestore());

      expect(result.found).toBe(true);
      expect(result.path).toHaveLength(40);
      // from_screen is read exactly three times per edge: once building the
      // edgesBySource index, once during the BFS neighbour scan, and once during
      // path reconstruction. An exact bound (not <=) also kills a `* 2` regression
      // that would drop one of those linear passes.
      expect(fromScreenReadCount).toBe(edges.length * 3);
    });

    test("should prefer a shorter path over an earlier longer path", async () => {
      await manager.recordNavigationEvent(createEvent("Home", 1000));
      await manager.recordNavigationEvent(createEvent("A", 1100));
      await manager.recordNavigationEvent(createEvent("B", 1200));
      await manager.recordNavigationEvent(createEvent("Target", 1300));
      await manager.recordNavigationEvent(createEvent("Home", 1400));
      await manager.recordNavigationEvent(createEvent("Shortcut", 1500));
      await manager.recordNavigationEvent(createEvent("Target", 1600));
      await manager.recordNavigationEvent(createEvent("Home", 1700));

      const result = await manager.findPath("Target");

      expect(result.found).toBe(true);
      expect(result.path.map((edge) => [edge.from, edge.to])).toEqual([
        ["Home", "Shortcut"],
        ["Shortcut", "Target"],
      ]);
    });

    test("should enrich only edges in the returned path", async () => {
      const now = Date.now();
      await manager.recordNavigationEvent(createEvent("Home", now));

      manager.recordToolCall("tapOn", { text: "Path A" });
      await manager.recordNavigationEvent(createEvent("PathA", now + 100));

      manager.recordToolCall("tapOn", { text: "Target" });
      await manager.recordNavigationEvent(createEvent("Target", now + 200));

      manager.recordToolCall("pressButton", { button: "BACK" });
      await manager.recordNavigationEvent(createEvent("Home", now + 300));

      manager.recordToolCall("tapOn", { text: "Decoy A" });
      await manager.recordNavigationEvent(createEvent("DecoyA", now + 400));

      manager.recordToolCall("pressButton", { button: "BACK" });
      await manager.recordNavigationEvent(createEvent("Home", now + 500));

      manager.recordToolCall("tapOn", { text: "Decoy B" });
      await manager.recordNavigationEvent(createEvent("DecoyB", now + 600));

      manager.recordToolCall("pressButton", { button: "BACK" });
      await manager.recordNavigationEvent(createEvent("Home", now + 700));

      const uiElementsSpy = spyOn(NavigationRepository.prototype, "getUIElementsForEdge");
      const scrollPositionSpy = spyOn(NavigationRepository.prototype, "getScrollPosition");
      const edgeModalsSpy = spyOn(NavigationRepository.prototype, "getEdgeModals");

      try {
        const result = await manager.findPath("Target");

        expect(result.found).toBe(true);
        expect(result.path.map((edge) => [edge.from, edge.to])).toEqual([
          ["Home", "PathA"],
          ["PathA", "Target"],
        ]);
        expect(uiElementsSpy).toHaveBeenCalledTimes(result.path.length);
        expect(scrollPositionSpy).toHaveBeenCalledTimes(result.path.length);
        expect(edgeModalsSpy).toHaveBeenCalledTimes(result.path.length * 2);
      } finally {
        uiElementsSpy.mockRestore();
        scrollPositionSpy.mockRestore();
        edgeModalsSpy.mockRestore();
      }
    });

    test("should return not found when no path exists", async () => {
      await manager.recordNavigationEvent(createEvent("Screen1"));

      const result = await manager.findPath("UnknownScreen");
      expect(result.found).toBe(false);
      expect(result.path).toHaveLength(0);
    });

    test("should not enrich any edges when no path exists", async () => {
      const now = Date.now();
      await manager.recordNavigationEvent(createEvent("Home", now));

      manager.recordToolCall("tapOn", { text: "A" });
      await manager.recordNavigationEvent(createEvent("A", now + 100));

      manager.recordToolCall("tapOn", { text: "B" });
      await manager.recordNavigationEvent(createEvent("B", now + 200));

      const uiElementsSpy = spyOn(NavigationRepository.prototype, "getUIElementsForEdge");
      const scrollPositionSpy = spyOn(NavigationRepository.prototype, "getScrollPosition");
      const edgeModalsSpy = spyOn(NavigationRepository.prototype, "getEdgeModals");

      try {
        const result = await manager.findPath("Missing");

        expect(result.found).toBe(false);
        expect(result.path).toHaveLength(0);
        expect(uiElementsSpy).not.toHaveBeenCalled();
        expect(scrollPositionSpy).not.toHaveBeenCalled();
        expect(edgeModalsSpy).not.toHaveBeenCalled();
      } finally {
        uiElementsSpy.mockRestore();
        scrollPositionSpy.mockRestore();
        edgeModalsSpy.mockRestore();
      }
    });

    test("should return not found when no current screen", async () => {
      const freshManager = makeFreshManager();
      await freshManager.setCurrentApp("com.test.app.pathless");

      const result = await freshManager.findPath("SomeScreen");
      expect(result.found).toBe(false);
    });
  });

  describe("getStats", () => {
    test("should return correct stats for empty graph", async () => {
      const stats = await manager.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.currentScreen).toBeNull();
      expect(stats.knownEdgeCount).toBe(0);
      expect(stats.unknownEdgeCount).toBe(0);
      expect(stats.toolCallHistorySize).toBe(0);
    });

    test("should return correct stats after navigation", async () => {
      manager.recordToolCall("tapOn", { text: "Settings" });
      await manager.recordNavigationEvent(createEvent("Home", Date.now()));
      await manager.recordNavigationEvent(createEvent("Settings", Date.now() + 100));

      const stats = await manager.getStats();
      expect(stats.nodeCount).toBe(2);
      expect(stats.edgeCount).toBe(1);
      expect(stats.currentScreen).toBe("Settings");
      expect(stats.knownEdgeCount).toBe(1);
      expect(stats.unknownEdgeCount).toBe(0);
    });

    test("returns stats for a requested non-current app without its active screen", async () => {
      await manager.setCurrentApp("com.apple.Preferences");
      await manager.recordNavigationEvent(createEvent("iOS Settings", 1000));
      await manager.recordNavigationEvent(createEvent("iOS General", 2000));

      await manager.setCurrentApp("com.google.android.settings");
      await manager.recordNavigationEvent(createEvent("Android Settings", 3000));

      expect(await manager.getStatsForApp("com.apple.Preferences")).toEqual({
        nodeCount: 2,
        edgeCount: 1,
        currentScreen: null,
        knownEdgeCount: 0,
        unknownEdgeCount: 1,
        toolCallHistorySize: 0,
      });
      expect(await manager.getStatsForApp(null)).toEqual({
        nodeCount: 0,
        edgeCount: 0,
        currentScreen: null,
        knownEdgeCount: 0,
        unknownEdgeCount: 0,
        toolCallHistorySize: 0,
      });
    });
  });

  describe("exportGraph", () => {
    test("should export empty graph correctly", async () => {
      const exported = await manager.exportGraph();
      expect(exported.appId).toBe("com.test.app");
      expect(exported.nodes).toHaveLength(0);
      expect(exported.edges).toHaveLength(0);
      expect(exported.currentScreen).toBeNull();
    });

    test("should export populated graph correctly", async () => {
      await manager.recordNavigationEvent(createEvent("Home", 1000));
      await manager.recordNavigationEvent(createEvent("Settings", 2000));

      const exported = await manager.exportGraph();
      expect(exported.appId).toBe("com.test.app");
      expect(exported.nodes).toHaveLength(2);
      expect(exported.edges).toHaveLength(1);
      expect(exported.currentScreen).toBe("Settings");

      const homeNode = exported.nodes.find((n) => n.screenName === "Home");
      expect(homeNode).toBeDefined();
      expect(homeNode!.visitCount).toBe(1);
    });

    test("exports only the requested non-current app graph", async () => {
      await manager.setCurrentApp("com.apple.Preferences");
      await manager.recordNavigationEvent(createEvent("iOS Settings", 1000));
      await manager.recordNavigationEvent(createEvent("iOS General", 2000));

      await manager.setCurrentApp("com.google.android.settings");
      await manager.recordNavigationEvent(createEvent("Android Settings", 3000));

      const exported = await manager.exportGraphForApp("com.apple.Preferences");

      expect(exported.appId).toBe("com.apple.Preferences");
      expect(exported.currentScreen).toBeNull();
      expect(exported.nodes.map((node) => node.screenName)).toEqual([
        "iOS General",
        "iOS Settings",
      ]);
      expect(exported.edges.map((edge) => [edge.from, edge.to])).toEqual([
        ["iOS Settings", "iOS General"],
      ]);
      expect(await manager.exportGraphForApp(null)).toEqual({
        appId: null,
        nodes: [],
        edges: [],
        currentScreen: null,
      });
    });
  });

  describe("exportGraphHistory", () => {
    test("should preserve the ordered nodes and edges for a navigation history", async () => {
      await manager.recordNavigationEvent(createEvent("Home", 1000));
      await manager.recordNavigationEvent(createEvent("Settings", 2000));
      await manager.recordNavigationEvent(createEvent("Profile", 3000));

      const history = await manager.exportGraphHistory();

      expect(history.nodes.map((node) => node.screenName)).toEqual(["Home", "Settings", "Profile"]);
      expect(history.edges.map((edge) => [edge.from, edge.to])).toEqual([
        ["Home", "Settings"],
        ["Settings", "Profile"],
      ]);
      expect(history.nodes.every((node) => node.id !== null)).toBe(true);
    });

    // N navigation events produce N-1 edges, so 5 events == 4 edges. Requesting a
    // page smaller than the edge count is what sets hasMore/nextCursor; an
    // off-by-one seed (edges <= limit) can never reach that boundary.
    async function seedLinearEdges(edgeCount: number): Promise<void> {
      for (let i = 0; i <= edgeCount; i++) {
        await manager.recordNavigationEvent(createEvent(`Screen${i}`, 1000 + i));
      }
    }

    interface LimitRow {
      name: string;
      limit?: number;
      expectedEdgeCount: number;
      expectNextCursor: boolean;
    }

    const limitRows: LimitRow[] = [
      {
        name: "returns every edge and no cursor when no limit is given",
        limit: undefined,
        expectedEdgeCount: 4,
        expectNextCursor: false,
      },
      {
        name: "caps the page and emits a cursor when the limit is below the edge count",
        limit: 2,
        expectedEdgeCount: 2,
        expectNextCursor: true,
      },
      {
        name: "treats a zero limit as the default page size",
        limit: 0,
        expectedEdgeCount: 4,
        expectNextCursor: false,
      },
      {
        name: "treats a negative limit as the default page size",
        limit: -5,
        expectedEdgeCount: 4,
        expectNextCursor: false,
      },
      {
        name: "floors a fractional limit toward zero",
        limit: 2.9,
        expectedEdgeCount: 2,
        expectNextCursor: true,
      },
      {
        name: "returns every edge when the limit exceeds the edge count",
        limit: 1000,
        expectedEdgeCount: 4,
        expectNextCursor: false,
      },
    ];

    test.each(limitRows)("$name", async ({ limit, expectedEdgeCount, expectNextCursor }) => {
      await seedLinearEdges(4);

      const page = await manager.exportGraphHistory({ limit });

      expect(page.edges).toHaveLength(expectedEdgeCount);
      if (expectNextCursor) {
        expect(page.nextCursor).not.toBeNull();
      } else {
        expect(page.nextCursor).toBeNull();
      }
    });

    test("walks the full history across pages using the returned cursor", async () => {
      await seedLinearEdges(4);

      const firstPage = await manager.exportGraphHistory({ limit: 2 });
      expect(firstPage.edges).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await manager.exportGraphHistory({
        limit: 2,
        cursor: firstPage.nextCursor!,
      });
      expect(secondPage.edges).toHaveLength(2);
      expect(secondPage.nextCursor).toBeNull();

      // No edge is dropped or repeated across the two pages.
      const seenIds = [
        ...firstPage.edges.map((edge) => edge.id),
        ...secondPage.edges.map((edge) => edge.id),
      ];
      expect(new Set(seenIds).size).toBe(4);
    });

    test("returns an empty envelope with the echoed cursor when no app is active", async () => {
      const freshManager = makeFreshManager();

      const page = await freshManager.exportGraphHistory({ cursor: "123:4" });

      expect(page.appId).toBeNull();
      expect(page.edges).toEqual([]);
      expect(page.nodes).toEqual([]);
      expect(page.cursor).toBe("123:4");
      expect(page.nextCursor).toBeNull();
    });

    test("rejects a malformed cursor rather than silently returning the first page", async () => {
      await seedLinearEdges(2);

      await expect(manager.exportGraphHistory({ cursor: "not-a-cursor" })).rejects.toThrow(
        /Invalid history cursor/,
      );
    });
  });

  describe("clearCurrentGraph", () => {
    test("should clear the current app's graph", async () => {
      await manager.recordNavigationEvent(createEvent("Screen1"));
      await manager.recordNavigationEvent(createEvent("Screen2"));

      await manager.clearCurrentGraph();

      // After clearing and re-setting app, should have empty graph
      await manager.setCurrentApp("com.test.app");
      expect(await manager.getKnownScreens()).toEqual([]);
    });
  });

  describe("clearAllGraphs", () => {
    test("should clear all graphs", async () => {
      await manager.setCurrentApp("app1");
      await manager.recordNavigationEvent(createEvent("Screen1"));

      await manager.setCurrentApp("app2");
      await manager.recordNavigationEvent(createEvent("Screen2"));

      await manager.clearAllGraphs();

      expect(manager.getCurrentAppId()).toBeNull();
      expect(await manager.getKnownScreens()).toEqual([]);
    });
  });

  describe("getEdgesTo", () => {
    test("should return edges leading to a screen", async () => {
      await manager.recordNavigationEvent(createEvent("Home", 1000));
      await manager.recordNavigationEvent(createEvent("Settings", 2000));
      await manager.recordNavigationEvent(createEvent("Home", 3000));
      await manager.recordNavigationEvent(createEvent("Settings", 4000));

      const edges = await manager.getEdgesTo("Settings");
      expect(edges).toHaveLength(2);
      edges.forEach((e) => expect(e.to).toBe("Settings"));
    });
  });
});

// Helper function to create navigation events
function createEvent(destination: string, timestamp?: number): NavigationEvent {
  return {
    destination,
    source: "TEST",
    arguments: {},
    metadata: {},
    timestamp: timestamp ?? Date.now(),
    sequenceNumber: 0,
  };
}

// Helper function to create navigation events with applicationId
function createEventWithApp(
  destination: string,
  applicationId: string,
  timestamp?: number,
): NavigationEvent {
  return {
    destination,
    source: "TEST",
    arguments: {},
    metadata: {},
    timestamp: timestamp ?? Date.now(),
    sequenceNumber: 0,
    applicationId,
  };
}

function createCountingDBEdge(
  id: number,
  from: string,
  to: string,
  onFromScreenRead: () => void,
): DBNavigationEdge {
  const edge = {
    id,
    app_id: "com.test.app",
    to,
    to_screen: to,
    tool_name: null,
    tool_args: null,
    timestamp: 1000,
    created_at: "2026-01-01T00:00:00.000Z",
  } as DBNavigationEdge;

  Object.defineProperty(edge, "from_screen", {
    enumerable: true,
    get: () => {
      onFromScreenRead();
      return from;
    },
  });

  return edge;
}

describe("NavigationGraphManager - Scroll Position", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;

  beforeEach(async () => {
    // Isolated in-memory DB per test (issue #2969) — no singleton getDatabase()
    // state shared with other tests, so clearAllGraphs bookkeeping is unnecessary.
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    await manager.setCurrentApp("com.test.scrollapp");
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("should update scroll position on most recent swipeOn tool call", async () => {
    // Record a swipeOn tool call
    manager.recordToolCall("swipeOn", {
      direction: "down",
      lookFor: { text: "Advanced Settings" },
    });

    // Update with scroll position
    manager.updateScrollPosition({
      targetElement: { text: "Advanced Settings" },
      direction: "down",
    });

    // Record navigation event to correlate
    await manager.recordNavigationEvent(createEvent("Settings"));
    await manager.recordNavigationEvent(createEvent("AdvancedSettings"));

    // Check that the edge has scroll position
    const edges = await manager.getEdgesFrom("Settings");
    expect(edges).toHaveLength(1);
    expect(edges[0].uiState).toBeDefined();
    expect(edges[0].uiState!.scrollPosition).toBeDefined();
    expect(edges[0].uiState!.scrollPosition!.targetElement.text).toBe("Advanced Settings");
    expect(edges[0].uiState!.scrollPosition!.direction).toBe("down");
  });

  it("should update existing uiState with scroll position", async () => {
    // Record a swipeOn tool call with existing UI state
    const existingUIState = {
      selectedElements: [{ text: "Settings Tab" }],
      destinationId: "Settings",
    };
    manager.recordToolCall(
      "swipeOn",
      {
        direction: "down",
        lookFor: { text: "Advanced Settings" },
      },
      existingUIState,
    );

    // Update with scroll position
    manager.updateScrollPosition({
      targetElement: { text: "Advanced Settings" },
      direction: "down",
    });

    // Record navigation event
    await manager.recordNavigationEvent(createEvent("Settings"));
    await manager.recordNavigationEvent(createEvent("AdvancedSettings"));

    // Check that both selected elements and scroll position exist
    const edges = await manager.getEdgesFrom("Settings");
    expect(edges).toHaveLength(1);
    expect(edges[0].uiState).toBeDefined();
    expect(edges[0].uiState!.selectedElements).toHaveLength(1);
    expect(edges[0].uiState!.selectedElements[0].text).toBe("Settings Tab");
    expect(edges[0].uiState!.scrollPosition).toBeDefined();
    expect(edges[0].uiState!.scrollPosition!.targetElement.text).toBe("Advanced Settings");
  });

  it("should handle scroll position with container and speed", async () => {
    manager.recordToolCall("swipeOn", {
      direction: "up",
      lookFor: { text: "Item" },
      container: { resourceId: "com.app:id/list" },
      speed: "slow",
    });

    manager.updateScrollPosition({
      targetElement: { text: "Item" },
      container: { resourceId: "com.app:id/list" },
      direction: "up",
      speed: "slow",
    });

    await manager.recordNavigationEvent(createEvent("Home"));
    await manager.recordNavigationEvent(createEvent("Details"));

    const edges = await manager.getEdgesFrom("Home");
    expect(edges).toHaveLength(1);
    const scrollPos = edges[0].uiState!.scrollPosition!;
    expect(scrollPos.targetElement.text).toBe("Item");
    expect(scrollPos.container!.resourceId).toBe("com.app:id/list");
    expect(scrollPos.direction).toBe("up");
    expect(scrollPos.speed).toBe("slow");
  });

  it("should not update if no swipeOn tool call exists", () => {
    // Record a different tool call
    manager.recordToolCall("tapOn", { text: "Button" });

    // Try to update scroll position
    manager.updateScrollPosition({
      targetElement: { text: "Element" },
      direction: "down",
    });

    // Should not throw, just log and return
    // No assertion needed, just verify it doesn't crash
  });

  it("should update most recent swipeOn when multiple exist", async () => {
    // Record multiple swipeOn calls
    manager.recordToolCall("swipeOn", {
      direction: "down",
      lookFor: { text: "First" },
    });

    manager.recordToolCall("swipeOn", {
      direction: "up",
      lookFor: { text: "Second" },
    });

    // Update should affect the most recent one
    manager.updateScrollPosition({
      targetElement: { text: "Second" },
      direction: "up",
    });

    await manager.recordNavigationEvent(createEvent("Screen1"));
    await manager.recordNavigationEvent(createEvent("Screen2"));

    const edges = await manager.getEdgesFrom("Screen1");
    expect(edges).toHaveLength(1);
    expect(edges[0].uiState!.scrollPosition!.targetElement.text).toBe("Second");
  });
});

describe("NavigationGraphManager - Named Nodes Only", () => {
  let harness: InMemoryNavManagerHarness;
  let manager: NavigationGraphManager;

  beforeEach(async () => {
    // Isolated in-memory DB per test (issue #2969) — clearCurrentGraph/reset
    // bookkeeping is unnecessary because nothing is shared across tests.
    harness = await installInMemoryNavManager();
    manager = harness.manager;
    await manager.setCurrentApp("com.test.namedapp");
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("recordHierarchyNavigation", () => {
    it("should NOT create nodes from hierarchy events alone", async () => {
      // Record hierarchy navigation without any SDK events
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "abc123def456",
        timestamp: Date.now(),
        packageName: "com.test.namedapp",
      });

      // Should have no nodes since app has no named nodes yet
      const screens = await manager.getKnownScreens();
      expect(screens).toHaveLength(0);
    });

    it("should correlate fingerprint during active navigation window", async () => {
      const now = Date.now();

      // First, create a named node via SDK event
      await manager.recordNavigationEvent(createEvent("HomeScreen", now));

      // Then, hierarchy event within 1000ms window should correlate
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_home_123",
        fingerprintData: JSON.stringify({ layout: "home" }),
        timestamp: now + 500, // Within 1000ms window
        packageName: "com.test.namedapp",
      });

      // Should still have only one node (HomeScreen)
      const screens = await manager.getKnownScreens();
      expect(screens).toHaveLength(1);
      expect(screens[0]).toBe("HomeScreen");

      // The fingerprint should be correlated to this node
      // Future hierarchy events with same fingerprint should update this node
    });

    it("should create suggestion when fingerprint is outside navigation window", async () => {
      const now = Date.now();

      // First, create a named node via SDK event
      await manager.recordNavigationEvent(createEvent("HomeScreen", now));

      // Hierarchy event outside the 1000ms window should create suggestion
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_settings_456",
        fingerprintData: JSON.stringify({ layout: "settings" }),
        timestamp: now + 1500, // Outside 1000ms window
        packageName: "com.test.namedapp",
      });

      // Should have suggestions
      const suggestions = await manager.getSuggestions();
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions[0].fingerprintHash).toBe("fingerprint_settings_456");
    });

    it("should update existing node when fingerprint is already correlated", async () => {
      const now = Date.now();

      // Create named node and correlate fingerprint
      await manager.recordNavigationEvent(createEvent("HomeScreen", now));
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_home_123",
        timestamp: now + 500,
        packageName: "com.test.namedapp",
      });

      // Navigate away
      await manager.recordNavigationEvent(createEvent("Settings", now + 2000));

      // Now hierarchy event with same fingerprint should update HomeScreen
      // Using timestamp well outside the active navigation window (>1000ms)
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_home_123",
        timestamp: now + 5000, // 3000ms after Settings navigation, well outside window
        packageName: "com.test.namedapp",
      });

      // Should update current screen to HomeScreen
      expect(manager.getCurrentScreen()).toBe("HomeScreen");

      // Check visit count increased
      const node = await manager.getNode("HomeScreen");
      expect(node).toBeDefined();
      expect(node!.visitCount).toBe(2);
    });
  });

  describe("getSuggestions and promoteSuggestion", () => {
    it("should return empty suggestions for app without named nodes", async () => {
      // No SDK events, no named nodes
      const suggestions = await manager.getSuggestions();
      expect(suggestions).toHaveLength(0);
    });

    it("should promote suggestion to named node", async () => {
      const now = Date.now();

      // Create a named node so app has named nodes
      await manager.recordNavigationEvent(createEvent("HomeScreen", now));

      // Create a suggestion by sending hierarchy event outside window
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_settings_456",
        fingerprintData: JSON.stringify({ layout: "settings" }),
        timestamp: now + 1500, // Outside window
        packageName: "com.test.namedapp",
      });

      // Get suggestions
      const suggestions = await manager.getSuggestions();
      expect(suggestions.length).toBeGreaterThanOrEqual(1);

      const settingsSuggestion = suggestions.find(
        (s) => s.fingerprintHash === "fingerprint_settings_456",
      );
      expect(settingsSuggestion).toBeDefined();

      // Promote the suggestion
      await manager.promoteSuggestion(settingsSuggestion!.id, "SettingsScreen");

      // Should now have two named nodes
      const screens = await manager.getKnownScreens();
      expect(screens).toContain("HomeScreen");
      expect(screens).toContain("SettingsScreen");

      // Suggestion should no longer appear in unpromoted list
      const remainingSuggestions = await manager.getSuggestions();
      const stillPresent = remainingSuggestions.find(
        (s) => s.fingerprintHash === "fingerprint_settings_456",
      );
      expect(stillPresent).toBeUndefined();
    });

    it("should recognize promoted fingerprint on future hierarchy events", async () => {
      const now = Date.now();

      // Create named node and suggestion
      await manager.recordNavigationEvent(createEvent("HomeScreen", now));
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_settings_456",
        fingerprintData: JSON.stringify({ layout: "settings" }),
        timestamp: now + 1500, // Outside HomeScreen's window
        packageName: "com.test.namedapp",
      });

      // Promote suggestion
      const suggestions = await manager.getSuggestions();
      const settingsSuggestion = suggestions.find(
        (s) => s.fingerprintHash === "fingerprint_settings_456",
      );
      await manager.promoteSuggestion(settingsSuggestion!.id, "SettingsScreen");

      // Navigate somewhere else
      await manager.recordNavigationEvent(createEvent("Profile", now + 3000));

      // Now hierarchy event with same fingerprint should update SettingsScreen
      // Using timestamp well outside the active navigation window
      await manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fingerprint_settings_456",
        timestamp: now + 6000, // 3000ms after Profile navigation, well outside window
        packageName: "com.test.namedapp",
      });

      // Current screen should be SettingsScreen
      expect(manager.getCurrentScreen()).toBe("SettingsScreen");
    });
  });
});

// getInstanceForSession() constructs unbound managers on the process-wide
// getDatabase() singleton — there is no in-memory injection seam for session
// instances — so this block (alone in this file) backs that singleton with a
// fresh temp-dir file DB (see useTempFileDatabase docs). Every assertion here is
// on in-memory instance state (identity, currentAppId); the file DB only absorbs
// incidental awaited writes (setCurrentApp's getOrCreateApp), so no test depends
// on leftover DB state and cold runs stay deterministic (issue #2969).
describe("NavigationGraphManager - Multi-session isolation", () => {
  let tempFileDb: TempFileDatabaseHandle;

  beforeAll(async () => {
    tempFileDb = await useTempFileDatabase();
    await runMigrations();
  });

  afterAll(async () => {
    await tempFileDb.cleanup();
  });

  beforeEach(() => {
    NavigationGraphManager.resetInstance();
  });

  afterEach(() => {
    NavigationGraphManager.resetInstance();
  });

  test("getInstanceForSession returns independent instances", async () => {
    const sessionA = NavigationGraphManager.getInstanceForSession("session-A");
    const sessionB = NavigationGraphManager.getInstanceForSession("session-B");

    await sessionA.setCurrentApp("com.app.a");
    await sessionB.setCurrentApp("com.app.b");

    expect(sessionA.getCurrentAppId()).toBe("com.app.a");
    expect(sessionB.getCurrentAppId()).toBe("com.app.b");
  });

  test("getInstanceForSession returns same instance for same sessionId", () => {
    const first = NavigationGraphManager.getInstanceForSession("session-X");
    const second = NavigationGraphManager.getInstanceForSession("session-X");
    expect(first).toBe(second);
  });

  test("recordToolCall on session A does not appear in session B", () => {
    const sessionA = NavigationGraphManager.getInstanceForSession("session-A");
    const sessionB = NavigationGraphManager.getInstanceForSession("session-B");

    sessionA.recordToolCall("tapOn", { element: "button" });

    // Session A should have the tool call in history
    // Session B should have no tool calls
    // We verify isolation by checking that they are different instances
    expect(sessionA).not.toBe(sessionB);
  });

  test("releaseSession cleans up the instance", async () => {
    const session = NavigationGraphManager.getInstanceForSession("session-cleanup");
    await session.setCurrentApp("com.test.cleanup");
    expect(session.getCurrentAppId()).toBe("com.test.cleanup");

    NavigationGraphManager.releaseSession("session-cleanup");

    // Getting the session again should return a fresh instance
    const fresh = NavigationGraphManager.getInstanceForSession("session-cleanup");
    expect(fresh.getCurrentAppId()).toBeNull();
  });

  test("releaseSession does not affect other sessions", async () => {
    const sessionA = NavigationGraphManager.getInstanceForSession("session-A");
    const sessionB = NavigationGraphManager.getInstanceForSession("session-B");

    await sessionA.setCurrentApp("com.app.a");
    await sessionB.setCurrentApp("com.app.b");

    NavigationGraphManager.releaseSession("session-A");

    expect(sessionB.getCurrentAppId()).toBe("com.app.b");
  });

  test("resetInstance clears both singleton and session instances", async () => {
    NavigationGraphManager.getInstanceForSession("session-reset");
    const singleton = NavigationGraphManager.getInstance();
    await singleton.setCurrentApp("com.singleton");

    NavigationGraphManager.resetInstance();

    const freshSingleton = NavigationGraphManager.getInstance();
    expect(freshSingleton.getCurrentAppId()).toBeNull();

    const freshSession = NavigationGraphManager.getInstanceForSession("session-reset");
    expect(freshSession.getCurrentAppId()).toBeNull();
  });

  // #4932: the resource layer attaches its notify callback only to the global
  // instance, so before this fix a session-scoped write refreshed no navigation
  // resource. setSessionGraphUpdateListener wires the callback into every session
  // instance getInstanceForSession mints.
  test("session-scoped writes fire the registered session graph-update listener (#4932)", async () => {
    let notified = 0;
    NavigationGraphManager.setSessionGraphUpdateListener(() => {
      notified++;
    });

    const session = NavigationGraphManager.getInstanceForSession("session-notify");
    // setCurrentApp is a session-scoped write that fires notifyGraphUpdated.
    await session.setCurrentApp("com.app.notify");

    expect(notified).toBe(1);
  });

  test("resetInstance clears the process-wide session graph-update listener (#4932)", async () => {
    let notified = 0;
    NavigationGraphManager.setSessionGraphUpdateListener(() => {
      notified++;
    });

    NavigationGraphManager.resetInstance();

    const session = NavigationGraphManager.getInstanceForSession("session-after-reset");
    await session.setCurrentApp("com.app.after-reset");

    expect(notified).toBe(0);
  });
});

/**
 * A TestCoverageRepository that throws on recordEdgeTraversal to simulate a
 * mid-sequence write failure inside recordNavigationEvent's transaction. It also
 * overrides withExecutor so the throwing behavior survives the manager rebinding
 * the repo to the transaction executor (a base-class instance would silently drop
 * the override and run recordNodeVisit on the singleton connection — a deadlock).
 */
class ThrowingEdgeTraversalCoverageRepo extends TestCoverageRepository {
  constructor(
    private readonly injectedTimer: Timer,
    db?: Kysely<Database>,
  ) {
    super(injectedTimer, db);
  }

  override withExecutor(executor: Kysely<Database>): TestCoverageRepository {
    return new ThrowingEdgeTraversalCoverageRepo(this.injectedTimer, executor);
  }

  override async recordEdgeTraversal(): Promise<void> {
    throw new Error("injected recordEdgeTraversal failure");
  }
}

describe("NavigationGraphManager - recordNavigationEvent transaction (#2791)", () => {
  const APP_ID = "com.test.txn";

  let db: Kysely<Database>;
  let telemetrySpy: ReturnType<typeof spyOn>;

  async function countNodes(screenName?: string): Promise<number> {
    let q = db
      .selectFrom("navigation_nodes")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("app_id", "=", APP_ID);
    if (screenName !== undefined) {
      q = q.where("screen_name", "=", screenName);
    }
    const row = await q.executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async function countEdges(): Promise<number> {
    const row = await db
      .selectFrom("navigation_edges")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("app_id", "=", APP_ID)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async function countEdgeCoverageRows(): Promise<number> {
    const row = await db
      .selectFrom("test_edge_coverage")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async function sessionTotals(sessionId: number): Promise<{ nodes: number; edges: number }> {
    const row = await db
      .selectFrom("test_coverage_sessions")
      .select(["total_nodes_visited", "total_edges_traversed"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return {
      nodes: Number(row.total_nodes_visited),
      edges: Number(row.total_edges_traversed),
    };
  }

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
    // Replace the telemetry singleton method so recordNavigationEvent's
    // fire-and-forget telemetry push is observable and never touches a real DB.
    TelemetryRecorder.resetInstance();
    telemetrySpy = spyOn(
      TelemetryRecorder.getInstance(),
      "recordNavigationEvent",
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    telemetrySpy.mockRestore();
    TelemetryRecorder.resetInstance();
    await db.destroy();
  });

  function makeManager(coverage: TestCoverageRepository): NavigationGraphManager {
    const navRepo = new NavigationRepository(db);
    return NavigationGraphManager.createForTesting(navRepo, coverage);
  }

  test("happy path persists node + visit + edge + traversal rows", async () => {
    const coverage = new TestCoverageRepository(defaultTimer, db);
    const manager = makeManager(coverage);
    await manager.setCurrentApp(APP_ID);
    await manager.startTestSession("session-happy");

    await manager.recordNavigationEvent(createEvent("Screen1", 1000));
    await manager.recordNavigationEvent(createEvent("Screen2", 2000));

    expect(await countNodes("Screen1")).toBe(1);
    expect(await countNodes("Screen2")).toBe(1);
    expect(await countEdges()).toBe(1);
    // Two node visits + one edge traversal recorded for the session.
    const nodeCoverage = await coverage.getCoveredNodes(manager.getActiveTestSession()!.id);
    expect(nodeCoverage.length).toBe(2);
    expect(await countEdgeCoverageRows()).toBe(1);

    expect(manager.getCurrentScreen()).toBe("Screen2");
    expect(telemetrySpy).toHaveBeenCalledTimes(2);
  });

  test("rolls back all rows when a mid-sequence write throws", async () => {
    const coverage = new ThrowingEdgeTraversalCoverageRepo(defaultTimer, db);
    const manager = makeManager(coverage);
    await manager.setCurrentApp(APP_ID);
    await manager.startTestSession("session-rollback");

    // First event: no edge (previousScreen null) → recordEdgeTraversal not hit → commits.
    await manager.recordNavigationEvent(createEvent("Screen1", 1000));
    expect(manager.getCurrentScreen()).toBe("Screen1");

    const sessionId = manager.getActiveTestSession()!.id;
    const nodesBefore = await countNodes();
    const edgesBefore = await countEdges();
    const edgeCoverageBefore = await countEdgeCoverageRows();
    const totalsBefore = await sessionTotals(sessionId);
    telemetrySpy.mockClear();

    let notifyCount = 0;
    manager.setGraphUpdateListener(() => {
      notifyCount++;
    });

    // Second event creates an edge, so recordEdgeTraversal fires and throws.
    await expect(manager.recordNavigationEvent(createEvent("Screen2", 2000))).rejects.toThrow(
      "injected recordEdgeTraversal failure",
    );

    // Zero new node/edge/coverage rows persisted for the failed event.
    expect(await countNodes()).toBe(nodesBefore);
    expect(await countNodes("Screen2")).toBe(0);
    expect(await countEdges()).toBe(edgesBefore);
    expect(await countEdgeCoverageRows()).toBe(edgeCoverageBefore);

    // The session total counters (bumped by recordNodeVisit before the throw)
    // are rolled back too — they run on the same transaction.
    expect(await sessionTotals(sessionId)).toEqual(totalsBefore);

    // In-memory field rollback invariant: currentScreen (and therefore the
    // together-assigned activeNavigation) is unchanged from before the call.
    expect(manager.getCurrentScreen()).toBe("Screen1");

    // Side effects are NOT invoked when the transaction rolls back.
    expect(telemetrySpy).not.toHaveBeenCalled();
    expect(notifyCount).toBe(0);
  });

  test("side effects fire only after the transaction commits", async () => {
    const coverage = new TestCoverageRepository(defaultTimer, db);
    const manager = makeManager(coverage);
    await manager.setCurrentApp(APP_ID);

    // touchApp is the final write inside the transaction. Record the number of
    // times it had run at EVERY notify/telemetry fire (not just the last), so a
    // stray side effect firing BEFORE the transaction — when touchApp's call count
    // is still 0 — is caught rather than masked by a later post-commit fire.
    const touchSpy = spyOn(NavigationRepository.prototype, "touchApp");

    // try/finally so a throwing assertion below cannot leak this prototype spy into
    // sibling suites in the same bun test process (#3075 fold-in from #3090 review).
    try {
      const notifyTouchCounts: number[] = [];
      manager.setGraphUpdateListener(() => {
        notifyTouchCounts.push(touchSpy.mock.calls.length);
      });

      const telemetryTouchCounts: number[] = [];
      telemetrySpy.mockImplementation(async () => {
        telemetryTouchCounts.push(touchSpy.mock.calls.length);
      });

      await manager.recordNavigationEvent(createEvent("Screen1", 1000));

      // touchApp runs exactly once (one event), and notify + telemetry each fire
      // exactly once, each AFTER that final in-transaction write completed — never
      // inside the transaction and never before it.
      expect(touchSpy).toHaveBeenCalledTimes(1);
      expect(notifyTouchCounts).toEqual([1]);
      expect(telemetryTouchCounts).toEqual([1]);
    } finally {
      touchSpy.mockRestore();
    }
  });

  test("does not deadlock a concurrent writer on the shared connection", async () => {
    const coverage = new TestCoverageRepository(defaultTimer, db);
    const manager = makeManager(coverage);
    await manager.setCurrentApp(APP_ID);
    await manager.recordNavigationEvent(createEvent("Screen1", 1000));

    // A second repository bound to the SAME connection issues an independent write
    // concurrently with the transactional recordNavigationEvent. If the transaction
    // held the connection past its body (or a stray singleton query escaped it), the
    // in-process mutex would deadlock with no busy_timeout escape.
    const otherRepo = new NavigationRepository(db);

    const work = Promise.all([
      manager.recordNavigationEvent(createEvent("Screen2", 2000)),
      otherRepo.getOrCreateApp("com.test.other"),
      otherRepo.getOrCreateNode("com.test.other", "OtherScreen", 3000),
    ]);

    const timeout = new Promise((_resolve, reject) =>
      defaultTimer.setTimeout(
        () => reject(new Error("deadlock: concurrent writers did not complete")),
        2000,
      ),
    );

    await Promise.race([work, timeout]);

    // Both writers succeeded.
    expect(await countEdges()).toBe(1);
    const otherNode = await otherRepo.getNode("com.test.other", "OtherScreen");
    expect(otherNode).toBeDefined();
  });

  describe("graph-update listener isolation (#4171)", () => {
    test("still notifies later listeners after an earlier listener throws", async () => {
      const manager = makeManager(new TestCoverageRepository(defaultTimer, db));
      await manager.setCurrentApp(APP_ID);

      const calls: string[] = [];
      manager.setGraphUpdateListener(() => {
        calls.push("first");
        throw new Error("listener boom");
      });
      manager.setGraphUpdateListener(() => {
        calls.push("second");
      });

      // Switching the app fires notifyGraphUpdated once. A per-listener try/catch
      // must isolate the first listener's throw so the second still runs; without
      // it, the throw would propagate out of setCurrentApp and starve later
      // listeners.
      await manager.setCurrentApp("com.test.other");

      expect(calls).toEqual(["first", "second"]);
    });

    test("stops notifying every listener once they are cleared with null", async () => {
      const manager = makeManager(new TestCoverageRepository(defaultTimer, db));
      await manager.setCurrentApp(APP_ID);

      const calls: number[] = [];
      manager.setGraphUpdateListener(() => calls.push(1));
      manager.setGraphUpdateListener(null);

      await manager.setCurrentApp("com.test.other");

      expect(calls).toEqual([]);
    });
  });
});

describe("NavigationGraphManager - shared-connection guard (#2968)", () => {
  const APP_ID = "com.test.guard";

  let navDb: Kysely<Database>;
  let coverageDb: Kysely<Database>;
  let telemetrySpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    navDb = await createTestDatabase({ foreignKeys: true });
    coverageDb = await createTestDatabase({ foreignKeys: true });
    TelemetryRecorder.resetInstance();
    telemetrySpy = spyOn(
      TelemetryRecorder.getInstance(),
      "recordNavigationEvent",
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    telemetrySpy.mockRestore();
    TelemetryRecorder.resetInstance();
    await navDb.destroy();
    await coverageDb.destroy();
  });

  async function countNodes(db: Kysely<Database>): Promise<number> {
    const row = await db
      .selectFrom("navigation_nodes")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("app_id", "=", APP_ID)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async function countNodeCoverage(db: Kysely<Database>): Promise<number> {
    const row = await db
      .selectFrom("test_node_coverage")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  test("throws a clear error when the coverage repo is bound to a different connection", async () => {
    const navRepo = new NavigationRepository(navDb);
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    await expect(
      manager.recordNavigationEvent(createEvent("Screen1", 1000)),
    ).rejects.toBeInstanceOf(ActionableError);
  });

  test("names the connection-identity invariant in the error message", async () => {
    const navRepo = new NavigationRepository(navDb);
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    await expect(manager.recordNavigationEvent(createEvent("Screen1", 1000))).rejects.toThrow(
      /different database connections/i,
    );
  });

  test("guard fires before the transaction opens — the navigation write is not applied", async () => {
    const navRepo = new NavigationRepository(navDb);
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    await manager.recordNavigationEvent(createEvent("Screen1", 1000)).catch(() => undefined);

    // Without the guard, getOrCreateNode would commit a node on the navigation
    // connection; the guard prevents the transaction from ever opening.
    expect(await countNodes(navDb)).toBe(0);
    // currentScreen stays null — the post-commit field assignment never runs.
    expect(manager.getCurrentScreen()).toBeNull();
    // Telemetry side effect never fires on a guard failure.
    expect(telemetrySpy).not.toHaveBeenCalled();
  });

  test("with an active test session, fails with ActionableError rather than a downstream split-write error", async () => {
    // With a session active, the coverage enlistment path (recordNodeVisit) is
    // reachable inside the transaction. If the guard were absent, withExecutor would
    // rebind the coverage repo to the navigation trx and recordNodeVisit would write a
    // test_node_coverage row referencing a session that lives only on coverageDb — a
    // FK violation surfacing as an opaque SqliteError. The guard turns that into a
    // clear, pre-transaction ActionableError instead.
    const navRepo = new NavigationRepository(navDb);
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);
    // startTestSession writes the session on the coverage connection, whose
    // test_coverage_sessions.app_id FKs navigation_apps — seed the app there.
    await coverageDb
      .insertInto("navigation_apps")
      .values({ app_id: APP_ID, updated_at: "2024-01-01T00:00:00.000Z" })
      .execute();
    await manager.startTestSession("session-guard");

    await expect(
      manager.recordNavigationEvent(createEvent("Screen1", 1000)),
    ).rejects.toBeInstanceOf(ActionableError);

    // No coverage row leaked onto the navigation connection; the session row stays
    // on its own connection.
    expect(await countNodeCoverage(navDb)).toBe(0);
    expect(await countNodes(navDb)).toBe(0);
  });

  test("allows the write when both repos share the same connection", async () => {
    const navRepo = new NavigationRepository(navDb);
    const coverage = new TestCoverageRepository(defaultTimer, navDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    await manager.recordNavigationEvent(createEvent("Screen1", 1000));

    expect(await countNodes(navDb)).toBe(1);
    expect(manager.getCurrentScreen()).toBe("Screen1");
  });

  // ---- recordHierarchyNavigation Case 1 (#2980) ----
  // #2968/PR #2987 transactionalized recordHierarchyNavigation Case 1 and added the
  // assertSharedConnection() call, but the rollback tests seed with a shared
  // connection so the guard never fires — deleting it kept the suite green. These
  // tests pin the guard in the sibling path: a foreign-bound coverage repo must fail
  // loudly here exactly as it does for recordNavigationEvent.

  async function homeVisitCount(db: Kysely<Database>): Promise<number> {
    const row = await db
      .selectFrom("navigation_nodes")
      .select(["visit_count"])
      .where("app_id", "=", APP_ID)
      .where("screen_name", "=", "Home")
      .executeTakeFirst();
    return Number(row?.visit_count ?? 0);
  }

  // Seed a named node "Home" + a correlated fingerprint "fp_home" on the navigation
  // connection so a later hierarchy event carrying "fp_home" resolves via
  // getNodeByFingerprint into Case 1 (the existing-node branch), where the guard is
  // asserted before the transaction opens.
  async function seedCorrelatedHome(): Promise<NavigationRepository> {
    const navRepo = new NavigationRepository(navDb);
    await navRepo.getOrCreateApp(APP_ID);
    const home = await navRepo.getOrCreateNode(APP_ID, "Home", 1000);
    await navRepo.getOrCreateFingerprint(
      APP_ID,
      home.id,
      "fp_home",
      JSON.stringify({ layout: "home" }),
      1000,
    );
    return navRepo;
  }

  test("recordHierarchyNavigation Case 1 throws ActionableError on a foreign-bound coverage repo", async () => {
    const navRepo = await seedCorrelatedHome();
    // Coverage repo bound to a DIFFERENT connection — the foreign bind the guard exists to catch.
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    let notifyCount = 0;
    manager.setGraphUpdateListener(() => {
      notifyCount++;
    });

    const visitsBefore = await homeVisitCount(navDb);

    // The event's fingerprint already resolves to a named node, so this takes Case 1
    // (the existing-node branch, checked before the active-navigation window). The
    // guard must fire there BEFORE the transaction opens, mirroring recordNavigationEvent.
    await expect(
      manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fp_home",
        timestamp: 900000,
        packageName: APP_ID,
      }),
    ).rejects.toBeInstanceOf(ActionableError);

    // The node-visit increment never applied (the transaction never opened); no
    // coverage row leaked onto the navigation connection; the post-commit side
    // effects (currentScreen assignment, notifyGraphUpdated) never ran.
    expect(await homeVisitCount(navDb)).toBe(visitsBefore);
    expect(await countNodeCoverage(navDb)).toBe(0);
    expect(manager.getCurrentScreen()).toBeNull();
    expect(notifyCount).toBe(0);
  });

  test("recordHierarchyNavigation Case 1 guard names the connection-identity invariant", async () => {
    const navRepo = await seedCorrelatedHome();
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    await expect(
      manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fp_home",
        timestamp: 900000,
        packageName: APP_ID,
      }),
    ).rejects.toThrow(/different database connections/i);
  });

  test("recordHierarchyNavigation Case 1 with an active test session fails with ActionableError, not a downstream split-write error", async () => {
    // With a session active the coverage-enlistment write (recordNodeVisit) becomes
    // reachable inside the transaction. Without the guard, withExecutor would rebind
    // the coverage repo onto the navigation trx and recordNodeVisit would write a
    // test_node_coverage row referencing a session that lives only on coverageDb — an
    // FK violation surfacing as an opaque SqliteError. The guard turns that into a
    // clear, pre-transaction ActionableError instead. This makes the coverage-row
    // assertion discriminating (the split path is genuinely reachable here) and mirrors
    // the recordNavigationEvent twin above.
    const navRepo = await seedCorrelatedHome();
    const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);
    // startTestSession writes the session on the coverage connection, whose
    // test_coverage_sessions.app_id FKs navigation_apps — seed the app there.
    await coverageDb
      .insertInto("navigation_apps")
      .values({ app_id: APP_ID, updated_at: "2024-01-01T00:00:00.000Z" })
      .execute();
    await manager.startTestSession("session-hier-guard");

    const visitsBefore = await homeVisitCount(navDb);

    await expect(
      manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fp_home",
        timestamp: 900000,
        packageName: APP_ID,
      }),
    ).rejects.toBeInstanceOf(ActionableError);

    // No coverage row leaked onto the navigation connection and the visit increment
    // never applied — the guard stopped the transaction before it opened.
    expect(await countNodeCoverage(navDb)).toBe(0);
    expect(await homeVisitCount(navDb)).toBe(visitsBefore);
  });
});

// #3075: the assertSharedConnection() + runInTransaction + bind-both-repos preamble
// used to be inlined in both recordNavigationEvent and recordHierarchyNavigation
// Case 1 (two sites, two copies of the guard). It is now consolidated into a single
// shared helper that owns the invariant, so a future third both-repos writer cannot
// forget the guard. These tests pin that consolidation structurally (the guard is
// invoked from exactly one place) and behaviorally (the generalized error names no
// specific method). The teeth from the guard suite above are preserved: because both
// call sites now flow through the single guard, deleting that one call fails the
// foreign-bound-connection tests for BOTH methods, not just one.
describe("NavigationGraphManager - shared two-repo transaction helper (#3075)", () => {
  const managerSource = readFileSync(
    join(import.meta.dir, "../../../src/features/navigation/NavigationGraphManager.ts"),
    "utf8",
  );

  test("assertSharedConnection is invoked from exactly one place (the shared helper)", () => {
    // Two inline copies (the pre-#3075 state) would make this 2 and fail. Consolidating
    // into a single helper is what makes the guard un-forgettable for a future site:
    // there is one call, and both both-repos writers route through it.
    const callSites = managerSource.match(/this\.assertSharedConnection\(\)/g) ?? [];
    expect(callSites.length).toBe(1);
  });

  test("both both-repos writers delegate to the shared helper (no inline runInTransaction bind-both)", () => {
    // The helper name is asserted from the issue's proposed shape; both writers call it.
    const delegations = managerSource.match(/this\.runBothReposInTransaction[<(]/g) ?? [];
    expect(delegations.length).toBe(2);
  });

  test("guard error message names no specific method (generalized in #3075)", async () => {
    // A foreign-bound coverage repo trips the guard. The message must still name the
    // connection-identity invariant (the stable substring guard tests match on) but must
    // NOT name a single method — the guard now fires from more than one call site.
    const navDb = await createTestDatabase({ foreignKeys: true });
    const coverageDb = await createTestDatabase({ foreignKeys: true });
    try {
      const navRepo = new NavigationRepository(navDb);
      const coverage = new TestCoverageRepository(defaultTimer, coverageDb);
      const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
      await manager.setCurrentApp("com.test.msg");

      let caught: unknown;
      await manager.recordNavigationEvent(createEvent("Screen1", 1000)).catch((e) => {
        caught = e;
      });

      expect(caught).toBeInstanceOf(ActionableError);
      const message = (caught as Error).message;
      expect(message).toMatch(/different database connections/i);
      expect(message).not.toMatch(/recordNavigationEvent/);
      expect(message).not.toMatch(/recordHierarchyNavigation/);
    } finally {
      await navDb.destroy();
      await coverageDb.destroy();
    }
  });
});

/**
 * Extract the body of every `runBothReposInTransaction(async (...) => { ... })`
 * arrow callback from the given source, by brace-matching from the callback's
 * opening `{` to its matching `}`. Returning the *spans* (not a whole-file
 * substring match) is what keeps the side-effect guard from false-positiving on
 * the legitimate post-commit side effects that already sit OUTSIDE these
 * callbacks (issue #3129). A naive whole-file scan for `this.notifyGraphUpdated(`
 * would flag the correct code.
 */
function extractRunBothReposCallbackBodies(source: string): string[] {
  const bodies: string[] = [];
  // Match up through the arrow's opening brace of the callback: allow an optional
  // `async`, an arbitrary parameter list, and the `=> {` that opens the body.
  const opener = /runBothReposInTransaction\s*(?:<[^>]*>)?\s*\(\s*async\s*\([^)]*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    // Start scanning at the `{` that opened the callback body.
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i++) {
      const ch = source[i];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
    }
    // `i` now points just past the matching `}`; body excludes both braces.
    bodies.push(source.slice(match.index + match[0].length, i - 1));
  }
  return bodies;
}

describe("NavigationGraphManager - side-effects-outside-fn guard (#3129)", () => {
  const managerSource = readFileSync(
    join(import.meta.dir, "../../../src/features/navigation/NavigationGraphManager.ts"),
    "utf8",
  );

  // Known post-commit side effects that MUST stay OUTSIDE the transaction callback
  // (never on rollback, never holding the exclusive connection across non-DB IO).
  // See the helper docstring + both call-site comments in NavigationGraphManager.ts.
  const FORBIDDEN_SIDE_EFFECTS = [
    "this.notifyGraphUpdated(",
    "TelemetryRecorder",
    "this.activeNavigation =",
    "this.currentScreen =",
  ];

  test("the source has exactly two helper callbacks to scan", () => {
    // Sanity check the extractor tracks the two known call sites; if a third both-repos
    // writer is added, this line surfaces it so its callback is scanned too.
    const bodies = extractRunBothReposCallbackBodies(managerSource);
    expect(bodies.length).toBe(2);
  });

  test("no known side-effect call appears inside any runBothReposInTransaction callback", () => {
    const bodies = extractRunBothReposCallbackBodies(managerSource);
    for (const body of bodies) {
      for (const sideEffect of FORBIDDEN_SIDE_EFFECTS) {
        expect(body).not.toContain(sideEffect);
      }
    }
  });

  test("TDD teeth: the guard fires when a side effect is placed inside a callback", () => {
    // Simulate a future author writing `this.notifyGraphUpdated()` inside a callback body.
    const bodies = extractRunBothReposCallbackBodies(managerSource);
    expect(bodies.length).toBeGreaterThan(0);
    const mutated = bodies[0] + "\n        this.notifyGraphUpdated();\n";
    const tripped = FORBIDDEN_SIDE_EFFECTS.some((s) => mutated.includes(s));
    expect(tripped).toBe(true);
  });

  test("the extractor isolates the callback body from surrounding post-commit code", () => {
    // The real post-commit `this.notifyGraphUpdated()` / `this.currentScreen =` calls sit
    // OUTSIDE the callbacks in the file; if the brace-matcher over-ran past the closing `}`
    // it would swallow them and the side-effect test would false-positive. Assert those
    // legitimate calls exist in the file but NOT in any extracted body.
    expect(managerSource).toContain("this.notifyGraphUpdated();");
    const bodies = extractRunBothReposCallbackBodies(managerSource);
    for (const body of bodies) {
      expect(body).not.toContain("this.notifyGraphUpdated();");
    }
  });
});

/**
 * A TestCoverageRepository that throws on recordNodeVisit to simulate a
 * mid-sequence write failure inside recordHierarchyNavigation's Case-1
 * transaction. Overrides withExecutor so the throw survives the manager
 * rebinding the repo onto the transaction executor.
 */
class ThrowingNodeVisitCoverageRepo extends TestCoverageRepository {
  constructor(
    private readonly injectedTimer: Timer,
    db?: Kysely<Database>,
  ) {
    super(injectedTimer, db);
  }

  override withExecutor(executor: Kysely<Database>): TestCoverageRepository {
    return new ThrowingNodeVisitCoverageRepo(this.injectedTimer, executor);
  }

  override async recordNodeVisit(): Promise<void> {
    throw new Error("injected recordNodeVisit failure");
  }
}

/**
 * A NavigationRepository whose promoteSuggestion creates the fingerprint (a real
 * write) and then throws, simulating the suggestion-link UPDATE failing AFTER the
 * node + fingerprint already exist — the exact "orphaned node/fingerprint" partial
 * write #2968 describes. Overrides withExecutor so the throw survives the manager
 * rebinding the repo onto the transaction executor. Returns Promise<never> (only
 * ever throws), which is assignable to the base method's return type.
 */
class ThrowingLinkPromoteRepo extends NavigationRepository {
  constructor(
    private readonly appId: string,
    db?: Kysely<Database>,
  ) {
    super(db);
  }

  override withExecutor(executor: Kysely<Database>): NavigationRepository {
    return new ThrowingLinkPromoteRepo(this.appId, executor);
  }

  override async promoteSuggestion(
    _suggestionId: number,
    nodeId: number,
    timestamp: number,
  ): Promise<never> {
    // Create the fingerprint first (a real write on the transaction), then throw as
    // if the suggestion-link UPDATE failed.
    await this.getOrCreateFingerprint(this.appId, nodeId, "fp_orphan", "{}", timestamp);
    throw new Error("injected suggestion-link failure");
  }
}

describe("NavigationGraphManager - promoteSuggestion transaction (#2968)", () => {
  const APP_ID = "com.test.promo";

  let db: Kysely<Database>;
  let telemetrySpy: ReturnType<typeof spyOn>;

  async function countNodes(screenName?: string): Promise<number> {
    let q = db
      .selectFrom("navigation_nodes")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("app_id", "=", APP_ID);
    if (screenName !== undefined) {
      q = q.where("screen_name", "=", screenName);
    }
    const row = await q.executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async function countFingerprints(): Promise<number> {
    const row = await db
      .selectFrom("navigation_node_fingerprints")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("app_id", "=", APP_ID)
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
    TelemetryRecorder.resetInstance();
    // Stub the post-commit fire-and-forget telemetry write fired by
    // seedSuggestion's recordNavigationEvent. The file-level temp-file DB that
    // used to absorb it is gone (issue #2969), so an unstubbed write would
    // resolve the real getDatabase() and trip the unit-test DB guard (#3067).
    telemetrySpy = spyOn(
      TelemetryRecorder.getInstance(),
      "recordNavigationEvent",
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    telemetrySpy.mockRestore();
    TelemetryRecorder.resetInstance();
    await db.destroy();
  });

  function makeManager(): NavigationGraphManager {
    const navRepo = new NavigationRepository(db);
    const coverage = new TestCoverageRepository(defaultTimer, db);
    return NavigationGraphManager.createForTesting(navRepo, coverage);
  }

  // Seed a promotable suggestion: one named node (so the app "has named nodes")
  // plus an uncorrelated fingerprint suggestion.
  async function seedSuggestion(manager: NavigationGraphManager): Promise<number> {
    await manager.recordNavigationEvent(createEvent("HomeScreen", 1000));
    await manager.recordHierarchyNavigation({
      fromFingerprint: null,
      toFingerprint: "fp_settings",
      fingerprintData: JSON.stringify({ layout: "settings" }),
      timestamp: 5000, // outside the active-navigation window → becomes a suggestion
      packageName: APP_ID,
    });
    const suggestions = await manager.getSuggestions();
    const suggestion = suggestions.find((s) => s.fingerprintHash === "fp_settings");
    expect(suggestion).toBeDefined();
    return suggestion!.id;
  }

  test("happy path persists the named node, fingerprint, and suggestion link", async () => {
    const manager = makeManager();
    await manager.setCurrentApp(APP_ID);
    const suggestionId = await seedSuggestion(manager);

    await manager.promoteSuggestion(suggestionId, "SettingsScreen");

    expect(await countNodes("SettingsScreen")).toBe(1);
    // The promoted fingerprint now points at a named node; the suggestion is gone
    // from the unpromoted list.
    const remaining = await manager.getSuggestions();
    expect(remaining.find((s) => s.fingerprintHash === "fp_settings")).toBeUndefined();
  });

  test("rolls back the created node when the suggestion link fails mid-sequence", async () => {
    const manager = makeManager();
    await manager.setCurrentApp(APP_ID);
    await seedSuggestion(manager);

    const nodesBefore = await countNodes();
    const fingerprintsBefore = await countFingerprints();

    // notifyGraphUpdated must fire only after commit — never on rollback (#2981 AC).
    let notifyCount = 0;
    manager.setGraphUpdateListener(() => {
      notifyCount++;
    });

    // A non-existent suggestion id: getOrCreateNode creates the "OrphanScreen"
    // node first, then repository.promoteSuggestion throws "Suggestion not found"
    // during the multi-write promotion. Without a transaction the node would be
    // left orphaned; the transaction must roll it back.
    await expect(manager.promoteSuggestion(999999, "OrphanScreen")).rejects.toThrow(
      /Suggestion not found/i,
    );

    // Zero new nodes/fingerprints persisted for the failed promotion.
    expect(await countNodes("OrphanScreen")).toBe(0);
    expect(await countNodes()).toBe(nodesBefore);
    expect(await countFingerprints()).toBe(fingerprintsBefore);

    // The post-commit side effect never fired because the transaction threw.
    expect(notifyCount).toBe(0);
  });

  test("rolls back BOTH the node and the fingerprint when the link fails after the fingerprint is created", async () => {
    // The link failure happens AFTER getOrCreateNode + getOrCreateFingerprint both
    // wrote — the exact orphaned node/fingerprint partial write #2968 calls out.
    const navRepo = new ThrowingLinkPromoteRepo(APP_ID, db);
    const coverage = new TestCoverageRepository(defaultTimer, db);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);

    // notifyGraphUpdated must not fire when the fingerprint-then-link write throws.
    let notifyCount = 0;
    manager.setGraphUpdateListener(() => {
      notifyCount++;
    });

    await expect(manager.promoteSuggestion(42, "OrphanScreen")).rejects.toThrow(
      /injected suggestion-link failure/,
    );

    // Both writes rolled back together — no orphan node, no orphan fingerprint.
    expect(await countNodes("OrphanScreen")).toBe(0);
    expect(await countFingerprints()).toBe(0);

    // No post-commit notification on the rolled-back promotion.
    expect(notifyCount).toBe(0);
  });

  test("notifies graph listeners exactly once, only after the transaction commits", async () => {
    const manager = makeManager();
    await manager.setCurrentApp(APP_ID);
    const suggestionId = await seedSuggestion(manager);

    // repository.promoteSuggestion is the LAST write inside the transaction. Record
    // its call count at every notify fire (not just the last) so a notification
    // firing BEFORE the transaction completes — when the count is still 0 — is
    // caught rather than masked by a later post-commit fire. spyOn calls through,
    // and withExecutor rebinds onto a new NavigationRepository sharing this
    // prototype, so the trx-bound write is counted too.
    const promoteSpy = spyOn(NavigationRepository.prototype, "promoteSuggestion");

    // try/finally so a failing assertion can never leave this prototype spy armed
    // for sibling suites in the same process (spyOn calls through, but restore is
    // still the hygienic contract).
    try {
      const notifyPromoteCounts: number[] = [];
      manager.setGraphUpdateListener(() => {
        notifyPromoteCounts.push(promoteSpy.mock.calls.length);
      });

      await manager.promoteSuggestion(suggestionId, "SettingsScreen");

      // promoteSuggestion ran exactly once, and notify fired exactly once, AFTER that
      // final in-transaction write completed — never inside or before the transaction.
      expect(promoteSpy).toHaveBeenCalledTimes(1);
      expect(notifyPromoteCounts).toEqual([1]);
    } finally {
      promoteSpy.mockRestore();
    }
  });
});

/**
 * A NavigationRepository that throws on touchApp only once a shared control flag is
 * flipped, so setup writes (which also touchApp) succeed and only the write under
 * test fails. The control object is threaded through withExecutor so the flag
 * survives the manager rebinding the repo onto the transaction executor.
 */
class ConditionalTouchAppRepo extends NavigationRepository {
  constructor(
    private readonly control: { throwOnTouch: boolean },
    db?: Kysely<Database>,
  ) {
    super(db);
  }

  override withExecutor(executor: Kysely<Database>): NavigationRepository {
    return new ConditionalTouchAppRepo(this.control, executor);
  }

  override async touchApp(appId: string): Promise<void> {
    if (this.control.throwOnTouch) {
      throw new Error("injected touchApp failure");
    }
    return super.touchApp(appId);
  }
}

describe("NavigationGraphManager - recordHierarchyNavigation Case-1 transaction (#2968)", () => {
  const APP_ID = "com.test.hiernav";

  let db: Kysely<Database>;

  async function nodeVisitCount(screenName: string): Promise<number> {
    const row = await db
      .selectFrom("navigation_nodes")
      .select(["visit_count"])
      .where("app_id", "=", APP_ID)
      .where("screen_name", "=", screenName)
      .executeTakeFirst();
    return Number(row?.visit_count ?? 0);
  }

  async function countNodeCoverageRows(): Promise<number> {
    const row = await db
      .selectFrom("test_node_coverage")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  async function sessionNodeTotal(sessionId: number): Promise<number> {
    const row = await db
      .selectFrom("test_coverage_sessions")
      .select(["total_nodes_visited"])
      .where("id", "=", sessionId)
      .executeTakeFirstOrThrow();
    return Number(row.total_nodes_visited);
  }

  beforeEach(async () => {
    db = await createTestDatabase({ foreignKeys: true });
    TelemetryRecorder.resetInstance();
    spyOn(TelemetryRecorder.getInstance(), "recordNavigationEvent").mockResolvedValue(undefined);
  });

  afterEach(async () => {
    TelemetryRecorder.resetInstance();
    await db.destroy();
  });

  // Seed a named node ("Home") with a correlated fingerprint ("fp_home") WITHOUT
  // an active test session (so the throwing coverage repo is never touched during
  // setup), then navigate away so currentScreen != "Home". A later hierarchy event
  // carrying "fp_home" takes Case 1 (existing-node branch).
  async function seedCorrelatedNode(manager: NavigationGraphManager): Promise<void> {
    await manager.recordNavigationEvent(createEvent("Home", 1000));
    await manager.recordHierarchyNavigation({
      fromFingerprint: null,
      toFingerprint: "fp_home",
      fingerprintData: JSON.stringify({ layout: "home" }),
      timestamp: 1200, // within ACTIVE_NAVIGATION_WINDOW_MS → correlates fp_home → Home
      packageName: APP_ID,
    });
    await manager.recordNavigationEvent(createEvent("Other", 3000)); // currentScreen → "Other"
  }

  test("happy path records the visit + coverage and updates currentScreen", async () => {
    const navRepo = new NavigationRepository(db);
    const coverage = new TestCoverageRepository(defaultTimer, db);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);
    await seedCorrelatedNode(manager);
    await manager.startTestSession("session-hier-happy");
    const sessionId = manager.getActiveTestSession()!.id;

    const visitsBefore = await nodeVisitCount("Home");

    await manager.recordHierarchyNavigation({
      fromFingerprint: null,
      toFingerprint: "fp_home",
      timestamp: 8000, // well outside the window → Case 1 (existing-node match)
      packageName: APP_ID,
    });

    expect(await nodeVisitCount("Home")).toBe(visitsBefore + 1);
    expect(await countNodeCoverageRows()).toBe(1);
    expect(await sessionNodeTotal(sessionId)).toBe(1);
    expect(manager.getCurrentScreen()).toBe("Home");
  });

  test("rolls back the node-visit + coverage counters when recordNodeVisit throws", async () => {
    const navRepo = new NavigationRepository(db);
    const coverage = new ThrowingNodeVisitCoverageRepo(defaultTimer, db);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);
    await seedCorrelatedNode(manager);
    await manager.startTestSession("session-hier-rollback");
    const sessionId = manager.getActiveTestSession()!.id;

    const visitsBefore = await nodeVisitCount("Home");
    const coverageBefore = await countNodeCoverageRows();
    const sessionTotalBefore = await sessionNodeTotal(sessionId);

    let notifyCount = 0;
    manager.setGraphUpdateListener(() => {
      notifyCount++;
    });

    // Case 1: updateNodeVisit succeeds inside the transaction, then the coverage
    // recordNodeVisit throws → the whole thing must roll back.
    await expect(
      manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fp_home",
        timestamp: 8000,
        packageName: APP_ID,
      }),
    ).rejects.toThrow(/injected recordNodeVisit failure/);

    // updateNodeVisit's increment is rolled back; coverage rows/counters unchanged.
    expect(await nodeVisitCount("Home")).toBe(visitsBefore);
    expect(await countNodeCoverageRows()).toBe(coverageBefore);
    expect(await sessionNodeTotal(sessionId)).toBe(sessionTotalBefore);

    // In-memory field rollback invariant: currentScreen stays "Other" (the
    // post-commit assignment to "Home" never runs), and no notify fires.
    expect(manager.getCurrentScreen()).toBe("Other");
    expect(notifyCount).toBe(0);
  });

  test("rolls back updateNodeVisit with NO active session when touchApp throws", async () => {
    // Case 1 with no test session still wraps two nav-repo writes (updateNodeVisit +
    // touchApp). Prove that pair is atomic: touchApp throws → the visit increment
    // rolls back. The control flag lets setup writes (which also touchApp) succeed.
    const control = { throwOnTouch: false };
    const navRepo = new ConditionalTouchAppRepo(control, db);
    const coverage = new TestCoverageRepository(defaultTimer, db);
    const manager = NavigationGraphManager.createForTesting(navRepo, coverage);
    await manager.setCurrentApp(APP_ID);
    await seedCorrelatedNode(manager); // no startTestSession → activeTestSession stays null

    const visitsBefore = await nodeVisitCount("Home");
    control.throwOnTouch = true;

    await expect(
      manager.recordHierarchyNavigation({
        fromFingerprint: null,
        toFingerprint: "fp_home",
        timestamp: 8000, // Case 1 (existing-node match)
        packageName: APP_ID,
      }),
    ).rejects.toThrow(/injected touchApp failure/);

    // updateNodeVisit ran first inside the transaction; touchApp's throw rolls it back.
    expect(await nodeVisitCount("Home")).toBe(visitsBefore);
    // currentScreen unchanged — post-commit assignment never runs.
    expect(manager.getCurrentScreen()).toBe("Other");
  });
});
