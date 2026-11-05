import { describe, expect, test } from "bun:test";
import { FocusNavigate, type FocusKeyPresser } from "../../src/features/action/FocusNavigate";
import { findFocusedElement } from "../../src/features/observe/HierarchyFocus";
import { scopeHierarchyToLayer } from "../../src/features/observe/hierarchyLayer";
import {
  nodeAttributes,
  type ViewHierarchyNode,
  type ViewHierarchyResult,
} from "../../src/models/ViewHierarchyResult";
import { createFocusNavigateObserver } from "../../src/server/focusNavigateTool";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { capturedFloatingCoverHierarchy, observationOf } from "../helpers/prototypeWindowCapture";

function capturedNode(hierarchy: ViewHierarchyResult, resourceId: string): ViewHierarchyNode {
  const root = hierarchy.hierarchy?.node;
  const pending: ViewHierarchyNode[] =
    root === undefined ? [] : Array.isArray(root) ? [...root] : [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (nodeAttributes(node)["resource-id"] === resourceId) {
      return node;
    }
    if (node.node) {
      pending.push(...(Array.isArray(node.node) ? node.node : [node.node]));
    }
  }
  throw new Error(`Captured node ${resourceId} is missing`);
}

// Reuse a real two-layer capture; only labels and focus flags model the TV scenario.
function observation(prototypeFocused = true) {
  const hierarchy = capturedFloatingCoverHierarchy();
  Object.assign(nodeAttributes(capturedNode(hierarchy, "tap_screen_title")), {
    text: "Add app to favorites",
    focused: true,
  });
  Object.assign(nodeAttributes(capturedNode(hierarchy, "coverBox")), {
    text: "Alpha",
    focused: prototypeFocused,
  });
  const result = observationOf(hierarchy);
  result.focusedElement = findFocusedElement(scopeHierarchyToLayer(hierarchy, "app")) ?? undefined;
  return result;
}

function harness(result: ReturnType<typeof observation>) {
  const screen = new FakeObserveScreen();
  screen.setObserveResult(result);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const presses: string[] = [];
  const keys: FocusKeyPresser = {
    press: async (key) => {
      presses.push(key);
      return { success: true };
    },
  };
  return {
    screen,
    timer,
    presses,
    navigate: new FocusNavigate(createFocusNavigateObserver(screen), keys, timer),
  };
}

describe("focusNavigate observation layers", () => {
  test("reports the focused prototype button ahead of the app focus in its path", async () => {
    const capture = observation();
    const prototypeFocus = findFocusedElement(
      scopeHierarchyToLayer(capture.viewHierarchy!, "prototype"),
    );
    expect(prototypeFocus?.text).toBe("Alpha");
    expect(capture.focusedElement?.text).toBe("Add app to favorites");
    const { navigate, screen, timer, presses } = harness(capture);
    const signal = new AbortController().signal;

    const result = await navigate.execute({ until: { text: "Alpha" }, signal });

    expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
    expect(result.path).toEqual([
      expect.objectContaining({
        text: "Alpha",
        resourceId: "coverBox",
        bounds: prototypeFocus!.bounds,
      }),
    ]);
    expect(result.focusedElement).toEqual(result.path[0]);
    expect(presses).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(screen.getExecuteOptions()).toEqual([
      { hierarchyOnly: true, skipScreenshot: true, skipCache: true, freshness: "fresh", signal },
    ]);
  });

  test("preserves app focus and path when no prototype is showing", async () => {
    const capture = observation();
    capture.viewHierarchy = scopeHierarchyToLayer(capture.viewHierarchy!, "app");
    const { navigate, timer, presses } = harness(capture);

    const result = await navigate.execute({ until: { text: "Add app to favorites" } });

    expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
    expect(result.path).toEqual([
      expect.objectContaining({ text: "Add app to favorites", resourceId: "tap_screen_title" }),
    ]);
    expect(result.focusedElement).toEqual(result.path[0]);
    expect(presses).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("records prototype focus changes after a D-pad press using only fake time", async () => {
    const initial = observation();
    nodeAttributes(capturedNode(initial.viewHierarchy!, "coverBox")).text = "Beta";
    const { navigate, screen, timer, presses } = harness(initial);
    screen.setObserveSequence([initial, observation()]);

    const result = await navigate.execute({ until: { text: "Alpha" } });

    expect(result).toMatchObject({ success: true, status: "focused", steps: 1 });
    expect(result.path.map((entry) => entry.text)).toEqual(["Beta", "Alpha"]);
    expect(result.focusedElement).toEqual(result.path[1]);
    expect(presses).toEqual(["arrow_down"]);
    expect(timer.getSleepHistory()).toEqual([200]);
  });

  test("falls back to the app when a showing prototype has no focused element", async () => {
    const { navigate, timer, presses } = harness(observation(false));

    const result = await navigate.execute({ until: { text: "Add app to favorites" } });

    expect(result).toMatchObject({ success: true, status: "focused", steps: 0 });
    expect(result.focusedElement).toMatchObject({ text: "Add app to favorites" });
    expect(presses).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });
});
