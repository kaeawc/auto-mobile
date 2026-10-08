import capture from "../../../fixtures/android-enabled/playground-disabled-control-api36.json";
import { androidControlObservation } from "../../../helpers/androidDisabledControlCapture";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { ResolverElementSelector } from "../../../../src/features/utility/ResolverElementSelector";
import { ViewHierarchy } from "../../../../src/features/observe/ViewHierarchy";
import { STABLE_VIEW_ID_PREFIX } from "../../../../src/features/observe/android/StableNodeIdentity";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { getElementProvenance } from "../../../../src/features/observe/output/elementProvenance";
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
      new ResolverElementSelector().selectByResourceId(converted, roots[1].node["view-id"]).element,
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
    expect(resolve(1).chosen?.nativeId).toBe("small-main");
    expect(resolve(2).chosen?.nativeId).toBe("large-main");
    const elements = new DefaultObserveElementCollector().collect(projected, "android")!;
    expect(elements.clickable).toHaveLength(3);
    expect(elements.clickable.map((element) => getElementProvenance(element)?.windowRank)).toEqual([
      1, 1, 0,
    ]);
    expect(elements.clickable?.map((element) => element["resource-id"])).toEqual([
      "large-main",
      "small-main",
      undefined,
    ]);
    const skeleton = projectSkeleton(elements).skeleton;
    expect(skeleton).toHaveLength(3);
    const liveSelector = new ResolverElementSelector();
    const selectedRows = [0, 1, 2].map(
      (index) => liveSelector.selectByText(projected, "Open", { index }).element,
    );
    expect(selectedRows.map((element) => element?.["resource-id"])).toEqual([
      undefined,
      "small-main",
      "large-main",
    ]);
    expect(selectedRows[0]?.["view-id"]).toBe(roots[1].node["view-id"]);
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

test("linked activity/dialog duplicate skeleton indexes replay the resolver's topmost choice", () => {
  const hierarchy = converter().convertToViewHierarchyResult({
    updatedAt: 100,
    packageName: "app",
    hierarchy: {
      node: [
        { windowId: 1, node: button("app:id/ok", 10) },
        { windowId: 2, node: button("app:id/ok", 50) },
      ],
    },
    windows: [
      { id: 1, windowLayer: 0 },
      { id: 2, windowLayer: 10 },
    ],
  } as AccessibilityHierarchy);
  const rows = projectSkeleton(
    new DefaultObserveElementCollector().collect(hierarchy, "android")!,
  ).skeleton;
  expect(rows).toHaveLength(2);
  const selector = new ResolverElementSelector();
  for (const row of rows) {
    expect(row.index).toBeDefined();
    const selection = selector.selectByResourceId(hierarchy, row.elementId!, {
      index: row.index,
      intentAction: "inspect",
    });
    expect(selection.element?.bounds).toEqual({
      left: row.bounds[0],
      top: row.bounds[1],
      right: row.bounds[2],
      bottom: row.bounds[3],
    });
  }
  const defaultPick = selector.selectByResourceId(hierarchy, "app:id/ok", {
    intentAction: "inspect",
  });
  expect(rows.find((row) => row.index === 0)?.bounds).toEqual([
    0,
    0,
    defaultPick.element?.bounds.right,
    20,
  ]);
});

test("linked window above the IME retains tap even inside the keyboard rectangle", () => {
  const hierarchy = converter().convertToViewHierarchyResult({
    updatedAt: 100,
    packageName: "app",
    hierarchy: {
      node: [
        {
          windowId: 1,
          node: {
            ...button("app:id/lower", 100),
            bounds: { left: 0, top: 160, right: 100, bottom: 190 },
          },
        },
        {
          windowId: 2,
          extras: { "automobile:imePackage": "com.google.android.inputmethod.latin" },
          node: {
            ...button("com.google.android.inputmethod.latin:id/key_pos_q", 400),
            text: "Q",
            bounds: { left: 0, top: 150, right: 400, bottom: 240 },
          },
        },
        {
          windowId: 3,
          node: {
            ...button("app:id/upper", 100),
            bounds: { left: 0, top: 160, right: 100, bottom: 190 },
          },
        },
      ],
    },
    windows: [
      { id: 1, windowLayer: 0 },
      { id: 2, type: 2, windowLayer: 1, bounds: { left: 0, top: 150, right: 400, bottom: 240 } },
      { id: 3, windowLayer: 2 },
    ],
  } as AccessibilityHierarchy);
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "android")!;
  const { skeleton, context } = projectSkeleton(elements);
  expect(skeleton.find((row) => row.elementId === "app:id/upper")?.affordances).toContain("tap");
  expect(context.find((row) => row.elementId === "app:id/lower")).toMatchObject({
    occluded: true,
    affordances: [],
  });
});

test("captured Android control preserves disabled state through conversion, normalisation and full/raw output", () => {
  const observation = androidControlObservation();
  const hierarchy = observation.viewHierarchy!;
  const element = observation.elements!.clickable[0];
  expect(element.enabled).toBe("false");
  expect(hierarchy.hierarchy.node).toMatchObject({ enabled: "false" });
  const filter = Object.create(ViewHierarchy.prototype) as ViewHierarchy;
  const normalized = projectActionableHierarchy("android", filter.filterViewHierarchy(hierarchy));
  const snapshot = { id: "disabled-capture", nodes: new SearchableHierarchy().project(normalized) };
  const resolution = new ElementResolver().resolve(
    snapshot,
    { elementId: element["view-id"]! },
    { action: "tap" },
  );
  expect(resolution.chosen?.properties.enabled).toBe("false");
  for (const trimNodes of [false, true]) {
    const full = sanitizeObserveResult(observation, {
      project: "full",
      dropElements: false,
      compact: true,
      trimNodes,
    });
    expect(full.viewHierarchy?.hierarchy.node).toMatchObject({ enabled: "false" });
    expect(full.elements?.clickable[0].enabled).toBe("false");
  }
});

// Reuse a real capture; reason metadata is injected in code until a device capture exists.
test.each([
  "active_window_null_root",
  "app_window_null_root",
  "no_app_window_root",
  undefined,
] as const)("captured hierarchy conversion preserves optional incomplete reason: %s", (reason) => {
  const wire: AccessibilityHierarchy = JSON.parse(capture.rawViewHierarchy.json);
  wire.ctrlProxyIncomplete = true;
  if (reason === undefined) {
    delete wire.ctrlProxyIncompleteReason;
  } else {
    wire.ctrlProxyIncompleteReason = reason;
  }
  expect(converter().convertToViewHierarchyResult(wire).ctrlProxyIncompleteReason).toBe(reason);
  // Both the readable and rootless conversion branches retain the wire metadata.
  delete wire.hierarchy;
  expect(converter().convertToViewHierarchyResult(wire).ctrlProxyIncompleteReason).toBe(reason);
});
