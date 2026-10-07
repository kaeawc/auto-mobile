import { describe, expect, test } from "bun:test";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import type { ViewHierarchyResult } from "../../../src/models";

const bounds = (top: number, bottom: number) => ({ left: 0, top, right: 100, bottom });
const finder = new DefaultElementFinder();
const selector = new ResolverElementSelector();

describe("resolver selector compatibility with the shared resolution contract", () => {
  test("container text uses an exact match before a partial row and falls back when absent", () => {
    const partial = {
      text: "Inbox (12)",
      bounds: bounds(0, 100),
      node: [{ text: "Target", bounds: bounds(10, 30) }],
    };
    const exact = {
      text: "Inbox",
      bounds: bounds(100, 200),
      node: [{ text: "Target", bounds: bounds(110, 130) }],
    };
    const capture: ViewHierarchyResult = { hierarchy: { node: [partial, exact] } };
    expect(finder.findElementsByText(capture, "Target", { text: "Inbox" })[0]?.bounds.top).toBe(
      110,
    );
    expect(
      finder.findElementsByText({ hierarchy: { node: [partial] } }, "Target", { text: "Inbox" })[0]
        ?.bounds.top,
    ).toBe(10);
    const production = new ResolverElementSelector();
    expect(production.hasContainer(capture, { text: "Inbox" })).toBe(true);
    expect(
      production.selectByText(capture, "Inbox", { intentAction: "inspect" }).element?.text,
    ).toBe("Inbox");
    expect(
      production.selectByText({ hierarchy: { node: [partial] } }, "Inbox", {
        intentAction: "inspect",
      }).element?.text,
    ).toBe("Inbox (12)");
  });

  test("qualified native ID wins over a smaller bare Compose fallback", () => {
    const capture: ViewHierarchyResult = {
      hierarchy: {
        node: [
          { "resource-id": "action", bounds: bounds(0, 10), clickable: true },
          { "resource-id": "pkg:id/action", bounds: bounds(10, 110), clickable: true },
        ],
      },
    };
    expect(
      finder.findElementsByResourceId(capture, "pkg:id/action").map((el) => el["resource-id"]),
    ).toEqual(["pkg:id/action"]);
    expect(
      finder.findElementsByResourceId(
        { hierarchy: { node: [{ "resource-id": "action", bounds: bounds(0, 10) }] } },
        "pkg:id/action",
      )[0]?.["resource-id"],
    ).toBe("action");
  });

  test("id-less runner view IDs round-trip, outrank a bare suffix, and reject duplicates", () => {
    const view = { "view-id": "runner/path", bounds: bounds(10, 110), clickable: true };
    const capture: ViewHierarchyResult = {
      hierarchy: {
        node: [{ "resource-id": "path", bounds: bounds(0, 10), clickable: true }, view],
      },
    };
    expect(selector.selectByResourceId(capture, "runner/path").element?.["view-id"]).toBe(
      "runner/path",
    );
    expect(() =>
      finder.findElementsByResourceId(
        { hierarchy: { node: [view, { ...view, bounds: bounds(120, 220) }] } },
        "runner/path",
      ),
    ).toThrow("ambiguous");
  });

  test("skeleton duplicate indexes replay area-ranked controls through the production selector", () => {
    const capture: ViewHierarchyResult = {
      hierarchy: {
        node: [
          { "resource-id": "pkg:id/repeat", bounds: bounds(0, 100), clickable: true },
          { "resource-id": "pkg:id/repeat", bounds: bounds(120, 140), clickable: true },
        ],
      },
    };
    const collected = new DefaultObserveElementCollector().collect(capture, "android");
    const rows = projectSkeleton(collected!, { width: 100, height: 200 }).skeleton.filter(
      (row) => row.elementId === "pkg:id/repeat",
    );
    expect(rows).toHaveLength(2);
    const production = new ResolverElementSelector();
    for (const row of rows) {
      expect(
        production.selectByResourceId(capture, "pkg:id/repeat", { index: row.index }).element
          ?.bounds,
      ).toEqual({
        left: row.bounds[0],
        top: row.bounds[1],
        right: row.bounds[2],
        bottom: row.bounds[3],
      });
    }
    expect(rows.find((row) => row.index === 0)?.bounds[1]).toBe(120);
    expect(production.selectByResourceId(capture, "pkg:id/repeat").element?.bounds.top).toBe(120);
  });
});
