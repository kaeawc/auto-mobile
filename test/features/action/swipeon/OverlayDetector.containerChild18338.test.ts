import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { OverlayDetector } from "../../../../src/features/action/swipeon/OverlayDetector";
import { resolveContainerSwipeCoordinates } from "../../../../src/features/action/swipeon/resolveContainerSwipeCoordinates";
import type { OverlayAnalyzer } from "../../../../src/features/action/swipeon/types";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import type {
  Element,
  ElementBounds,
  ObserveResult,
  ViewHierarchyNode,
} from "../../../../src/models";
import { observeResultFromJsonText } from "../../../helpers/observeFixture";
import { FakeOverlayDetector } from "../../../fakes/FakeOverlayDetector";

const observation = observeResultFromJsonText(
  readFileSync(
    new URL(
      "../../../fixtures/observe-output/swipeon-container-floating-bar-18338/observe-full.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const bounds = { left: 0, top: 636, right: 1080, bottom: 2064 };
const container: Element = { bounds, scrollable: true };
const geometry = new DefaultElementGeometry();
const detector = new OverlayDetector(geometry, new DefaultElementParser());
const barBounds = [
  { left: 42, top: 1875, right: 870, bottom: 2022 },
  { left: 891, top: 1875, right: 1038, bottom: 2022 },
];

function resolve(
  observeResult: ObserveResult,
  platform: "android" | "ios" = "android",
  overlayDetector: OverlayAnalyzer = detector,
) {
  const viewHierarchy = observeResult.viewHierarchy;
  if (!viewHierarchy) {
    throw new Error("Expected a captured hierarchy");
  }
  return resolveContainerSwipeCoordinates({
    geometry,
    overlayDetector,
    options: { direction: "up" },
    viewHierarchy,
    containerElement: container,
    observeResult,
    platform,
  });
}

const node = (
  nodeBounds: ElementBounds,
  attributes: Record<string, unknown> = {},
  children: ViewHierarchyNode[] = [],
): ViewHierarchyNode => ({ $: { bounds: nodeBounds, ...attributes }, node: children });

function withChildren(children: ViewHierarchyNode[]): ObserveResult {
  return {
    ...observation,
    viewHierarchy: { hierarchy: { node: node(bounds, { scrollable: true }, children) } },
  };
}

describe("Android container-child overlays (#18338)", () => {
  test("starts outside both captured floating controls, including their 8px padding", () => {
    expect(
      detector
        .collectOverlayCandidates(observation.viewHierarchy!, container, "android")
        .map((overlay) => overlay.bounds),
    ).toEqual(barBounds);
    const swipe = resolve(observation);
    for (const overlay of barBounds) {
      const inside =
        swipe.startX >= overlay.left - 8 &&
        swipe.startX <= overlay.right + 8 &&
        swipe.startY >= overlay.top - 8 &&
        swipe.startY <= overlay.bottom + 8;
      expect(inside).toBe(false);
    }
    expect(swipe.warning).toBeUndefined();
    expect(swipe).toEqual({ startX: 540, startY: 1743, endX: 540, endY: 759, warning: undefined });
  });

  test("keeps the default swipe and no warning for clickable rows filling a plain list", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      node(
        { ...bounds, top: 636 + index * 119, bottom: 636 + (index + 1) * 119 },
        { clickable: true },
      ),
    );
    expect(resolve(withChildren(rows))).toEqual(geometry.getSwipeWithinBounds("up", bounds));
  });

  test("never treats controls within a nested scrollable as overlays", () => {
    const nested = node(bounds, { scrollable: true }, [
      node({ ...bounds, bottom: 1700 }, { scrollable: true }),
      ...barBounds.map((bar) => node(bar, { clickable: true })),
    ]);
    expect(resolve(withChildren([nested]))).toEqual(geometry.getSwipeWithinBounds("up", bounds));
  });

  test("does not change the iOS descendant exemption", () => {
    const hierarchy = withChildren([
      node({ left: 42, top: 932, right: 1038, bottom: 1833 }, { scrollable: true }),
      ...barBounds.map((bar) => node(bar, { clickable: true })),
    ]);
    expect(resolve(hierarchy, "ios")).toEqual(resolve(hierarchy, "ios", new FakeOverlayDetector()));
  });

  test("exempts earlier controls, interior cards, scrollables and controls with actionable children", () => {
    const edgeControl = node(barBounds[0], { clickable: true });
    const hierarchy = withChildren([
      edgeControl,
      node({ left: 42, top: 932, right: 1038, bottom: 1833 }, { scrollable: true }),
      node({ left: 100, top: 1200, right: 980, bottom: 1450 }, { clickable: true }),
      node(barBounds[0], { clickable: true, scrollable: true }),
      node(barBounds[1], { clickable: true }, [node(barBounds[1], { clickable: true })]),
    ]);
    expect(resolve(hierarchy)).toEqual(geometry.getSwipeWithinBounds("up", bounds));
  });
});
