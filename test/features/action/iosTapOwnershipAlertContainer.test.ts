import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveIosOwnedTapPoint } from "../../../src/features/action/iosTapTargetOwnership";
import { contains } from "../../../src/features/observe/ApplicationWindowCover";
import {
  SearchableHierarchy,
  type SearchableEntry,
} from "../../../src/features/utility/SearchableNode";
import type { ElementBounds, ViewHierarchyResult } from "../../../src/models";
import { intersectBounds } from "../../../src/utils/bounds";

const hierarchy: ViewHierarchyResult = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/observe-output/ios-alert-over-table/viewHierarchy.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const nodes: readonly SearchableEntry[] = new SearchableHierarchy().project(hierarchy);
const alert: SearchableEntry = nodes.find((node) => node.className === "UIAlertController")!;
const deny: SearchableEntry = nodes.find(
  (node) => node.className === "UIButton" && node.label === "Don’t Allow",
)!;
const row: SearchableEntry = nodes.find(
  (node) => node.className === "UITableViewCell" && node.bounds?.top === 561,
)!;

function resolve(
  target: SearchableEntry,
  point: { x: number; y: number },
  bounds: ElementBounds = target.bounds!,
): ReturnType<typeof resolveIosOwnedTapPoint> {
  return resolveIosOwnedTapPoint({
    nodes,
    target,
    matched: [target],
    screen: { width: 402, height: 874 },
    visibleBounds: bounds,
    candidates: [point],
    isValid: (p): p is { x: number; y: number } => p !== null && contains(bounds, p.x, p.y),
  });
}

test("alert button is not covered by equal-rank app table cells underneath", () => {
  const point = { x: 201, y: 594 };
  expect(nodes.every((node) => node.windowRank === 0 && node.rootGroup === 0)).toBe(true);
  expect(nodes[deny.parentIndex!].className).toBe("UIScrollView");
  expect(nodes[nodes[deny.parentIndex!].parentIndex!]).toBe(alert);
  expect(contains(deny.bounds!, point.x, point.y)).toBe(true);
  expect(row.bounds).toEqual({ left: 27, top: 561, right: 374, bottom: 603 });
  expect(contains(row.bounds!, point.x, point.y)).toBe(true);
  expect(resolve(deny, point)).toEqual({ point });
});

test("PIN: equal-rank alert still covers an app row restricted to their overlap", () => {
  // Restrict the visible area so the row cannot escape to its uncovered left edge.
  const bounds = intersectBounds(row.bounds!, deny.bounds!)!;
  expect(nodes[row.parentIndex!].className).toBe("UICollectionView");
  expect(row.windowRank).toBe(alert.windowRank);
  expect(row.rootGroup).toBe(alert.rootGroup);
  expect(resolve(row, { x: 201, y: 586 }, bounds)).toEqual({
    point: null,
    coveredBy: alert,
    ownerInsideScrollContainer: false,
  });
});
