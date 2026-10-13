import { expect, test } from "bun:test";
import { resolveIosOwnedTapPoint } from "../../../src/features/action/iosTapTargetOwnership";
import { CtrlProxyHierarchy } from "../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { HierarchyDelegateContext } from "../../../src/features/observe/ios/types";
import { IOS_WINDOW_LAYER_EXTRA } from "../../../src/features/observe/ios/iosWindowLayer";
import { contains } from "../../../src/features/observe/ApplicationWindowCover";
import {
  SearchableHierarchy,
  type SearchableEntry,
} from "../../../src/features/utility/SearchableNode";
import type { ViewHierarchyResult } from "../../../src/models";
import { iosFloatingOverlayOverSettings } from "../../fixtures/observe/iosOverlayWindow";

const hierarchy = new CtrlProxyHierarchy(
  {} as HierarchyDelegateContext,
).convertToViewHierarchyResult(iosFloatingOverlayOverSettings());
const nodes = new SearchableHierarchy().project(hierarchy);
// Swap only the window layers; preserve the captured hierarchy and bounds.
const swapped = JSON.parse(
  JSON.stringify(hierarchy, (key, value) => {
    if (key === IOS_WINDOW_LAYER_EXTRA) {
      return value === "0" ? "1" : value === "1" ? "0" : value;
    }
    return value;
  }),
) as ViewHierarchyResult;
const swappedNodes = new SearchableHierarchy().project(swapped);
// Same captured nodes, with the layer key renamed as in the existing overlay-window tests.
const unstamped = JSON.parse(
  JSON.stringify(hierarchy).replaceAll(`"${IOS_WINDOW_LAYER_EXTRA}"`, '"unrelated"'),
) as ViewHierarchyResult;
const unstampedNodes = new SearchableHierarchy().project(unstamped);
const entry = (entries: readonly SearchableEntry[], id: string) =>
  entries.find((n) => n.nativeId === id && n.element)!;
const row = entry(nodes, "com.apple.settings.standBy");
const like = entry(nodes, "like-button");
const candidate = { x: 96, y: 784 };
function resolve(entries: readonly SearchableEntry[], target: SearchableEntry, point = candidate) {
  const bounds = target.bounds!;
  return resolveIosOwnedTapPoint({
    nodes: entries,
    target,
    matched: [target],
    screen: { width: 402, height: 874 },
    visibleBounds: bounds,
    candidates: [point],
    isValid: (p): p is { x: number; y: number } => p !== null && contains(bounds, p.x, p.y),
  });
}

test("front-window button owns the candidate over a scrolling app row", () => {
  expect(like.rootGroup).toBe(row.rootGroup);
  expect(like.windowRank).toBeLessThan(row.windowRank);
  expect(contains(row.bounds!, candidate.x, candidate.y)).toBe(true);
  expect(contains(like.bounds!, candidate.x, candidate.y)).toBe(true);
  expect(resolve(nodes, row)).toEqual({ point: { x: 201, y: 762 } });
});

test("front-window target is not covered by an app control behind it", () => {
  const swappedRow = entry(swappedNodes, "com.apple.settings.standBy");
  const swappedLike = entry(swappedNodes, "like-button");
  expect(swappedLike.rootGroup).toBe(swappedRow.rootGroup);
  expect(swappedRow.windowRank).toBeLessThan(swappedLike.windowRank);
  expect(contains(swappedRow.bounds!, candidate.x, candidate.y)).toBe(true);
  expect(contains(swappedLike.bounds!, candidate.x, candidate.y)).toBe(true);
  expect(resolve(swappedNodes, swappedRow)).toEqual({ point: candidate });
});

test("PIN: capture without layers still treats the same-rank button as an overlay", () => {
  const target = entry(unstampedNodes, "com.apple.settings.standBy");
  const button = entry(unstampedNodes, "like-button");
  expect(button.windowRank).toBe(target.windowRank);
  expect(resolve(unstampedNodes, target)).toEqual({ point: { x: 201, y: 762 } });
});
