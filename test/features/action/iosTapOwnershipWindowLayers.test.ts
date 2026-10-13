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
  const result = resolve(nodes, row);
  expect(result.point).not.toEqual(candidate);
  if (result.point) {
    expect(contains(row.bounds!, result.point.x, result.point.y)).toBe(true);
    expect(contains(like.bounds!, result.point.x, result.point.y)).toBe(false);
    expect(contains(entry(nodes, "close-button").bounds!, result.point.x, result.point.y)).toBe(
      false,
    );
  } else {
    expect(result.coveredBy?.nativeId).toBe("like-button");
  }
});

test("front-window target is not covered by an app control behind it", () => {
  const close = entry(nodes, "close-button");
  const search = nodes.find((n) => n.className === "UISearchBar")!;
  const point = { x: 171, y: 815 };
  expect(search.rootGroup).toBe(close.rootGroup);
  expect(search.windowRank).toBeGreaterThan(close.windowRank);
  expect(contains(search.bounds!, point.x, point.y)).toBe(true);
  expect(contains(close.bounds!, point.x, point.y)).toBe(true);
  // Captured prototype controls have no scroll ancestor: preserve that early-return contract.
  expect(resolve(nodes, close, point)).toEqual({ point });
});

test("PIN: capture without layers still treats the same-rank button as an overlay", () => {
  const target = entry(unstampedNodes, "com.apple.settings.standBy");
  const button = entry(unstampedNodes, "like-button");
  expect(button.windowRank).toBe(target.windowRank);
  const result = resolve(unstampedNodes, target);
  expect(result.point).not.toEqual(candidate);
  if (result.point) {
    expect(contains(button.bounds!, result.point.x, result.point.y)).toBe(false);
  } else {
    expect(result.coveredBy?.nativeId).toBe("like-button");
  }
});
