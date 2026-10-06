import { expect, describe, test, beforeEach, afterEach, spyOn } from "bun:test";
import { Element } from "../../../src/models";
import {
  NavigationGraphManager,
  type NavigationEdge,
} from "../../../src/features/navigation/NavigationGraphManager";
import { FakeNavigationGraphManager } from "../../fakes/FakeNavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  initializeGraphTraversal,
  getEdgeKey,
  hashEdgeAction,
  markNodeVisited,
  markEdgeTraversed,
  selectNextEdgeToTraverse,
  findElementMatchingEdge,
  resolveEdgeTarget,
  addPendingEdge,
} from "../../../src/features/navigation/ExploreValidateMode";

describe("ExploreValidateMode", () => {
  let fakeGraph: FakeNavigationGraphManager;
  let fakeTimer: FakeTimer;
  let getInstanceSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    fakeGraph = new FakeNavigationGraphManager();
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    getInstanceSpy = spyOn(NavigationGraphManager, "getInstance").mockReturnValue(
      fakeGraph as unknown as NavigationGraphManager,
    );
  });

  afterEach(() => {
    getInstanceSpy?.mockRestore();
  });

  function createMockElement(overrides: Partial<Element> = {}): Element {
    return {
      bounds: { left: 0, top: 0, right: 100, bottom: 50 },
      clickable: true,
      enabled: true,
      text: "Button",
      class: "android.widget.Button",
      "resource-id": "com.test:id/button",
      ...overrides,
    } as Element;
  }

  function createMockEdge(
    from: string,
    to: string,
    overrides: Partial<NavigationEdge> = {},
  ): NavigationEdge {
    return {
      from,
      to,
      timestamp: Date.now(),
      edgeType: "tool",
      ...overrides,
    };
  }

  describe("initializeGraphTraversal", () => {
    test("should create empty state for empty graph", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);

      expect(state.visitedNodes.size).toBe(0);
      expect(state.traversedEdges.size).toBe(0);
      expect(state.pendingEdges.size).toBe(0);
      expect(state.totalNodesInGraph).toBe(0);
      expect(state.totalEdgesInGraph).toBe(0);
    });

    test("should populate state from existing graph", async () => {
      const navManager = NavigationGraphManager.getInstance();

      navManager.recordNavigationEvent({
        destination: "Screen1",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 1,
        applicationId: "com.test.app",
      });

      await navManager.recordToolCall(
        "tapOn",
        { text: "Button1" },
        {
          // Pre-action state (the active tab), not the tapped control.
          selectedElements: [{ text: "Home", resourceId: "tab_home", contentDesc: "" }],
        },
      );

      navManager.recordNavigationEvent({
        destination: "Screen2",
        source: "TEST",
        arguments: {},
        metadata: {},
        timestamp: Date.now(),
        sequenceNumber: 2,
        applicationId: "com.test.app",
      });

      const state = await initializeGraphTraversal(navManager);

      expect(state.totalNodesInGraph).toBeGreaterThan(0);
      expect(state.totalEdgesInGraph).toBeGreaterThan(0);
      expect(state.pendingEdges.size).toBeGreaterThan(0);
    });
  });

  describe("getEdgeKey", () => {
    test("should generate key in format from->hash->to", () => {
      const edge = createMockEdge("ScreenA", "ScreenB", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      const key = getEdgeKey(edge);

      expect(key).toMatch(/^ScreenA->[a-f0-9]{8}->ScreenB$/);
    });

    test("should generate same key for identical edges", () => {
      const edge1 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      const edge2 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 2000, // Different timestamp
        },
      });

      expect(getEdgeKey(edge1)).toBe(getEdgeKey(edge2));
    });

    test("should generate different keys for different interactions", () => {
      const edge1 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button A" },
          timestamp: 1000,
        },
      });

      const edge2 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button B" },
          timestamp: 1000,
        },
      });

      expect(getEdgeKey(edge1)).not.toBe(getEdgeKey(edge2));
    });

    test("should generate different keys for different screens", () => {
      const edge1 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      const edge2 = createMockEdge("B", "C", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      expect(getEdgeKey(edge1)).not.toBe(getEdgeKey(edge2));
    });
  });

  describe("hashEdgeAction", () => {
    test("should hash edge type for edges without interaction", () => {
      const edge = createMockEdge("A", "B", { edgeType: "back" });

      const hash = hashEdgeAction(edge);

      expect(hash).toHaveLength(8);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });

    test("should create deterministic hash from interaction", () => {
      const edge = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Submit" },
          timestamp: 1000,
        },
      });

      const hash1 = hashEdgeAction(edge);
      const hash2 = hashEdgeAction(edge);

      expect(hash1).toBe(hash2);
    });

    test("should exclude timestamp fields from hash", () => {
      const edge1 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button", timestamp: 1000 },
          timestamp: 1000,
        },
      });

      const edge2 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button", timestamp: 2000 },
          timestamp: 2000,
        },
      });

      expect(hashEdgeAction(edge1)).toBe(hashEdgeAction(edge2));
    });

    test("should hash reordered interaction args identically", () => {
      const edge1 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button", enabled: true },
          timestamp: 1000,
        },
      });

      const edge2 = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { enabled: true, text: "Button" },
          timestamp: 1000,
        },
      });

      expect(hashEdgeAction(edge1)).toBe(hashEdgeAction(edge2));
    });
  });

  describe("markNodeVisited", () => {
    test("should add node to visited set", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);

      expect(state.visitedNodes.has("Screen1")).toBe(false);

      markNodeVisited(state, "Screen1");

      expect(state.visitedNodes.has("Screen1")).toBe(true);
    });

    test("should not duplicate nodes", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);

      markNodeVisited(state, "Screen1");
      markNodeVisited(state, "Screen1");

      expect(state.visitedNodes.size).toBe(1);
    });
  });

  describe("markEdgeTraversed", () => {
    test("should add edge to traversed set", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      markEdgeTraversed(state, edge, "B", true, fakeTimer);

      expect(state.traversedEdges.size).toBe(1);
      expect(state.traversedEdges.has(getEdgeKey(edge))).toBe(true);
    });

    test("should record validation result", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      markEdgeTraversed(state, edge, "B", true, fakeTimer, undefined, 0.95);

      const result = state.edgeValidationResults.get(getEdgeKey(edge));
      expect(result).toBeDefined();
      expect(result?.success).toBe(true);
      expect(result?.expectedTo).toBe("B");
      expect(result?.actualTo).toBe("B");
      expect(result?.matchConfidence).toBe(0.95);
    });

    test("should record failed validation", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      markEdgeTraversed(state, edge, "C", false, fakeTimer, "Went to wrong screen", 0.7);

      const result = state.edgeValidationResults.get(getEdgeKey(edge));
      expect(result?.success).toBe(false);
      expect(result?.expectedTo).toBe("B");
      expect(result?.actualTo).toBe("C");
      expect(result?.error).toBe("Went to wrong screen");
    });

    test("should remove edge from pending", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("A", "B", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });

      addPendingEdge(state, edge);
      const initialLength = state.pendingEdges.size;

      markEdgeTraversed(state, edge, "B", true, fakeTimer);

      expect(state.pendingEdges.size).toBeLessThan(initialLength);
      // The `from` index must stay in sync with the key map.
      expect(state.pendingEdgesByFrom.has("A")).toBe(false);
    });
  });

  describe("selectNextEdgeToTraverse", () => {
    test("should return edge from current screen", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("CurrentScreen", "NextScreen", {
        interaction: {
          toolName: "tapOn",
          args: { text: "Button" },
          timestamp: 1000,
        },
      });
      addPendingEdge(state, edge);

      const selected = selectNextEdgeToTraverse(state, "CurrentScreen");

      expect(selected).toBe(edge);
    });

    test("should return null if no edges from current screen", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("OtherScreen", "NextScreen");
      addPendingEdge(state, edge);

      const selected = selectNextEdgeToTraverse(state, "CurrentScreen");

      expect(selected).toBeNull();
    });

    test("should return null for empty pending edges", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);

      const selected = selectNextEdgeToTraverse(state, "CurrentScreen");

      expect(selected).toBeNull();
    });

    test("should return first matching edge", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge1 = createMockEdge("Current", "A");
      const edge2 = createMockEdge("Current", "B");
      addPendingEdge(state, edge1);
      addPendingEdge(state, edge2);

      const selected = selectNextEdgeToTraverse(state, "Current");

      expect(selected).toBe(edge1);
    });

    test("should keep the from-index in sync as edges are traversed", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge1 = createMockEdge("Current", "A", {
        interaction: { toolName: "tapOn", args: { text: "A" }, timestamp: 1 },
      });
      const edge2 = createMockEdge("Current", "B", {
        interaction: { toolName: "tapOn", args: { text: "B" }, timestamp: 2 },
      });
      addPendingEdge(state, edge1);
      addPendingEdge(state, edge2);

      // Traversing edge1 leaves edge2 as the next selection from "Current".
      markEdgeTraversed(state, edge1, "A", true, fakeTimer);
      expect(selectNextEdgeToTraverse(state, "Current")).toBe(edge2);

      // Traversing edge2 empties the bucket, which must be dropped entirely.
      markEdgeTraversed(state, edge2, "B", true, fakeTimer);
      expect(selectNextEdgeToTraverse(state, "Current")).toBeNull();
      expect(state.pendingEdgesByFrom.has("Current")).toBe(false);
      expect(state.pendingEdges.size).toBe(0);
    });

    test("addPendingEdge deduplicates by edge key", async () => {
      const state = await initializeGraphTraversal(fakeGraph as unknown as NavigationGraphManager);
      const edge = createMockEdge("Current", "A", {
        interaction: { toolName: "tapOn", args: { text: "A" }, timestamp: 1 },
      });
      addPendingEdge(state, edge);
      addPendingEdge(state, edge);

      expect(state.pendingEdges.size).toBe(1);
      expect(state.pendingEdgesByFrom.get("Current")?.length).toBe(1);
    });
  });

  describe("findElementMatchingEdge / resolveEdgeTarget", () => {
    function interactionEdge(
      toolName: string,
      args: Record<string, unknown>,
      overrides: Partial<NavigationEdge> = {},
    ): NavigationEdge {
      return createMockEdge("Home", "Settings", {
        interaction: { toolName, args, timestamp: 0 },
        ...overrides,
      });
    }

    const homeTab = () =>
      createMockElement({ text: "Home", "resource-id": "com.test:id/tab_home", selected: "true" });
    const openSettings = () =>
      createMockElement({ text: "Open settings", "resource-id": "com.test:id/open_settings" });

    test("targets the recorded tapOn element, not the pre-action selected tab", () => {
      const tab = homeTab();
      const target = openSettings();
      const edge = interactionEdge(
        "tapOn",
        { text: "Open settings" },
        { uiState: { selectedElements: [{ text: "Home" }] } },
      );

      const result = findElementMatchingEdge([tab, target], edge);

      expect(result?.element).toBe(target);
      expect(result?.confidence).toBe(0.9);
    });

    test("never taps the selected tab when the recorded target is absent", () => {
      const edge = interactionEdge(
        "tapOn",
        { text: "Open settings" },
        { uiState: { selectedElements: [{ text: "Home" }] } },
      );

      expect(resolveEdgeTarget([homeTab()], edge)).toEqual({ status: "not-found", bestScore: 0 });
      expect(findElementMatchingEdge([homeTab()], edge)).toBeNull();
    });

    test("still matches when the edge carries an interaction but no uiState", () => {
      const target = openSettings();
      const edge = interactionEdge("tapOn", { text: "Open settings" });

      expect(findElementMatchingEdge([homeTab(), target], edge)?.element).toBe(target);
    });

    test("reads the public nested selector form", () => {
      const target = openSettings();
      const edge = interactionEdge("tapOn", {
        selector: { text: "Open settings" },
        action: "tap",
      });

      expect(findElementMatchingEdge([homeTab(), target], edge)?.element).toBe(target);
    });

    test("matches an elementId selector against the resource id", () => {
      const target = openSettings();
      const edge = interactionEdge("tapOn", {
        selector: { elementId: "com.test:id/open_settings" },
      });

      const result = findElementMatchingEdge([homeTab(), target], edge);

      expect(result?.element).toBe(target);
      expect(result?.confidence).toBe(0.95);
    });

    test("matches a text selector against the content description", () => {
      const target = createMockElement({ text: "", "content-desc": "Open settings" });
      const edge = interactionEdge("tapOn", { text: "Open settings" });

      expect(findElementMatchingEdge([homeTab(), target], edge)?.element).toBe(target);
    });

    test("matches any textAny variant", () => {
      const target = createMockElement({ text: "Preferences" });
      const edge = interactionEdge("tapOn", { selector: { textAny: ["Settings", "Preferences"] } });

      expect(findElementMatchingEdge([homeTab(), target], edge)?.element).toBe(target);
    });

    test("prefers an exact match over a partial one regardless of order", () => {
      const partial = createMockElement({ text: "Open settings now" });
      const exact = openSettings();
      const edge = interactionEdge("tapOn", { text: "Open settings" });

      expect(findElementMatchingEdge([partial, exact], edge)?.element).toBe(exact);
    });

    test("swipeOn targets the innermost recorded container", () => {
      const outer = createMockElement({ text: "", "resource-id": "com.test:id/outer" });
      const inner = createMockElement({ text: "", "resource-id": "com.test:id/feed" });
      const edge = interactionEdge("swipeOn", {
        direction: "up",
        container: { elementId: "com.test:id/outer", container: { elementId: "com.test:id/feed" } },
      });

      expect(findElementMatchingEdge([outer, inner], edge)?.element).toBe(inner);
    });

    test("does not use scrollPosition as the target", () => {
      const scrollTarget = createMockElement({ text: "Scrolled to" });
      const edge = interactionEdge(
        "tapOn",
        { text: "Open settings" },
        {
          uiState: {
            selectedElements: [],
            scrollPosition: { targetElement: { text: "Scrolled to" }, direction: "up" },
          },
        },
      );

      expect(findElementMatchingEdge([scrollTarget], edge)).toBeNull();
    });

    test("is below the confidence threshold for an unrelated element", () => {
      const edge = interactionEdge("tapOn", { text: "Submit", elementId: "submit_btn" });
      const unrelated = createMockElement({
        text: "Different Text",
        "resource-id": "different_id",
      });

      expect(resolveEdgeTarget([unrelated], edge)).toEqual({ status: "not-found", bestScore: 0 });
    });

    test("an edge with no recorded interaction is not validatable, even with uiState", () => {
      const edge = createMockEdge("Home", "Settings", {
        uiState: { selectedElements: [{ text: "Home" }] },
      });

      const result = resolveEdgeTarget([homeTab()], edge);

      expect(result.status).toBe("not-validatable");
      expect(result.status === "not-validatable" && result.reason).toContain(
        "no interaction was recorded",
      );
      expect(findElementMatchingEdge([homeTab()], edge)).toBeNull();
    });

    for (const [toolName, args] of [
      ["pressButton", { button: "back" }],
      ["sendKeys", { text: "hello" }],
      ["swipeOn", { direction: "up" }],
      ["tapOn", { action: "tap" }],
      ["tapOn", { selector: { testTag: "settings" } }],
    ] as const) {
      test(`${toolName} ${JSON.stringify(args)} has no replayable element target`, () => {
        const edge = interactionEdge(toolName, { ...args });

        expect(resolveEdgeTarget([homeTab(), openSettings()], edge).status).toBe("not-validatable");
      });
    }
  });
});
