import { expect, test } from "bun:test";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import containerFixture from "../../fixtures/observe/android-container-scope.json";
import {
  assignStableViewIds,
  STABLE_VIEW_ID_PREFIX,
} from "../../../src/features/observe/android/StableNodeIdentity";

const resolver = new ElementResolver();
const tap = { action: "tap" as const };

test("nested scopes resolve outer to inner and identify the failing level", () => {
  const original = containerFixture.viewHierarchy.hierarchy.node;
  const hierarchy = { hierarchy: { node: { "resource-id": "cart_A", node: original } } };
  const capture = { id: "nested", nodes: new SearchableHierarchy().project(hierarchy) };
  const query = {
    elementId: "action",
    selectionStrategy: "unique" as const,
    container: {
      elementId: "left",
      selectionStrategy: "unique" as const,
      container: { elementId: "cart_A", selectionStrategy: "unique" as const },
    },
  };
  expect(resolver.resolve(capture, query, tap).chosen?.bounds?.top).toBe(40);
  expect(
    resolver.resolve(
      capture,
      { ...query, container: { ...query.container, elementId: "missing" } },
      tap,
    ).error,
  ).toContain("Container level 2 not found");
  expect(
    resolver.resolve(
      capture,
      { ...query, container: { ...query.container, container: { elementId: "missing" } } },
      tap,
    ).error,
  ).toContain("Container level 1 not found");
  expect(resolver.resolve(capture, { ...query, elementId: "missing" }, tap).error).toBe(
    "Target not found within container",
  );
});

