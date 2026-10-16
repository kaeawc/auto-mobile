import { describe, expect, test } from "bun:test";
import type { NavigationEvent, NavigationGraph } from "../../src/utils/interfaces/NavigationGraph";

export interface NavigationGraphHandle {
  graph: NavigationGraph;
  dispose?: () => Promise<void>;
}

const APP = "com.example.app";

function event(destination: string, timestamp: number, sequenceNumber: number): NavigationEvent {
  return {
    destination,
    source: "",
    arguments: {},
    metadata: {},
    timestamp,
    sequenceNumber,
    applicationId: APP,
  };
}

/**
 * Shared behavioural contract for the {@link NavigationGraph} state a caller can drive through the
 * public interface (#11868): current app and screen, node visits, tool-driven edges, path search,
 * stats, clearing and update notifications. Run it against the in-memory fake and the real
 * `NavigationGraphManager` over an in-memory database. Scripted setters on the fake are not part
 * of the contract.
 */
export function runNavigationGraphContract(
  name: string,
  make: () => Promise<NavigationGraphHandle>,
): void {
  const withGraph = async (body: (graph: NavigationGraph) => Promise<void>): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.graph);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`NavigationGraph contract: ${name}`, () => {
    test("a fresh graph has no app, screen or known screens", () =>
      withGraph(async (graph) => {
        expect(graph.getCurrentAppId()).toBeNull();
        expect(graph.getCurrentScreen()).toBeNull();
        expect(await graph.getKnownScreens()).toEqual([]);
        expect(await graph.getNode("Home")).toBeUndefined();
      }));

    test("setCurrentApp selects the app", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        expect(graph.getCurrentAppId()).toBe(APP);
      }));

    test("a navigation event records the destination as the current screen and a visited node", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        expect(graph.getCurrentScreen()).toBe("Home");
        expect(await graph.getKnownScreens()).toEqual(["Home"]);
        expect(await graph.getNode("Home")).toMatchObject({ screenName: "Home", visitCount: 1 });
      }));

    test("revisiting a screen increments its visit count and keeps its first-seen time", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        await graph.recordNavigationEvent(event("Home", 2_000, 2));
        const node = await graph.getNode("Home");
        expect(node?.visitCount).toBe(2);
        expect(node?.firstSeenAt).toBe(1_000);
        expect(node?.lastSeenAt).toBe(2_000);
      }));

    test("a navigation between screens adds a node for each screen", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        await graph.recordNavigationEvent(event("Detail", 2_000, 2));
        expect((await graph.getKnownScreens()).sort()).toEqual(["Detail", "Home"]);
        expect(graph.getCurrentScreen()).toBe("Detail");
        expect((await graph.getStats()).nodeCount).toBe(2);
      }));

    test("clearCurrentGraph empties nodes and the current screen", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        await graph.clearCurrentGraph();
        expect(await graph.getKnownScreens()).toEqual([]);
        expect(graph.getCurrentScreen()).toBeNull();
        expect((await graph.getStats()).nodeCount).toBe(0);
      }));

    test("findPath on an unknown target from no screen is not found", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        const result = await graph.findPath("Nowhere");
        expect(result.found).toBe(false);
        expect(result.path).toEqual([]);
        expect(result.targetScreen).toBe("Nowhere");
      }));

    test("a graph update listener is notified of changes and can be removed", () =>
      withGraph(async (graph) => {
        let notifications = 0;
        graph.setGraphUpdateListener(() => {
          notifications += 1;
        });
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        expect(notifications).toBeGreaterThan(0);
        graph.setGraphUpdateListener(null);
        const before = notifications;
        await graph.recordNavigationEvent(event("Detail", 2_000, 2));
        expect(notifications).toBe(before);
      }));

    test("exportGraph reflects the current app, screen and nodes", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        const exported = await graph.exportGraph();
        expect(exported.appId).toBe(APP);
        expect(exported.currentScreen).toBe("Home");
        expect(exported.nodes.map((node) => node.screenName)).toEqual(["Home"]);
      }));

    test("a tool call followed by a navigation records a tool edge carrying the call", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        graph.recordToolCall("tapOn", { text: "Open" });
        await graph.recordNavigationEvent(event("Detail", 2_000, 2));
        const edges = await graph.getEdgesFrom("Home");
        expect(edges).toHaveLength(1);
        expect(edges[0]).toMatchObject({ from: "Home", to: "Detail", edgeType: "tool" });
        expect(edges[0].interaction?.toolName).toBe("tapOn");
        expect((await graph.getEdgesTo("Detail")).map((edge) => edge.from)).toEqual(["Home"]);
        expect(await graph.getEdgesFrom("Detail")).toEqual([]);
        expect((await graph.getStats()).edgeCount).toBe(1);
      }));

    test("findPath follows a recorded tool edge back to a known screen", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        graph.recordToolCall("tapOn", { text: "Open" });
        await graph.recordNavigationEvent(event("Detail", 2_000, 2));
        // Back on Home with no edge back: from Detail the path to Home is unknown, but Home to
        // Detail is known once we are on Home again.
        await graph.recordNavigationEvent(event("Home", 3_000, 3));
        const result = await graph.findPath("Detail");
        expect(result.found).toBe(true);
        expect(result.startScreen).toBe("Home");
        expect(result.path.map((edge) => edge.to)).toEqual(["Detail"]);
        expect(result.path[0].interaction?.toolName).toBe("tapOn");
      }));

    test("findPath to the current screen is found with an empty path", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        const result = await graph.findPath("Home");
        expect(result).toMatchObject({ found: true, path: [], startScreen: "Home" });
      }));

    // Known divergence, not part of the contract: the real manager also records a tool-less edge
    // for a navigation with no causing call, while the fake adds an edge only after a tool call.
    test("a withdrawn tool call does not become an edge carrying that call", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        const withdraw = graph.recordToolCall("tapOn", { text: "Open" });
        withdraw();
        await graph.recordNavigationEvent(event("Detail", 2_000, 2));
        expect((await graph.getEdgesFrom("Home")).filter((edge) => edge.interaction)).toEqual([]);
      }));

    test("graphs are kept per app: switching apps hides the other app's nodes", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        await graph.setCurrentApp("com.other.app");
        expect(graph.getCurrentAppId()).toBe("com.other.app");
        expect(await graph.getKnownScreens()).toEqual([]);
        expect((await graph.exportGraphForApp(APP)).nodes.map((node) => node.screenName)).toEqual([
          "Home",
        ]);
        await graph.setCurrentApp(APP);
        expect(await graph.getKnownScreens()).toEqual(["Home"]);
      }));

    test("clearAllGraphs empties every app and forgets the current app", () =>
      withGraph(async (graph) => {
        await graph.setCurrentApp(APP);
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        await graph.clearAllGraphs();
        expect(graph.getCurrentAppId()).toBeNull();
        expect((await graph.exportGraphForApp(APP)).nodes).toEqual([]);
      }));

    test("a navigation event naming an app makes it current", () =>
      withGraph(async (graph) => {
        await graph.recordNavigationEvent(event("Home", 1_000, 1));
        expect(graph.getCurrentAppId()).toBe(APP);
        expect(await graph.getKnownScreens()).toEqual(["Home"]);
      }));
  });
}
