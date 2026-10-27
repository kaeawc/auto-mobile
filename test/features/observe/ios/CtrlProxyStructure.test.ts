import { expect, test } from "bun:test";
import {
  convertToViewHierarchyResult,
  hasContentProperties,
  isRedundantStaticTextChild,
  noiseSiblingKey,
  type ConvertedNode,
} from "../../../../src/features/observe/ios/IosHierarchyConverter";
import { springBoardPhotosIcon } from "../../../fixtures/observe/iosSpringBoardIcon";

test("content properties preserve truthiness and short circuit", () => {
  for (const key of ["text", "value", "resource-id", "content-desc", "test-tag", "role"]) {
    for (const value of ["label", " ", true, 1, {}]) {
      expect(hasContentProperties({ [key]: value })).toBe(true);
    }
    for (const value of ["", false, 0, null, undefined]) {
      expect(hasContentProperties({ [key]: value })).toBe(false);
    }
  }
  expect(hasContentProperties({ "view-id": "stable-id" })).toBe(true);
});

test("static text guards retain child structure, extras, actions and independent state", () => {
  const leaf: ConvertedNode = { $: { class: "UILabel", role: "text", text: " Parent " } };
  expect(isRedundantStaticTextChild("Parent", leaf)).toBe(true);
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
    expect(isRedundantStaticTextChild("Parent", node)).toBe(false);
  }
});

test("noise key preserves nullish defaults and protects content-bearing leaves", () => {
  const leaf: ConvertedNode = { $: { text: "Dictate" } };
  expect(noiseSiblingKey(leaf)).toBe('["","Dictate","",null]');
  expect(noiseSiblingKey({ $: { text: "Horizontal scroll bar" } })).toBe(
    '["","Horizontal scroll bar","",null]',
  );
  expect(
    noiseSiblingKey({
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
    expect(noiseSiblingKey(node)).toBeNull();
  }
});

test("captured SpringBoard icon conversion retains field order and wrapper promotion", () => {
  const result = convertToViewHierarchyResult({
    updatedAt: 0,
    packageName: "com.apple.springboard",
    hierarchy: springBoardPhotosIcon,
  });
  expect(JSON.stringify(result)).toBe(
    '{"hierarchy":{"node":{"$":{"text":"Photos","class":"SBIconView","bounds":{"left":120,"top":288,"right":188,"bottom":379},"clickable":"true","role":"button"},"node":[{"$":{"resource-id":"label-view","class":"UIView","bounds":{"left":126,"top":357,"right":182,"bottom":377}}}]}},"packageName":"com.apple.springboard","updatedAt":0}',
  );
});
