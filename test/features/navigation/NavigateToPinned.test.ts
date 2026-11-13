import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { NavigateTo, type NavigateToOptions } from "../../../src/features/navigation/NavigateTo";
import type { ForegroundObserver } from "../../../src/features/navigation/foregroundOverlay";
import type { ScreenTransitionWaiter } from "../../../src/features/navigation/interfaces/ScreenTransitionWaiter";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { BootedDevice } from "../../../src/models";
import { createNavigateToHandler } from "../../../src/server/navigationTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "pin-device", platform: "ios", name: "Pin device" };
const noSetup: UIStateSetup = {
  setupUIState: async () => [],
  setupScrollPosition: async () => null,
};
const cleanForegroundObserver: ForegroundObserver = { execute: async () => ({}) };

const edge = (from: string, to: string, toolName = "tapOn", timestamp = 0): NavigationEdge => ({
  from,
  to,
  timestamp,
  edgeType: "tool",
  interaction: { toolName, args: { text: `${toolName}:${from}>${to}` }, timestamp },
});

describe("navigateTo viaTransition (#16982)", () => {
  let graph: FakeNavigationGraphManager;
  let dispatched: string[];
  /** Screens a replayed action fails to reach: the waiter times out and the device stays put. */
  let unreachable: Set<string>;

  beforeEach(() => {
    ToolRegistry.clearTools();
    graph = new FakeNavigationGraphManager();
    graph.setCurrentScreenValue("A");
    dispatched = [];
    unreachable = new Set();
    for (const tool of ["tapOn", "swipeOn"]) {
      ToolRegistry.register(tool, "Fake", z.object({ text: z.string() }), async (args) => {
        dispatched.push(args.text);
        return { success: true };
      });
    }
  });

  afterEach(() => ToolRegistry.clearTools());

  function makeNav(): NavigateTo {
    const waiter: ScreenTransitionWaiter = {
      waitForScreen: async (screen) => {
        if (unreachable.has(screen)) {
          return false;
        }
        graph.setCurrentScreenValue(screen);
        return true;
      },
    };
    return new NavigateTo(device, new FakeAdbClientFactory(), {
      uiStateSetup: noSetup,
      screenWaiter: waiter,
      navigationManager: graph,
      timer: new FakeTimer(),
      foregroundObserverProvider: () => cleanForegroundObserver,
    });
  }

  const pinned = (via: NavigateToOptions["viaTransition"]): NavigateToOptions => ({
    targetScreen: via!.to,
    platform: "ios",
    viaTransition: via,
  });

  test("plans to the source, then replays the pinned edge", async () => {
    graph.addEdge(edge("A", "B"));
    graph.addEdge(edge("B", "C"));
    graph.setPathResult({
      found: true,
      path: [edge("A", "B")],
      startScreen: "A",
      targetScreen: "B",
    });

    const result = await makeNav().execute(pinned({ from: "B", to: "C", toolName: "tapOn" }));

    expect(result.success).toBe(true);
    expect(result.currentScreen).toBe("C");
    expect(dispatched).toEqual(["tapOn:A>B", "tapOn:B>C"]);
    expect(graph.getMethodCallArgs("findPath")).toEqual(["B"]);
    expect(graph.getMethodCallCount("findPath")).toBe(1);
  });

  test("replays only the pinned tool among parallel edges, even when another is newer", async () => {
    graph.setCurrentScreenValue("B");
    graph.addEdge(edge("B", "C", "swipeOn", 1));
    graph.addEdge(edge("B", "C", "tapOn", 9));

    const result = await makeNav().execute(pinned({ from: "B", to: "C", toolName: "swipeOn" }));

    expect(result.success).toBe(true);
    expect(dispatched).toEqual(["swipeOn:B>C"]);
    expect(graph.wasMethodCalled("findPath")).toBe(false);
  });

  test("an edge id selects its parallel edge's tool", async () => {
    graph.setCurrentScreenValue("B");
    graph.addEdge(edge("B", "C", "tapOn", 9));
    graph.addEdge(edge("B", "C", "swipeOn", 1));
    const swipeId = (await graph.exportGraphSummary()).edges.find(
      (e) => e.toolName === "swipeOn",
    )!.id;

    const result = await makeNav().execute(pinned({ from: "B", to: "C", edgeId: swipeId }));

    expect(result.success).toBe(true);
    expect(dispatched).toEqual(["swipeOn:B>C"]);
  });

  test("a pinned miss never substitutes the parallel edge and reports where it stopped", async () => {
    graph.setCurrentScreenValue("B");
    graph.addEdge(edge("B", "C", "swipeOn"));
    graph.addEdge(edge("B", "C", "tapOn"));
    // An unpinned replan would offer the parallel tapOn edge as a fallback.
    graph.setPathResult({
      found: true,
      path: [edge("B", "C", "tapOn")],
      startScreen: "B",
      targetScreen: "C",
    });
    unreachable.add("C");

    const result = await makeNav().execute(pinned({ from: "B", to: "C", toolName: "swipeOn" }));

    expect(result.success).toBe(false);
    expect(result.currentScreen).toBe("B");
    expect(result.targetScreen).toBe("C");
    expect(result.error).toContain('did not reach "C"');
    expect(dispatched).toEqual(["swipeOn:B>C"]);
    expect(graph.wasMethodCalled("findPath")).toBe(false);
    expect(graph.getMethodCallArgs("recordEdgeReplayOutcome")?.[1]).toBe(false);
  });

  for (const via of [{ toolName: null }, { edgeId: 1 }]) {
    test(`a recorded Back transition with depth evidence is replayed as Back (${JSON.stringify(via)})`, async () => {
      ToolRegistry.register(
        "pressButton",
        "Fake",
        z.object({ button: z.string() }),
        async (args) => {
          dispatched.push(`press:${args.button}`);
          return { success: true };
        },
      );
      graph.setCurrentScreenValue("Details");
      graph.addNode({
        screenName: "Details",
        firstSeenAt: 0,
        lastSeenAt: 0,
        visitCount: 1,
        backStackDepth: 2,
      });
      graph.addNode({
        screenName: "Home",
        firstSeenAt: 0,
        lastSeenAt: 0,
        visitCount: 1,
        backStackDepth: 1,
      });
      // As getEdgesFrom reports a no-tool edge: unclassified.
      graph.addEdge({ from: "Details", to: "Home", timestamp: 0, edgeType: "unknown" });

      const result = await makeNav().execute(pinned({ from: "Details", to: "Home", ...via }));

      expect(result.success).toBe(true);
      expect(dispatched).toEqual(["press:back"]);
    });
  }

  test("a no-tool transition without depth evidence is not replayed", async () => {
    graph.setCurrentScreenValue("Details");
    graph.addEdge({ from: "Details", to: "Home", timestamp: 0, edgeType: "unknown" });

    const result = await makeNav().execute(pinned({ from: "Details", to: "Home", toolName: null }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("No replayable recorded transition");
    expect(dispatched).toEqual([]);
  });

  test("a missing transition is not reached and dispatches nothing", async () => {
    graph.addEdge(edge("B", "C", "tapOn"));

    const result = await makeNav().execute(pinned({ from: "B", to: "C", toolName: "swipeOn" }));

    expect(result.success).toBe(false);
    expect(result.currentScreen).toBe("A");
    expect(result.error).toContain("No replayable recorded transition");
    expect(dispatched).toEqual([]);
  });

  test("an edge id that is not in the graph is not reached", async () => {
    graph.addEdge(edge("B", "C", "tapOn"));

    const result = await makeNav().execute(pinned({ from: "B", to: "C", edgeId: 999 }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("Transition 999");
    expect(dispatched).toEqual([]);
  });

  test("failing to reach the source stops before the pinned edge", async () => {
    graph.addEdge(edge("B", "C"));
    graph.setPathResult({
      found: true,
      path: [edge("A", "B")],
      startScreen: "A",
      targetScreen: "B",
    });
    unreachable.add("B");

    const result = await makeNav().execute(pinned({ from: "B", to: "C" }));

    expect(result.success).toBe(false);
    expect(result.currentScreen).toBe("A");
    expect(result.error).toContain('source "B"');
    expect(dispatched).toEqual(["tapOn:A>B"]);
  });

  test("unpinned navigateTo never resolves a transition", async () => {
    graph.addEdge(edge("A", "C"));
    graph.setPathResult({
      found: true,
      path: [edge("A", "C")],
      startScreen: "A",
      targetScreen: "C",
    });

    const result = await makeNav().execute({ targetScreen: "C", platform: "ios" });

    expect(result.success).toBe(true);
    expect(graph.wasMethodCalled("getEdgesFrom")).toBe(false);
    expect(graph.wasMethodCalled("exportGraphSummary")).toBe(false);
  });

  test("the handler forwards viaTransition and rejects one ending elsewhere", async () => {
    const seen: NavigateToOptions[] = [];
    const handler = createNavigateToHandler({
      navigateToFactory: () => ({
        execute: async (options) => {
          seen.push(options);
          return { success: true, currentScreen: "C", targetScreen: "C", stepsExecuted: 1 };
        },
      }),
    });
    const via = { from: "B", to: "C", edgeId: 4 };

    await handler(device, { targetScreen: "C", viaTransition: via });
    await expect(handler(device, { targetScreen: "D", viaTransition: via })).rejects.toThrow(
      "must equal targetScreen",
    );

    expect(seen.map((options) => options.viaTransition)).toEqual([via]);
  });
});
