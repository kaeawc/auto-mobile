import { describe, expect, test } from "bun:test";
import { OverlayDetector } from "../../../../src/features/action/swipeon/OverlayDetector";
import type { SwipeDirection, ViewHierarchyResult } from "../../../../src/models";
import { FakeElementFinder } from "../../../fakes/FakeElementFinder";
import { FakeElementGeometry } from "../../../fakes/FakeElementGeometry";
import { FakeElementParser } from "../../../fakes/FakeElementParser";
import capture from "../../../fixtures/observe/android-container-scope.json";

describe("OverlayDetector safe swipe coordinate characterization", () => {
  const cases: Array<{
    direction: SwipeDirection;
    expected: {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      warning: string | undefined;
    };
  }> = [
    {
      direction: "up",
      expected: { startX: 255, startY: 247, endX: 255, endY: 200, warning: undefined },
    },
    {
      direction: "down",
      expected: { startX: 255, startY: 247, endX: 255, endY: 200, warning: undefined },
    },
    {
      direction: "left",
      expected: { startX: 200, startY: 150, endX: 200, endY: 150, warning: undefined },
    },
    {
      direction: "right",
      expected: { startX: 200, startY: 150, endX: 200, endY: 150, warning: undefined },
    },
  ];
  for (const { direction, expected } of cases) {
    test(`selects exact ${direction} coordinates around captured sibling overlays`, () => {
      const parser = new FakeElementParser();
      const root = parser.extractRootNodes(capture.viewHierarchy as ViewHierarchyResult)[0];
      const container = parser.parseNodeBounds(root)!;
      const detector = new OverlayDetector(
        new FakeElementFinder(),
        new FakeElementGeometry(),
        parser,
      );
      const overlays = parser
        .flattenViewHierarchy(capture.viewHierarchy as ViewHierarchyResult)
        .map(({ element }) => element)
        .filter((element) => element.clickable);
      expect(overlays).toHaveLength(4);
      expect(
        detector.computeSafeSwipeCoordinates(
          direction,
          container.bounds,
          overlays.map((overlay) => overlay.bounds),
        ),
      ).toEqual(expected);
    });
  }

  test("keeps the first candidate when gaps tie and clamps geometry to captured bounds", () => {
    const parser = new FakeElementParser();
    const container = parser.parseNodeBounds(
      parser.extractRootNodes(capture.viewHierarchy as ViewHierarchyResult)[0],
    )!;
    const geometry = new FakeElementGeometry();
    geometry.swipeResult = { startX: -10, startY: 999, endX: 999, endY: -10 };
    const detector = new OverlayDetector(new FakeElementFinder(), geometry, parser);
    expect(detector.computeSafeSwipeCoordinates("down", container.bounds, [])).toEqual({
      startX: 150,
      startY: 300,
      endX: 150,
      endY: 0,
      warning: undefined,
    });
    expect(detector.computeSafeSwipeCoordinates("right", container.bounds, [])).toEqual({
      startX: 0,
      startY: 150,
      endX: 300,
      endY: 150,
      warning: undefined,
    });
  });

  test("returns null when a captured container bound fully covers the swipe area", () => {
    const parser = new FakeElementParser();
    const container = parser.parseNodeBounds(
      parser.extractRootNodes(capture.viewHierarchy as ViewHierarchyResult)[0],
    )!;
    const detector = new OverlayDetector(
      new FakeElementFinder(),
      new FakeElementGeometry(),
      parser,
    );
    expect(
      detector.computeSafeSwipeCoordinates("up", container.bounds, [container.bounds]),
    ).toBeNull();
    expect(
      detector.computeSafeSwipeCoordinates("left", container.bounds, [container.bounds]),
    ).toBeNull();
  });
});
