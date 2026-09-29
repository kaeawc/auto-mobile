import { expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { springBoardPhotosIcon } from "../../../fixtures/observe/iosSpringBoardIcon";
import type {
  CtrlProxyNode,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/ios/types";

const subject = new CtrlProxyHierarchy({} as HierarchyDelegateContext);

function convertIcon(icon: CtrlProxyNode) {
  return subject.convertToViewHierarchyResult({
    updatedAt: 0,
    packageName: "com.apple.springboard",
    hierarchy: { className: "XCUIApplication", node: [icon] },
  });
}

test("SpringBoard Photos icon produces one labeled tappable row", () => {
  const hierarchy = convertIcon(springBoardPhotosIcon);
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios");
  const { skeleton } = projectSkeleton(elements!);

  expect(skeleton.map(({ label, affordances }) => ({ label, affordances }))).toEqual([
    { label: "Photos", affordances: ["tap"] },
  ]);
});

test("icon artwork cleanup does not require a labeled clickable snapshot icon", () => {
  const icon = structuredClone(springBoardPhotosIcon);
  delete icon.text;
  delete icon.clickable;
  const hierarchy = convertIcon(icon);
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios");

  expect(elements?.clickable).toEqual([]);
});

test("identified image inside an icon remains independently tappable", () => {
  const icon = structuredClone(springBoardPhotosIcon);
  const wrapper = (icon.node as CtrlProxyNode[])[0];
  const labelView = (wrapper.node as CtrlProxyNode[])[0];
  const inner = (labelView.node as CtrlProxyNode[])[0];
  (inner.node as CtrlProxyNode[]).push({
    className: "UIImageView",
    resourceId: "icon-badge",
    clickable: "true",
    bounds: { left: 170, top: 290, right: 188, bottom: 308 },
  });
  const hierarchy = convertIcon(icon);
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "ios");
  const { skeleton } = projectSkeleton(elements!);

  expect(skeleton.map((row) => row.label)).toEqual(["Photos", undefined]);
  expect(skeleton[1]?.elementId).toBe("icon-badge");
});
