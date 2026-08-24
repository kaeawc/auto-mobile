import { expect, describe, test } from "bun:test";
import { EdgeMatchIndex } from "../../../src/features/observe/PredictiveUIState";
import type { NavigationEdge } from "../../../src/features/navigation/NavigationGraphManager";
import type { Element } from "../../../src/models";

// Reuse the exact parameter type of findMatch without exporting the private
// InteractableElement interface.
type Interactable = Parameters<EdgeMatchIndex["findMatch"]>[0];

function tapEdge(args: Record<string, any>, to = "B"): NavigationEdge {
  return {
    from: "A",
    to,
    timestamp: 1,
    edgeType: "tool",
    interaction: { toolName: "tapOn", args, timestamp: 1 },
  };
}

function swipeEdge(args: Record<string, any>, to = "B"): NavigationEdge {
  return {
    from: "A",
    to,
    timestamp: 1,
    edgeType: "tool",
    interaction: { toolName: "swipeOn", args, timestamp: 1 },
  };
}

function interactable(overrides: Partial<Interactable>): Interactable {
  return {
    element: {} as Element,
    clickable: false,
    scrollable: false,
    ...overrides,
  };
}

describe("EdgeMatchIndex", () => {
  describe("tapOn", () => {
    test("matches a clickable interactable by text", () => {
      const edge = tapEdge({ text: "Submit" });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "Submit", clickable: true }))).toBe(edge);
    });

    test("matches when the edge text equals the interactable content-desc", () => {
      const edge = tapEdge({ text: "Close" });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ contentDesc: "Close", clickable: true }))).toBe(edge);
    });

    test("matches by element id against the interactable resource id", () => {
      const edge = tapEdge({ elementId: "com.app:id/ok" });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ resourceId: "com.app:id/ok", clickable: true }))).toBe(
        edge,
      );
    });

    test("supports the legacy `id` arg alias", () => {
      const edge = tapEdge({ id: "com.app:id/ok" });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ resourceId: "com.app:id/ok", clickable: true }))).toBe(
        edge,
      );
    });

    test("does not match a tapOn edge when the interactable is not clickable", () => {
      const edge = tapEdge({ text: "Submit" });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "Submit", scrollable: true }))).toBeUndefined();
    });
  });

  describe("swipeOn", () => {
    test("matches a scrollable interactable by container text", () => {
      const edge = swipeEdge({ container: { text: "List" } });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "List", scrollable: true }))).toBe(edge);
    });

    test("matches container text against the interactable content-desc", () => {
      const edge = swipeEdge({ container: { text: "Feed" } });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ contentDesc: "Feed", scrollable: true }))).toBe(edge);
    });

    test("matches by container resource id", () => {
      const edge = swipeEdge({ container: { resourceId: "com.app:id/list" } });
      const index = new EdgeMatchIndex([edge]);
      expect(
        index.findMatch(interactable({ resourceId: "com.app:id/list", scrollable: true })),
      ).toBe(edge);
    });

    test("matches by container content-desc", () => {
      const edge = swipeEdge({ container: { contentDesc: "Scrollable feed" } });
      const index = new EdgeMatchIndex([edge]);
      expect(
        index.findMatch(interactable({ contentDesc: "Scrollable feed", scrollable: true })),
      ).toBe(edge);
    });

    test("reads the container from uiState.scrollPosition when args.container is absent", () => {
      const edge: NavigationEdge = {
        from: "A",
        to: "B",
        timestamp: 1,
        edgeType: "tool",
        interaction: {
          toolName: "swipeOn",
          args: {},
          timestamp: 1,
          uiState: { scrollPosition: { container: { text: "List" } } } as any,
        },
      };
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "List", scrollable: true }))).toBe(edge);
    });

    test("does not match a swipeOn edge when the interactable is not scrollable", () => {
      const edge = swipeEdge({ container: { text: "List" } });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "List", clickable: true }))).toBeUndefined();
    });
  });

  describe("normalization", () => {
    test("matching is case-insensitive and trims whitespace", () => {
      const edge = tapEdge({ text: "submit" });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "  SUBMIT  ", clickable: true }))).toBe(edge);
    });

    test("whitespace-only edge text is not indexed", () => {
      const edge = tapEdge({ text: "   " });
      const index = new EdgeMatchIndex([edge]);
      expect(index.findMatch(interactable({ text: "   ", clickable: true }))).toBeUndefined();
    });
  });

  describe("edge-order tie-breaking", () => {
    test("returns the earliest edge when several paths match (min index wins)", () => {
      // edge0 matches by resource id; edge1 matches by text. Both apply to the
      // same interactable, so the earlier edge (edge0) must win.
      const edge0 = tapEdge({ elementId: "com.app:id/ok" }, "First");
      const edge1 = tapEdge({ text: "OK" }, "Second");
      const index = new EdgeMatchIndex([edge0, edge1]);
      const match = index.findMatch(
        interactable({ text: "OK", resourceId: "com.app:id/ok", clickable: true }),
      );
      expect(match).toBe(edge0);
    });

    test("first edge wins for a shared normalized key", () => {
      const edge0 = tapEdge({ text: "Go" }, "First");
      const edge1 = tapEdge({ text: "go" }, "Second");
      const index = new EdgeMatchIndex([edge0, edge1]);
      expect(index.findMatch(interactable({ text: "GO", clickable: true }))).toBe(edge0);
    });
  });

  test("returns undefined when nothing matches", () => {
    const index = new EdgeMatchIndex([tapEdge({ text: "Submit" })]);
    expect(index.findMatch(interactable({ text: "Cancel", clickable: true }))).toBeUndefined();
    expect(index.findMatch(interactable({ clickable: true }))).toBeUndefined();
  });

  test("ignores non-actionable tool names", () => {
    const edge: NavigationEdge = {
      from: "A",
      to: "B",
      timestamp: 1,
      edgeType: "tool",
      interaction: { toolName: "inputText", args: { text: "Submit" }, timestamp: 1 },
    };
    const index = new EdgeMatchIndex([edge]);
    expect(index.findMatch(interactable({ text: "Submit", clickable: true }))).toBeUndefined();
  });
});
