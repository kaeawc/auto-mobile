import { describe, expect, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import {
  projectSkeleton,
  projectSkeletonReplayRows,
} from "../../../../src/features/observe/output/SkeletonProjection";
import { getHierarchyNodeSource } from "../../../../src/features/observe/output/elementProvenance";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { createHierarchyForTest } from "../observeScreenTestBuilders";

const viewport = { width: 402, height: 874 };
const shadowBounds = { left: -140, top: -78, right: 297, bottom: 290 };
const bodyBounds = { left: 26, top: 95, right: 131, bottom: 116 };
const shadowId = "s2-7edfbf5215a4f07c";

function imageElements(overrides: Partial<Element> = {}): NonNullable<ObserveResult["elements"]> {
  return {
    clickable: [
      {
        class: "UIImageView",
        role: "image",
        clickable: "true",
        "view-id": shadowId,
        bounds: shadowBounds,
        ...overrides,
      },
    ],
    text: [],
    scrollable: [],
    media: [],
  };
}

describe("iOS compact popover shadow artwork", () => {
  test("drops the measured shadow without dropping popover context or replaying a tap row", () => {
    const hierarchy = createHierarchyForTest({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 402, bottom: 874 },
          node: [
            {
              class: "UIImageView",
              role: "image",
              clickable: "true",
              "view-id": shadowId,
              bounds: shadowBounds,
            },
            {
              class: "UIView",
              text: "dismiss popup",
              "resource-id": "PopoverDismissRegion",
              bounds: { left: 0, top: 0, right: 402, bottom: 874 },
            },
            {
              class: "UILabel",
              role: "text",
              text: "Popover body",
              "resource-id": "popover-body",
              bounds: bodyBounds,
            },
          ],
        },
      },
    });
    const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios")!;
    const projection = projectSkeleton(elements, viewport, undefined, { ios: true });
    expect(projection.skeleton).toEqual([]);
    expect(projection.context).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          elementId: "popover-body",
          label: "Popover body",
          affordances: [],
        }),
        expect.objectContaining({ elementId: "PopoverDismissRegion", affordances: [] }),
      ]),
    );
    expect(projection.context.some((row) => row.elementId === shadowId)).toBe(false);
    expect(projection.shadowed).toBeUndefined();
    const source = getHierarchyNodeSource(
      elements.clickable.find((el) => el["view-id"] === shadowId)!,
    );
    expect(source).toBeDefined();
    expect(projectSkeletonReplayRows(elements, projection).rowsBySource.has(source!)).toBe(false);
  });

  test("removes tap before geometric text hoisting and suppression", () => {
    const elements = imageElements();
    elements.text.push({ class: "UILabel", text: "Popover body", bounds: bodyBounds });
    const projection = projectSkeleton(elements, viewport, undefined, { ios: true });
    expect(projection.skeleton).toEqual([]);
    expect(projection.context).toMatchObject([{ label: "Popover body", affordances: [] }]);
  });

  test.each([
    { name: "labeled on-screen image", fields: { text: "Popover body", bounds: bodyBounds } },
    { name: "labeled overflowing image", fields: { text: "Popover body" } },
    { name: "native identified image", fields: { "resource-id": "popover-body" } },
    { name: "test-tagged image", fields: { "test-tag": "popover-body" } },
    { name: "unlabeled on-screen image", fields: { bounds: bodyBounds } },
    { name: "single-edge overflow", fields: { bounds: { ...shadowBounds, top: 0 } } },
    { name: "additional affordance", fields: { "long-clickable": true } },
  ])("keeps a $name actionable", ({ fields }) => {
    const projection = projectSkeleton(imageElements(fields), viewport, undefined, { ios: true });
    expect(projection.skeleton).toHaveLength(1);
    expect(projection.skeleton[0].affordances).toContain("tap");
  });

  test.each([
    undefined,
    { width: 0, height: 0 },
    { ...viewport, width: 0 },
    { ...viewport, height: 0 },
  ])("does nothing without a usable viewport: %j", (screen) => {
    const projection = projectSkeleton(imageElements(), screen, undefined, { ios: true });
    expect(projection.skeleton).toMatchObject([{ elementId: shadowId, affordances: ["tap"] }]);
  });

  test("leaves Android unchanged", () => {
    const elements = imageElements({ class: "android.widget.ImageView" });
    expect(projectSkeleton(elements, viewport, undefined, { ios: false }).skeleton).toMatchObject([
      { elementId: shadowId, affordances: ["tap"] },
    ]);
  });

  test.each([
    { left: -140, top: 0, right: 403, bottom: 290 },
    { left: 0, top: -78, right: 297, bottom: 875 },
    { left: 0, top: 0, right: 403, bottom: 875 },
  ])("counts overflowing sides independently for %j", (bounds) => {
    expect(
      projectSkeleton(imageElements({ bounds }), viewport, undefined, { ios: true }).skeleton,
    ).toEqual([]);
  });
});
