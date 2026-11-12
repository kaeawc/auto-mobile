import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import {
  projectSkeleton,
  projectSkeletonReplayRows,
} from "../../../../src/features/observe/output/SkeletonProjection";
import { getHierarchyNodeSource } from "../../../../src/features/observe/output/elementProvenance";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import { createHierarchyForTest } from "../observeScreenTestBuilders";

const viewport = { width: 402, height: 874 };
const shadowBounds = { left: -140, top: -78, right: 297, bottom: 290 };
const bodyBounds = { left: 26, top: 95, right: 131, bottom: 116 };
const shadowId = "s2-7edfbf5215a4f07c";
const listDialog: ViewHierarchyResult = JSON.parse(
  readFileSync(
    new URL(
      "../../../fixtures/ios-presentation-chrome/ios26_5-listConfirmationDialog-open.viewHierarchy.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

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
  test.each([
    { file: "ios18_6-menu-open", labels: ["Item One", "Item Two"] },
    { file: "ios26_5-confirmationDialog-open", labels: ["Option A", "Delete"] },
    { file: "ios26_5-listConfirmationDialog-open", labels: ["Option 1", "Delete"] },
  ])("keeps the captured $file actions tappable", ({ file, labels }) => {
    const hierarchy: ViewHierarchyResult = JSON.parse(
      readFileSync(
        new URL(
          `../../../fixtures/ios-presentation-chrome/${file}.viewHierarchy.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios")!;
    const projection = projectSkeleton(elements, viewport, undefined, { ios: true });
    for (const label of labels) {
      const row = projection.skeleton.find((row) => row.label === label);
      expect(row).toBeDefined();
      expect(row?.affordances).toContain("tap");
      expect(row?.occluded).toBeUndefined();
      expect(projection.context.some((row) => row.label === label && row.occluded)).toBe(false);
    }
  });

  test("PIN: one-edge overflow that does not contain the presentation remains a cover", () => {
    const hierarchy = structuredClone(listDialog);
    const shadow = new SearchableHierarchy()
      .project(hierarchy)
      .find((node) => node.className === "UIImageView")!;
    expect(shadow.nativeId).toBeUndefined();
    expect(shadow.label).toBeUndefined();
    expect(shadow.nodeKey).toBe(shadowId);
    // Covers Option 1, but stops short of the UIActionSheet and its scroll container.
    shadow.source.$!.bounds = [-140, 109, 400, 379];
    const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios")!;
    const projection = projectSkeleton(elements, viewport, undefined, { ios: true });
    expect(projection.skeleton.find((row) => row.elementId === shadowId)?.affordances).toContain(
      "tap",
    );
    expect(
      [...projection.skeleton, ...projection.context].some(
        (row) => row.label === "Option 1" && row.occluded,
      ),
    ).toBe(true);
  });

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
