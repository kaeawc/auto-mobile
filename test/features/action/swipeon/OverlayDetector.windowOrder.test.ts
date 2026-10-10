import { describe, expect, test } from "bun:test";
import { OverlayDetector } from "../../../../src/features/action/swipeon/OverlayDetector";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import type { Element, ViewHierarchyResult } from "../../../../src/models";
import { FakeElementGeometry } from "../../../fakes/FakeElementGeometry";
import {
  capturedAppLayerPrototypeHierarchy,
  capturedFloatingCoverHierarchy,
  capturedPrototypeHierarchy,
} from "../../../helpers/prototypeWindowCapture";

// Device captures in test/fixtures/android-overlay-window/ (see README.txt there) and the
// relabelled Recents capture: an AutoMobile prototype window drawn above an app window.
function candidatesFor(hierarchy: ViewHierarchyResult, matches: (element: Element) => boolean) {
  const parser = new DefaultElementParser();
  const container = parser
    .flattenViewHierarchy(hierarchy)
    .map(({ element }) => element)
    .find(matches)!;
  expect(container).toBeDefined();
  const detector = new OverlayDetector(new FakeElementGeometry(), parser);
  return {
    container,
    detector,
    candidates: detector.collectOverlayCandidates(hierarchy, container),
  };
}

const byId = (id: string) => (element: Element) => element["resource-id"] === id;

describe("OverlayDetector window order (#10752)", () => {
  test("app buttons under a prototype window do not obstruct a container inside that prototype", () => {
    // coverBox [525,1565,1011,1723] in prototype window 170 sits over the Playground's
    // button_elevated [550,1589,996,1715] and its left neighbour in app window 150.
    const { container, detector, candidates } = candidatesFor(
      capturedFloatingCoverHierarchy(),
      byId("coverBox"),
    );

    expect(candidates).toEqual([]);
    const swipe = detector.computeSafeSwipeCoordinates(
      "left",
      container.bounds,
      candidates.map((candidate) => candidate.overlapBounds),
    );
    expect(swipe?.warning).toBeUndefined();
  });

  test("a node of the prototype window still obstructs an app container below it", () => {
    // The app-layer prototype (window 174) shows a clickable "Bump" over tap_screen_content.
    const { candidates } = candidatesFor(
      capturedAppLayerPrototypeHierarchy(),
      byId("tap_screen_content"),
    );

    expect(candidates.map((candidate) => candidate.bounds)).toEqual([
      { left: 402, top: 1180, right: 585, bottom: 1306 },
      { left: 552, top: 1064, right: 710, bottom: 1190 },
    ]);
  });

  test("an app container keeps both higher-window and same-window obstructions", () => {
    const { candidates } = candidatesFor(
      capturedPrototypeHierarchy(),
      byId("com.google.android.apps.nexuslauncher:id/overview_panel"),
    );

    const ranks = candidates.map((candidate) => candidate.zOrder.windowRank);
    // Prototype window (predicted-apps row) above the app, plus the app's own action buttons.
    expect(ranks.filter((rank) => rank === 3)).toHaveLength(8);
    expect(ranks.filter((rank) => rank === 1)).toHaveLength(3);
  });

  test("a same-window sibling of a container inside the prototype still obstructs it", () => {
    // "Bump" and its neighbour live in the same prototype window; the neighbour stays an obstruction.
    const { candidates } = candidatesFor(capturedAppLayerPrototypeHierarchy(), byId("bump"));

    expect(candidates.map((candidate) => candidate.bounds)).toEqual([
      { left: 552, top: 1064, right: 710, bottom: 1190 },
    ]);
  });
});