test("unique scopes fail before considering a matching descendant and indices stay scoped", () => {
  const hierarchy = {
    hierarchy: {
      node: [
        {
          "resource-id": "cart",
          node: [
            {
              "resource-id": "row",
              node: [
                {
                  "resource-id": "action",
                  clickable: true,
                  bounds: { left: 0, top: 0, right: 10, bottom: 10 },
                },
              ],
            },
          ],
        },
        {
          "resource-id": "cart",
          node: [
            {
              "resource-id": "row",
              node: [
                {
                  "resource-id": "other",
                  clickable: true,
                  bounds: { left: 20, top: 0, right: 30, bottom: 10 },
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const capture = { id: "duplicates", nodes: new SearchableHierarchy().project(hierarchy) };
  const selector = {
    elementId: "action",
    container: {
      elementId: "row",
      container: { elementId: "cart", selectionStrategy: "unique" as const },
    },
  };
  expect(resolver.resolve(capture, selector, tap).error).toContain("Container level 1 ambiguous");
  expect(
    resolver.resolve(capture, { ...selector, selectionStrategy: "unique" }, tap).error,
  ).toContain("Container level 1 ambiguous");
  expect(
    resolver.resolve(
      capture,
      {
        ...selector,
        container: { ...selector.container, container: { elementId: "cart", index: 0 } },
      },
      tap,
    ).chosen?.nativeId,
  ).toBe("action");
  expect(
    resolver.resolve(
      capture,
      {
        ...selector,
        container: { ...selector.container, container: { elementId: "cart", index: 2 } },
      },
      tap,
    ).error,
  ).toContain("Container level 1 not found");
});

test("text container stays on its matching child instead of promoted row", () => {
  const hierarchy = {
    hierarchy: {
      node: [
        {
          clickable: true,
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          node: [
            { text: "Header", bounds: { left: 0, top: 0, right: 50, bottom: 20 } },
            {
              text: "Target",
              clickable: true,
              bounds: { left: 0, top: 30, right: 50, bottom: 50 },
            },
          ],
        },
      ],
    },
  };
  const capture = { id: "text-container", nodes: new SearchableHierarchy().project(hierarchy) };
  expect(
    resolver.resolve(capture, { text: "Target", container: { text: "Header" } }, tap).chosen,
  ).toBeNull();
});

test("duplicate container IDs use the same smallest-area scope as direct selection (#7645)", () => {
  const saveBounds = { left: 10, top: 320, right: 90, bottom: 360 };
  const secondBounds = { left: 0, top: 300, right: 100, bottom: 400 };
  const hierarchy = {
    hierarchy: {
      node: [
        {
          "resource-id": "app:id/list",
          clickable: true,
          bounds: { left: 0, top: 0, right: 300, bottom: 200 },
        },
        {
          "resource-id": "app:id/list",
          clickable: true,
          bounds: secondBounds,
          node: [{ text: "Save", clickable: true, bounds: saveBounds }],
        },
      ],
    },
  };
  const capture = { id: "containers", nodes: new SearchableHierarchy().project(hierarchy) };
  const direct = resolver.resolve(capture, { elementId: "app:id/list" }, tap);
  const scoped = resolver.resolve(
    capture,
    { text: "Save", container: { elementId: "app:id/list" } },
    tap,
  );
  expect(direct.chosen?.bounds).toEqual(secondBounds);
  expect(scoped.scope).toBe(direct.chosen!);
  expect(scoped.chosen?.bounds).toEqual(saveBounds);
});

test.each([2, 3])(
  "real generated keys cannot retarget after removing one of %i peers (#7648)",
  (peerCount) => {
    const anonymousRow = (ordinal: number, top: number) => ({
      "view-id": `0000000${ordinal}-0000-4000-8000-000000000000`,
      class: "android.widget.Button",
      text: "Identical row",
      clickable: true,
      bounds: { left: 0, top, right: 100, bottom: top + 40 },
    });
    const beforeRoot = {
      node: Array.from({ length: peerCount }, (_, i) => anonymousRow(i + 1, i * 50)),
    };
    assignStableViewIds(beforeRoot);
    const before = {
      id: "before-removal",
      nodes: new SearchableHierarchy().project({ hierarchy: { node: beforeRoot } }),
    };
    const second = before.nodes.find((entry) => entry.bounds?.top === 50)!;
    expect(second.nodeKey).toMatch(new RegExp(`^${STABLE_VIEW_ID_PREFIX}[0-9a-f]{16}-2$`));
    expect(second.nativeId).toBeUndefined();
    const ref = {
      snapshotId: before.id,
      nodeKey: second.nodeKey!,
      label: second.label,
      bounds: second.bounds,
    };
    expect(resolver.resolve(before, { elementId: ref.nodeKey }, { ...tap, ref }).chosen).toBe(
      second,
    );

    // The surviving second row moves to the first position and gets a new runner
    // UUID. Run production identity assignment again, not a hand-authored key.
    const afterRoot = {
      node: Array.from({ length: peerCount - 1 }, (_, i) => anonymousRow(i + 1, i * 50)),
    };
    assignStableViewIds(afterRoot);
    const after = {
      id: "after-removal",
      nodes: new SearchableHierarchy().project({ hierarchy: { node: afterRoot } }),
    };
    const remaining = after.nodes.find((entry) => entry.bounds)!;
    expect(remaining.nodeKey).not.toBe(ref.nodeKey);
    expect(remaining.label).toBe(second.label);
    const stale = resolver.resolve(after, { elementId: ref.nodeKey }, { ...tap, ref });
    expect(stale.chosen).toBeNull();
    expect(stale.error).toContain("Stale reference");
  },
);

test.each([false, true])(
  "ordinal reference requires unique native evidence on a new capture (duplicate=%s)",
  (duplicate) => {
    const nodeKey = `${STABLE_VIEW_ID_PREFIX}${"a".repeat(16)}-2`;
    const bounds = { left: 0, top: 0, right: 100, bottom: 40 };
    const original = {
      "view-id": nodeKey,
      "resource-id": "app:id/row",
      text: "Same",
      clickable: true,
      bounds,
    };
    const nodes = new SearchableHierarchy().project({
      hierarchy: { node: duplicate ? [original, { ...original, "view-id": "other" }] : [original] },
    });
    const result = resolver.resolve(
      { id: "new", nodes },
      { elementId: nodeKey },
      {
        ...tap,
        ref: { snapshotId: "old", nodeKey, nativeId: "app:id/row", label: "Same", bounds },
      },
    );
    if (duplicate) {
      expect(result.chosen).toBeNull();
      expect(result.error).toContain("Stale reference");
    } else {
      expect(result.chosen?.nativeId).toBe("app:id/row");
    }
  },
);
