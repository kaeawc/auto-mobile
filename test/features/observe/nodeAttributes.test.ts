import { describe, expect, test } from "bun:test";
import { nodeAttributes, nodeBounds } from "../../../src/models/ViewHierarchyResult";

describe("view hierarchy node accessors", () => {
  test("reads nested iOS CtrlProxy attributes by reference", () => {
    const attrs = { class: "UIView", bounds: { left: 1, top: 2, right: 3, bottom: 4 } };
    const node = { $: attrs };

    expect(nodeAttributes(node)).toBe(attrs);
    expect(nodeBounds(node)).toBe(attrs.bounds);
  });

  test("reads flat Android and cleaned iOS attributes by reference", () => {
    const node = { class: "android.view.View", bounds: { left: 0, top: 0, right: 10, bottom: 10 } };

    expect(nodeAttributes(node)).toBe(node);
    expect(nodeBounds(node)).toBe(node.bounds);
  });

  test("prefers direct bounds when both shapes are present", () => {
    const bounds = { left: 0, top: 0, right: 10, bottom: 10 };
    const node = { bounds, $: { bounds: { left: 1, top: 1, right: 9, bottom: 9 } } };

    expect(nodeBounds(node)).toBe(bounds);
  });
});
