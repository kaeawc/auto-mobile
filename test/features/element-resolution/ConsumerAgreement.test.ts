import { expect, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { DebugSearch } from "../../../src/features/debug/DebugSearch";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ViewHierarchyResult } from "../../../src/models";

const bounds = { left: 0, top: 0, right: 100, bottom: 50 };
const project = (hierarchy: ViewHierarchyResult) => ({
  id: "agreement",
  nodes: new SearchableHierarchy().project(hierarchy),
});
const observed = (hierarchy: ViewHierarchyResult) =>
  projectSkeleton(new DefaultObserveElementCollector().collect(hierarchy, "ios")!).skeleton;

test("empty text editable value round-trips from the emitted label to input bounds", () => {
  const hierarchy = {
    hierarchy: {
      node: {
        bounds,
        class: "XCUIElementTypeTextField",
        text: "",
        "content-desc": "",
        value: "Alice",
        actions: ["click", "set_text"],
      },
    },
  };
  const row = observed(hierarchy).find((entry) => entry.label === "Alice")!;
  expect(row).toBeDefined();
  const result = new ElementResolver().resolve(
    project(hierarchy),
    { text: row.label },
    { action: "input" },
  );
  expect(result.chosen?.bounds).toEqual(bounds);
});

test("compact skeleton retains focus classification internally and synthetic IDs round-trip", () => {
  const hierarchy = {
    hierarchy: {
      node: {
        bounds,
        class: "CustomFocusHost",
        focusable: true,
        text: "Focus here",
        "view-id": "s-focus",
      },
    },
  };
  const snapshot = project(hierarchy);
  expect(snapshot.nodes[0].className).toBe("CustomFocusHost");
  expect(snapshot.nodes[0].focusable).toBe(true);
  const result = new ElementResolver().resolve(
    snapshot,
    { elementId: "s-focus" },
    { action: "focus" },
  );
  expect(result.chosen?.nativeId).toBeUndefined();
  expect(result.chosen?.bounds).toEqual(bounds);
  expect(
    new ElementResolver().resolve(snapshot, { elementId: "s-focus" }, { action: "tap" }).chosen,
  ).toBeNull();
});

test("folded padded row label is identical in observe, exact resolution and contains fallback", () => {
  const hierarchy = {
    hierarchy: {
      node: {
        bounds,
        clickable: true,
        text: " Alarm ",
        node: { bounds: { left: 1, top: 1, right: 20, bottom: 20 }, text: " 8:30 AM " },
      },
    },
  };
  const row = observed(hierarchy).find((entry) => entry.affordances.includes("tap"))!;
  expect(row.label).toBe("8:30 AM  Alarm");
  expect(row.label).toBe(row.label?.trim());
  const resolver = new ElementResolver();
  expect(
    resolver.resolve(project(hierarchy), { text: row.label }, { action: "tap" }).chosen?.bounds,
  ).toEqual(bounds);
  const partial = resolver.resolve(project(hierarchy), { text: "8:30" }, { action: "tap" });
  expect(partial.matchMode).toBe("contains");
  expect(partial.chosen?.bounds).toEqual(bounds);
});

test("debug, tap and highlight agree on scoped default target and ranked explicit indices", async () => {
  const child = (id: string, size: number, clickable = true) => ({
    "resource-id": id,
    text: "Save",
    clickable,
    bounds: { left: 0, top: 0, right: size, bottom: size },
  });
  const hierarchy = {
    hierarchy: {
      node: [
        child("outside", 1),
        {
          "resource-id": "scope",
          bounds: { left: 0, top: 0, right: 500, bottom: 500 },
          node: [child("label", 5, false), child("first", 100), child("second", 20)],
        },
      ],
    },
  };
  const container = { elementId: "scope" };
  const selector = new ResolverElementSelector();
  const tap = selector.selectByText(hierarchy, "Save", { container });
  const highlight = selector.selectByText(hierarchy, "Save", {
    container,
    intentAction: "highlight",
  });
  const debug = new DebugSearch(
    { name: "test", deviceId: "agreement", platform: "android" },
    undefined,
    new FakeTimer(),
    undefined,
    {
      capture: async (request) => ({
        captureId: "agreement",
        platform: "android",
        requestedFreshness: request.freshness,
        receivedAt: 0,
        hierarchy,
        nodes: project(hierarchy).nodes,
      }),
    },
  );
  const result = await debug.execute({ text: "Save", container });
  expect(tap.element?.["resource-id"]).toBe("second");
  expect(result.selectedMatch?.resourceId).toBe("second");
  // Highlight can intentionally target a bounded inert label; tap eligibility is distinct.
  expect(highlight.element?.["resource-id"]).toBe("label");
  expect(
    selector.selectByText(hierarchy, "Save", { container, index: 0 }).element?.["resource-id"],
  ).toBe("first");
  expect(result.matches.some((entry) => entry.resourceId === "outside")).toBe(false);
});
