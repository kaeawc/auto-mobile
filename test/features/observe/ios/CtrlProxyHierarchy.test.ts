import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type { CtrlProxyNode, HierarchyDelegateContext } from "../../../../src/features/observe/ios/types";

const stubContext = {} as HierarchyDelegateContext;

function findFirstNodeWith(
  node: any,
  predicate: (attrs: Record<string, string>) => boolean
): any | null {
  if (node?.$ && predicate(node.$)) {return node;}
  for (const child of node?.node ?? []) {
    const hit = findFirstNodeWith(child, predicate);
    if (hit) {return hit;}
  }
  return null;
}

function makeHierarchy(root: CtrlProxyNode): any {
  return {
    updatedAt: 0,
    packageName: "test.app",
    hierarchy: root,
  };
}

describe("CtrlProxyHierarchy.convertToViewHierarchyResult", () => {
  const subject = new CtrlProxyHierarchy(stubContext);

  test("surfaces `value` separately from `text` for text-input nodes", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          className: "UISearchBar",
          text: "Search videos",
          value: "hello iOS",
          hintText: "Search videos",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: "true",
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const searchBar = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["class"] === "UISearchBar"
    );

    expect(searchBar).not.toBeNull();
    expect(searchBar.$["text"]).toBe("Search videos");
    expect(searchBar.$["value"]).toBe("hello iOS");
    expect(searchBar.$["hint-text"]).toBe("Search videos");
  });

  test("preserves a node that has only `value` (no text/resourceId)", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          className: "UITextField",
          value: "value-only",
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: "true",
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const tf = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["class"] === "UITextField"
    );

    expect(tf).not.toBeNull();
    expect(tf.$["value"]).toBe("value-only");
  });

  test("omits `value` attribute when absent on input", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      node: [
        {
          className: "UILabel",
          text: "Static label",
          bounds: { left: 0, top: 0, right: 100, bottom: 20 },
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const label = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["class"] === "UILabel"
    );

    expect(label).not.toBeNull();
    expect(label.$["value"]).toBeUndefined();
    expect(label.$["text"]).toBe("Static label");
  });
});
