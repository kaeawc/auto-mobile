import { DefaultElementFinder } from "../../../../src/features/utility/ElementFinder";
import { ViewHierarchy } from "../../../../src/features/observe/ViewHierarchy";
import { STABLE_VIEW_ID_PREFIX } from "../../../../src/features/observe/android/StableNodeIdentity";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import { projectActionableHierarchy } from "../../../../src/features/observe/HierarchyNormalization";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Conversion is pure apart from timing; no connection or device access is needed.
const converter = () =>
  new CtrlProxyHierarchy({ timer: new FakeTimer() } as HierarchyDelegateContext);
const button = (id: string, right: number) => ({
  text: "Open",
  "resource-id": id,
  className: "android.widget.Button",
  clickable: "true",
  bounds: { left: 0, top: 0, right, bottom: 20 },
});

test.each([false, true])(
  "native windows share canonical roots and ranks without aliases (raw-search filter=%s)",
  (filtered) => {
    const wire = JSON.parse(
      JSON.stringify({
        updatedAt: 100,
        packageName: "app",
        hierarchy: {
          node: [
            { windowId: 1, node: [button("large-main", 100), button("small-main", 10)] },
            {
              windowId: 2,
              node: [{ ...button("", 50), "view-id": "12345678-0000-4000-8000-000000000000" }],
            },
          ],
        },
        windows: [
          { id: 1, windowLayer: 0 },
          { id: 2, windowLayer: 10 },
        ],
      }),
    ) as AccessibilityHierarchy;
    const captured = converter().convertToViewHierarchyResult(wire);
    // These public projection methods use no device state or transport.
    const filter = Object.create(ViewHierarchy.prototype) as ViewHierarchy;
    const converted = filtered ? filter.filterViewHierarchy(captured) : captured;
    const roots = converted.hierarchy.node as any[];
    expect(converted.windows?.[0].hierarchy).toBe(roots[0]);
    expect(converted.windows?.[1].hierarchy).toBe(roots[1]);
    if (!filtered) {
      expect(roots[1].node.class).toBe("android.widget.Button");
    }
    expect(roots[1].node["view-id"]).toStartWith(STABLE_VIEW_ID_PREFIX);
    expect(
      new DefaultElementFinder().findElementByResourceId(converted, roots[1].node["view-id"]),
    ).not.toBeNull();
    const projected = projectActionableHierarchy("android", converted);
    expect(projected.windows?.[1].hierarchy).toBe(roots[1]);
    const snapshot = { id: "capture", nodes: new SearchableHierarchy().project(projected) };
    const resolver = new ElementResolver();
    const resolve = (index?: number) =>
      resolver.resolve(snapshot, { text: "Open", index }, { action: "tap" });
    expect(resolve().candidates).toHaveLength(3);
    expect(resolve().chosen?.nodeKey).toBe(roots[1].node["view-id"]);
    expect(resolve(0).chosen?.nodeKey).toBe(roots[1].node["view-id"]);
    expect(resolve(1).chosen?.nativeId).toBe("large-main");
    expect(resolve(2).chosen?.nativeId).toBe("small-main");
    const elements = new DefaultObserveElementCollector().collect(projected, "android")!;
    expect(elements.clickable).toHaveLength(3);
    expect(elements.clickable?.map((element) => element["resource-id"])).toEqual([
      undefined,
      "large-main",
      "small-main",
    ]);
    expect(projectSkeleton(elements).skeleton).toHaveLength(3);
  },
);

test("legacy window metadata remains metadata when no exact ownership marker exists", () => {
  const windows = [{ id: 1, windowLayer: 0 }];
  const converted = converter().convertToViewHierarchyResult({
    updatedAt: 1,
    packageName: "app",
    hierarchy: button("one", 10),
    windows,
  });
  expect(converted.windows).toEqual(windows);
  expect(converted.windows?.[0].hierarchy).toBeUndefined();
});

test("ambiguous root ownership markers do not choose an arbitrary window subtree", () => {
  const converted = converter().convertToViewHierarchyResult({
    updatedAt: 1,
    packageName: "app",
    hierarchy: {
      node: [
        { windowId: 0, node: button("one", 10) },
        { windowId: 0, node: button("two", 20) },
      ],
    },
    windows: [{ id: 0, windowLayer: 5 }],
  });
  expect(converted.windows?.[0].hierarchy).toBeUndefined();
});
