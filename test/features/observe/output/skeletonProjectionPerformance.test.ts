import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import {
  deriveId,
  type SkeletonAccumulator,
} from "../../../../src/features/observe/output/skeletonProjection/rowModel";
import { assignDuplicateIndexes } from "../../../../src/features/observe/output/skeletonProjection/selectorIndexes";
import * as searchable from "../../../../src/features/utility/SearchableNode";
import * as imeIds from "../../../../src/features/observe/android/ImeKeycapIds";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import type { Element } from "../../../../src/models/Element";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { viewHierarchyFromFixture } from "../../../helpers/observeFixture";

// SHA-256 of JSON.stringify(projectSkeleton(...)), captured from origin/main
// 8fefebe1a3be17190664727b42ae40a873179b07 before the performance change.
const captures = [
  [
    "android-focus/playground-text-field-post-tap.json",
    "android",
    "a567b45c32dddc6bb487bff8e91b394460373b5f4649b6c94d927ede642b5af9",
  ],
  [
    "android-overlay-window/app-layer-overlay-over-playground.raw.json",
    "android",
    "66e5cb7be0a872ce177fcce02365820650452b768c67e41184338d364a06f67f",
  ],
  [
    "ios/nested-selection/cart-a-item-44-quantity-focused.json",
    "ios",
    "200155b689a142a62d406a8c2457755d7eb0871307f7a72e34a388b16bae2d32",
  ],
  [
    "observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json",
    "ios",
    "d8c8fcb0bf49bc3460f59ff76df330b33886110ad9da93bd9d5815b36e10e9e6",
  ],
  [
    "observe/diff/text-input-typed.json",
    "android",
    "c99d9c3d1d74de477a56015a6c3884535318953aaeb7d0cbd399aa544a9ff75c",
  ],
] as const;

describe.each(captures)("projectSkeleton captured bytes: %s", (file, platform, hash) => {
  let serialized: string;
  beforeAll(() => {
    // The post-tap capture contains only a hierarchy, so it has no viewport.
    const raw: { viewHierarchy: unknown; screenSize?: ObserveResult["screenSize"] } = JSON.parse(
      readFileSync(new URL(`../../../fixtures/${file}`, import.meta.url), "utf8"),
    );
    const hierarchy = viewHierarchyFromFixture(raw.viewHierarchy);
    const elements = new DefaultObserveElementCollector().collect(hierarchy, platform)!;
    serialized = JSON.stringify(
      projectSkeleton(elements, raw.screenSize, platform === "android" ? hierarchy : undefined, {
        ios: platform === "ios",
        iosHierarchy: hierarchy,
      }),
    );
  });
  test("matches the pre-optimization golden hash", () => {
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(hash);
  });
});

test.each([
  [undefined, undefined],
  ["", "fallback"],
  [" \t", "fallback"],
  [" native ", "fallback"],
  [undefined, " stable "],
  ["", ""],
  [undefined, " \n"],
] as const)(
  "deriveId preserves searchable ID rules (%p, %p) without projecting labels",
  (nativeId, viewId) => {
    const element: Element = {
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      "resource-id": nativeId,
      "view-id": viewId,
    };
    const expected = searchable.toSearchable(element).elementId;
    const searchSpy = spyOn(searchable, "toSearchable");
    try {
      for (let i = 0; i < 10; i++) {
        expect(deriveId(element)).toBe(expected);
      }
      expect(searchSpy).toHaveBeenCalledTimes(0);
    } finally {
      searchSpy.mockRestore();
    }
  },
);

function node(index: number, properties: Partial<Element>): searchable.SearchableEntry {
  const element: Element = {
    bounds: { left: 0, top: index * 10, right: 10, bottom: index * 10 + 10 },
    ...properties,
  };
  return {
    ...searchable.toSearchable(element),
    properties: element,
    source: { $: element },
    index,
    depth: 0,
    rootGroup: 0,
    windowRank: 0,
  };
}

test.each([1, 4, 12])(
  "assignDuplicateIndexes filters IME keys once for %i duplicate groups",
  (groups) => {
    const key = node(0, {
      "resource-id": "keyboard:id/key_pos_a",
      text: "duplicate",
      clickable: true,
    });
    key.inputMethod = { package: "keyboard" };
    const nodes = [key];
    const rows: SkeletonAccumulator[] = [];
    for (let group = 0; group < groups; group++) {
      for (let copy = 0; copy < 2; copy++) {
        const entry = node(nodes.length, {
          "resource-id": `app:id/${group}`,
          text: "duplicate",
          clickable: true,
        });
        nodes.push(entry);
        const b = entry.bounds!;
        rows.push({
          elementId: entry.elementId,
          label: entry.displayedLabel,
          bounds: [b.left, b.top, b.right, b.bottom],
          affordances: new Set(["tap"]),
        });
      }
    }
    const filterSpy = spyOn(searchable, "isImeKeyEntry");
    const idSpy = spyOn(imeIds, "isImeOwnedId");
    try {
      assignDuplicateIndexes(rows, undefined, nodes);
      expect(filterSpy).toHaveBeenCalledTimes(nodes.length);
      expect(idSpy).toHaveBeenCalledTimes(1);
      expect(rows.map((row) => row.index)).toEqual(
        Array.from({ length: groups }, () => [0, 1]).flat(),
      );
    } finally {
      filterSpy.mockRestore();
      idSpy.mockRestore();
    }
  },
);

test("a prefiltered resolver search preserves ancestry indexes and the app ID namespace", () => {
  const key = node(0, {
    "resource-id": "keyboard:id/key_pos_a",
    "view-id": "s2-0123456789abcdef-2",
    clickable: true,
  });
  key.inputMethod = { package: "keyboard" };
  const parent = node(1, { "view-id": "s2-0123456789abcdef", clickable: true });
  const child = node(2, { text: "Child label" });
  child.parentIndex = 1;
  const nodes = [key, parent, child];
  const searchedNodes = nodes.filter((entry) => !searchable.isImeKeyEntry(entry));
  const resolver = new ElementResolver();
  for (const selector of [{ text: "Child label" }, { elementId: parent.nodeKey }]) {
    const original = resolver.resolve({ id: "test", nodes }, selector, {
      action: "tap",
      excludeImeKeys: true,
    });
    const filtered = resolver.resolve({ id: "test", nodes, searchedNodes }, selector, {
      action: "tap",
      excludeImeKeys: false,
    });
    expect(original.chosen).toBe(parent);
    expect(filtered.chosen).toBe(parent);
    expect(filtered.candidates).toEqual(original.candidates);
  }
});
