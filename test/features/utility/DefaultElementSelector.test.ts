import { describe, expect, test } from "bun:test";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import type { ElementBounds } from "../../../src/models";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

type NodeSpec = {
  bounds: ElementBounds;
  text?: string;
  resourceId?: string;
};

const createViewHierarchy = (nodes: NodeSpec[]): ViewHierarchyResult => {
  return {
    hierarchy: {
      node: {
        $: {
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          class: "android.widget.FrameLayout"
        },
        node: nodes.map(node => ({
          $: {
            bounds: node.bounds,
            class: "android.widget.TextView",
            ...(node.text ? { text: node.text } : {}),
            ...(node.resourceId ? { "resource-id": node.resourceId } : {})
          }
        }))
      }
    },
    screenWidth: 100,
    screenHeight: 100
  } as ViewHierarchyResult;
};

describe("DefaultElementSelector", () => {
  test("first strategy returns smallest exact match", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 30, bottom: 30 }, text: "Match" },
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Match" }
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element?.bounds).toEqual({ left: 0, top: 0, right: 10, bottom: 10 });
    expect(match.indexInMatches).toBe(0);
    expect(match.totalMatches).toBe(2);
    expect(match.strategy).toBe("first");
  });

  test("first strategy skips off-screen matches before selecting", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: -20, top: 0, right: -10, bottom: 10 }, text: "Match" },
      { bounds: { left: 10, top: 0, right: 40, bottom: 30 }, text: "Match" }
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element?.bounds).toEqual({ left: 10, top: 0, right: 40, bottom: 30 });
    expect(match.indexInMatches).toBe(1);
    expect(match.totalMatches).toBe(2);
  });

  test("returns null when every match is off-screen", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: -300, top: 0, right: -200, bottom: 30 }, text: "Match" },
      { bounds: { left: 120, top: 0, right: 160, bottom: 30 }, text: "Match" }
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element).toBeNull();
    expect(match.indexInMatches).toBe(-1);
    expect(match.totalMatches).toBe(2);
  });

  test("random strategy returns different matches across calls", () => {
    const randomValues = [0, 0.99];
    const random = () => randomValues.shift() ?? 0;
    const selector = new DefaultElementSelector(new DefaultElementFinder(), random);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Match" },
      { bounds: { left: 0, top: 0, right: 20, bottom: 20 }, text: "Match" }
    ]);

    const first = selector.selectByText(viewHierarchy, "Match", { strategy: "random" });
    const second = selector.selectByText(viewHierarchy, "Match", { strategy: "random" });

    expect(first.element?.bounds).not.toEqual(second.element?.bounds);
    expect(first.indexInMatches).toBe(0);
    expect(second.indexInMatches).toBe(1);
    expect(first.totalMatches).toBe(2);
    expect(second.totalMatches).toBe(2);
  });

  test("random strategy prefers exact matches over fuzzy", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0.9);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Match" },
      { bounds: { left: 0, top: 0, right: 20, bottom: 20 }, text: "Match 2" }
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "random" });

    expect(match.element?.text).toBe("Match");
    expect(match.totalMatches).toBe(1);
  });

  test("returns null when no matches are found", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Other" }
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element).toBeNull();
    expect(match.indexInMatches).toBe(-1);
    expect(match.totalMatches).toBe(0);
  });

  test("random strategy returns single match for resource ID", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0.5);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, resourceId: "test:id/button" }
    ]);

    const match = selector.selectByResourceId(viewHierarchy, "test:id/button", { strategy: "random" });

    expect(match.element?.["resource-id"]).toBe("test:id/button");
    expect(match.totalMatches).toBe(1);
  });
});
