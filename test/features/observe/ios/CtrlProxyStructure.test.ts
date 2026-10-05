import { expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import { springBoardPhotosIcon } from "../../../fixtures/observe/iosSpringBoardIcon";
import type { HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";

interface Node {
  $: Record<string, unknown>;
  extras?: Record<string, string>;
  node?: Node[];
}
const subject = new CtrlProxyHierarchy({} as HierarchyDelegateContext);
const predicates = subject as unknown as {
  hasContentProperties(attrs: Record<string, unknown>): boolean;
  isRedundantStaticTextChild(text: string, child: Node): boolean;
  noiseSiblingKey(node: Node): string | null;
};

test("content properties preserve truthiness and short circuit", () => {
  for (const key of ["text", "value", "resource-id", "content-desc", "test-tag", "role"]) {
    for (const value of ["label", " ", true, 1, {}]) {
      expect(predicates.hasContentProperties({ [key]: value })).toBe(true);
    }
    for (const value of ["", false, 0, null, undefined]) {
      expect(predicates.hasContentProperties({ [key]: value })).toBe(false);
    }
  }
  expect(predicates.hasContentProperties({ "view-id": "stable-id" })).toBe(true);
});

test("static text guards retain child structure, extras, actions and independent state", () => {
  const leaf: Node = { $: { class: "UILabel", role: "text", text: " Parent " } };
  expect(predicates.isRedundantStaticTextChild("Parent", leaf)).toBe(true);
  for (const node of [
    { ...leaf, node: [leaf] },
    { ...leaf, extras: { sdk: "value" } },
    { $: { ...leaf.$, class: "UIView" } },
    { $: { ...leaf.$, role: "button" } },
    { $: { ...leaf.$, text: "other" } },
    { $: { ...leaf.$, actions: ["click"] } },
    { $: { ...leaf.$, focused: "true" } },
    { $: { ...leaf.$, clickable: "true" } },
    { $: { ...leaf.$, value: "independent" } },
  ]) {
    expect(predicates.isRedundantStaticTextChild("Parent", node)).toBe(false);
  }
});

test("noise key preserves nullish defaults and protects content-bearing leaves", () => {
  const leaf: Node = { $: { text: "Dictate" } };
  expect(predicates.noiseSiblingKey(leaf)).toBe('["","Dictate","",null]');
  expect(predicates.noiseSiblingKey({ $: { text: "Horizontal scroll bar" } })).toBe(
    '["","Horizontal scroll bar","",null]',
  );
  expect(
    predicates.noiseSiblingKey({
      $: { text: "Dictation", class: "UIButton", "resource-id": "id", bounds: [] },
    }),
  ).toBe('["UIButton","Dictation","id",[]]');
  for (const node of [
    { ...leaf, node: [leaf] },
    { ...leaf, extras: { sdk: "value" } },
    { $: { ...leaf.$, actions: ["click"] } },
    { $: { ...leaf.$, focused: "true" } },
    { $: { text: "independent" } },
    { $: { text: 1 } },
  ]) {
    expect(predicates.noiseSiblingKey(node)).toBeNull();
  }
});

test("captured SpringBoard icon conversion retains field order and wrapper promotion", () => {
  const result = subject.convertToViewHierarchyResult({
    updatedAt: 0,
    hierarchy: springBoardPhotosIcon,
  });
  expect(JSON.stringify(result)).toBe(
    '{"hierarchy":{"node":{"$":{"text":"Photos","class":"SBIconView","bounds":{"left":120,"top":288,"right":188,"bottom":379},"clickable":"true","role":"button"},"node":[{"$":{"resource-id":"label-view","class":"UIView","bounds":{"left":126,"top":357,"right":182,"bottom":377}}}]}},"updatedAt":0}',
  );
});
