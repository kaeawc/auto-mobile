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

function countNodesWith(
  node: any,
  predicate: (attrs: Record<string, string>) => boolean
): number {
  if (!node) {return 0;}
  const current = node.$ && predicate(node.$) ? 1 : 0;
  return current + (node.node ?? []).reduce(
    (count: number, child: any) => count + countNodesWith(child, predicate),
    0
  );
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

  test("preserves compact semantic-link metadata from the iOS runner", () => {
    const result = subject.convertToViewHierarchyResult(makeHierarchy({
      text: "Terms of Service",
      role: "link",
      "semantic-links": [{ text: "Terms of Service", occurrence: 0 }],
    }));

    expect((result.hierarchy.node as any).$["semantic-links"]).toEqual([
      { text: "Terms of Service", occurrence: 0 },
    ]);
  });

  test("preserves capture-time device rotation", () => {
    const result = subject.convertToViewHierarchyResult({
      ...makeHierarchy({ className: "XCUIApplication" }),
      rotation: 3,
    });

    expect(result.rotation).toBe(3);
  });

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

  test("collapses structural wrappers whose only content is a generated view-id", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIWindow",
          viewId: "5513e3ea-bba6-d754-02c1-c34c7365c6fa",
          bounds: { left: 0, top: 0, right: 402, bottom: 874 },
          node: [
            {
              className: "UIView",
              viewId: "54b54709-d08c-3814-4e4f-c66bf50820d8",
              bounds: { left: 0, top: 0, right: 402, bottom: 874 },
              node: [
                {
                  className: "UIButton",
                  text: "New Reminder",
                  role: "button",
                  clickable: "true",
                  bounds: { left: 16, top: 806, right: 166, bottom: 830 },
                },
              ],
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));

    expect(countNodesWith(result.hierarchy.node, attrs => attrs["class"] === "UIWindow")).toBe(0);
    expect(countNodesWith(result.hierarchy.node, attrs => attrs["class"] === "UIView")).toBe(0);
    expect(findFirstNodeWith(result.hierarchy.node, attrs => attrs["text"] === "New Reminder")).not.toBeNull();
  });

  test("preserves structural wrapper with a non-generated view-id", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIView",
          viewId: "custom-container-id",
          bounds: { left: 0, top: 0, right: 402, bottom: 874 },
          node: [
            {
              className: "UILabel",
              text: "Child",
              bounds: { left: 20, top: 20, right: 120, bottom: 44 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const wrapper = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["view-id"] === "custom-container-id"
    );

    expect(wrapper).not.toBeNull();
    expect(wrapper.$["class"]).toBe("UIView");
  });

  test("preserves accessibility-focused structural wrapper", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIView",
          accessibilityFocused: "true",
          bounds: { left: 0, top: 0, right: 402, bottom: 874 },
          node: [
            {
              className: "UILabel",
              text: "Child",
              bounds: { left: 20, top: 20, right: 120, bottom: 44 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const wrapper = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["class"] === "UIView" && attrs["accessibility-focused"] === "true"
    );

    expect(wrapper).not.toBeNull();
    expect(wrapper.node).toHaveLength(1);
  });

  test("omits false accessibility-focused attribute", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UILabel",
          text: "Child",
          accessibilityFocused: "false",
          bounds: { left: 20, top: 20, right: 120, bottom: 44 },
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const label = findFirstNodeWith(result.hierarchy.node, attrs => attrs["text"] === "Child");

    expect(label).not.toBeNull();
    expect(label.$["accessibility-focused"]).toBeUndefined();
  });

  test("dedupes exact duplicate Dictate noise leaves", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UISearchBar",
          text: "Search",
          bounds: { left: 16, top: 101, right: 386, bottom: 137 },
          node: [
            {
              className: "UIButton",
              text: "Dictate",
              resourceId: "Dictate",
              role: "button",
              clickable: "true",
              bounds: { left: 360, top: 108, right: 378, bottom: 130 },
            },
            {
              className: "UIButton",
              text: "Dictate",
              resourceId: "Dictate",
              role: "button",
              clickable: "true",
              bounds: { left: 360, top: 108, right: 378, bottom: 130 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));

    expect(countNodesWith(result.hierarchy.node, attrs => attrs["text"] === "Dictate")).toBe(1);
  });

  test("preserves focused duplicate Dictate noise leaf", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UISearchBar",
          text: "Search",
          bounds: { left: 16, top: 101, right: 386, bottom: 137 },
          node: [
            {
              className: "UIButton",
              text: "Dictate",
              resourceId: "Dictate",
              role: "button",
              clickable: "true",
              bounds: { left: 360, top: 108, right: 378, bottom: 130 },
            },
            {
              className: "UIButton",
              text: "Dictate",
              resourceId: "Dictate",
              role: "button",
              clickable: "true",
              focused: "true",
              bounds: { left: 360, top: 108, right: 378, bottom: 130 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));

    expect(countNodesWith(result.hierarchy.node, attrs => attrs["text"] === "Dictate")).toBe(2);
    expect(findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["text"] === "Dictate" && attrs["focused"] === "true"
    )).not.toBeNull();
  });

  test("preserves accessibility-focused duplicate Dictate noise leaf", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UISearchBar",
          text: "Search",
          bounds: { left: 16, top: 101, right: 386, bottom: 137 },
          node: [
            {
              className: "UIButton",
              text: "Dictate",
              resourceId: "Dictate",
              role: "button",
              clickable: "true",
              bounds: { left: 360, top: 108, right: 378, bottom: 130 },
            },
            {
              className: "UIButton",
              text: "Dictate",
              resourceId: "Dictate",
              role: "button",
              clickable: "true",
              accessibilityFocused: "true",
              bounds: { left: 360, top: 108, right: 378, bottom: 130 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));

    expect(countNodesWith(result.hierarchy.node, attrs => attrs["text"] === "Dictate")).toBe(2);
    expect(findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["text"] === "Dictate" && attrs["accessibility-focused"] === "true"
    )).not.toBeNull();
  });

  test("dedupes exact duplicate action-sheet scrollbar leaves", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIScrollView",
          scrollable: "true",
          bounds: { left: 8, top: 718, right: 394, bottom: 775 },
          node: [
            {
              className: "UIButton",
              text: "Discard Changes",
              role: "button",
              clickable: "true",
              bounds: { left: 8, top: 718, right: 394, bottom: 775 },
            },
            {
              className: "UIView",
              text: "Vertical scroll bar, 1 page",
              bounds: { left: 361, top: 718, right: 391, bottom: 775 },
            },
            {
              className: "UIView",
              text: "Vertical scroll bar, 1 page",
              bounds: { left: 361, top: 718, right: 391, bottom: 775 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));

    expect(countNodesWith(
      result.hierarchy.node,
      attrs => attrs["text"] === "Vertical scroll bar, 1 page"
    )).toBe(1);
    expect(findFirstNodeWith(result.hierarchy.node, attrs => attrs["text"] === "Discard Changes")).not.toBeNull();
  });

  test("preserves role and custom actions", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UITextField",
          text: "Title",
          role: "textbox",
          actions: ["set_text", "clear_text"],
          bounds: { left: 16, top: 120, right: 386, bottom: 166 },
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const field = findFirstNodeWith(result.hierarchy.node, attrs => attrs["text"] === "Title");

    expect(field).not.toBeNull();
    expect(field.$["role"]).toBe("textbox");
    expect(field.$["actions"]).toEqual(["set_text", "clear_text"]);
  });

  test("promotes an SDK header trait to a heading role", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UILabel",
          text: "Entries",
          role: "text",
          extras: { "sdk.accessibilityTraits": "staticText,header" },
          bounds: { left: 16, top: 120, right: 386, bottom: 166 },
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const heading = findFirstNodeWith(result.hierarchy.node, attrs => attrs["text"] === "Entries");

    expect(heading).not.toBeNull();
    expect(heading.$["role"]).toBe("heading");
  });

  test("drops redundant static text child when actionable parent already has the same text", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIButton",
          text: "New Reminder",
          role: "button",
          clickable: "true",
          bounds: { left: 16, top: 806, right: 166, bottom: 830 },
          node: [
            {
              className: "UILabel",
              text: "New Reminder",
              role: "text",
              bounds: { left: 51, top: 808, right: 166, bottom: 828 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const button = findFirstNodeWith(result.hierarchy.node, attrs => attrs["class"] === "UIButton");

    expect(button).not.toBeNull();
    expect(button.$["text"]).toBe("New Reminder");
    expect(button.node).toBeUndefined();
  });

  test("preserves duplicate static text child when it has standalone metadata", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIButton",
          text: "New Reminder",
          role: "button",
          clickable: "true",
          bounds: { left: 16, top: 806, right: 166, bottom: 830 },
          node: [
            {
              className: "UILabel",
              text: "New Reminder",
              role: "text",
              resourceId: "button-title-label",
              actions: ["custom_action"],
              bounds: { left: 51, top: 808, right: 166, bottom: 828 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const label = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["resource-id"] === "button-title-label"
    );

    expect(label).not.toBeNull();
    expect(label.$["actions"]).toEqual(["custom_action"]);
  });

  test("preserves duplicate static text child when it has direct interaction properties", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIButton",
          text: "Options",
          role: "button",
          clickable: "true",
          bounds: { left: 16, top: 120, right: 166, bottom: 166 },
          node: [
            {
              className: "UILabel",
              text: "Options",
              role: "text",
              longClickable: "true",
              bounds: { left: 51, top: 128, right: 140, bottom: 150 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const label = findFirstNodeWith(
      result.hierarchy.node,
      attrs => attrs["class"] === "UILabel" && attrs["text"] === "Options"
    );

    expect(label).not.toBeNull();
    expect(label.$["long-clickable"]).toBe("true");
  });

  test("drops redundant static text child whose only metadata is a generated view-id", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIButton",
          text: "Options",
          role: "button",
          clickable: "true",
          bounds: { left: 16, top: 120, right: 166, bottom: 166 },
          node: [
            {
              className: "UILabel",
              text: "Options",
              role: "text",
              viewId: "5513e3ea-bba6-d754-02c1-c34c7365c6fa",
              bounds: { left: 51, top: 128, right: 140, bottom: 150 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const button = findFirstNodeWith(result.hierarchy.node, attrs => attrs["class"] === "UIButton");

    expect(button).not.toBeNull();
    expect(button.node).toBeUndefined();
  });

  test("preserves focused static text child when link parent already has the same text", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UILink",
          text: "Privacy",
          role: "link",
          clickable: "true",
          bounds: { left: 239, top: 710, right: 285, bottom: 727 },
          node: [
            {
              className: "UILabel",
              text: "Privacy",
              role: "text",
              focused: "true",
              bounds: { left: 239, top: 710, right: 285, bottom: 727 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const link = findFirstNodeWith(result.hierarchy.node, attrs => attrs["class"] === "UILink");

    expect(link).not.toBeNull();
    expect(link.$["text"]).toBe("Privacy");
    expect(link.node).toHaveLength(1);
    expect(link.node?.[0]?.$["class"]).toBe("UILabel");
    expect(link.node?.[0]?.$["focused"]).toBe("true");
  });

  test("preserves accessibility-focused static text child when parent already has the same text", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 402, bottom: 874 },
      node: [
        {
          className: "UIButton",
          text: "Continue",
          role: "button",
          clickable: "true",
          bounds: { left: 20, top: 700, right: 370, bottom: 744 },
          node: [
            {
              className: "UILabel",
              text: "Continue",
              role: "text",
              accessibilityFocused: "true",
              bounds: { left: 44, top: 710, right: 346, bottom: 734 },
            },
          ],
        },
      ],
    };

    const result = subject.convertToViewHierarchyResult(makeHierarchy(root));
    const button = findFirstNodeWith(result.hierarchy.node, attrs => attrs["class"] === "UIButton");

    expect(button).not.toBeNull();
    expect(button.node).toHaveLength(1);
    expect(button.node?.[0]?.$["class"]).toBe("UILabel");
    expect(button.node?.[0]?.$["accessibility-focused"]).toBe("true");
  });

  test("retains the additive #4548 scale metadata reported by the runner", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 375, bottom: 812 },
    };
    // Display Zoom values: screenScale (UIScreen.scale) stays 3.0 while nativeScale is 3.144,
    // so a converter that conflated the two fields would fail this test.
    const result = subject.convertToViewHierarchyResult({
      ...makeHierarchy(root),
      screenScale: 3.0,
      screenWidth: 375,
      screenHeight: 812,
      nativeScale: 3.144,
      pixelWidth: 1179,
      pixelHeight: 2553,
    });

    expect(result.screenScale).toBe(3.0);
    expect(result.nativeScale).toBe(3.144);
    expect(result.pixelWidth).toBe(1179);
    expect(result.pixelHeight).toBe(2553);
  });

  test("omits the scale metadata keys entirely for a pre-#4548 runner payload", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 375, bottom: 812 },
    };
    const result = subject.convertToViewHierarchyResult({
      ...makeHierarchy(root),
      screenScale: 3.0,
      screenWidth: 375,
      screenHeight: 812,
    });

    // Byte-identical legacy shape: the keys must be ABSENT, not present-with-undefined.
    expect("nativeScale" in result).toBe(false);
    expect("pixelWidth" in result).toBe(false);
    expect("pixelHeight" in result).toBe(false);
  });

  test("omits ALL scale fields when the metadata tuple is partial or degenerate (all-or-nothing, matches retention)", () => {
    const root: CtrlProxyNode = {
      className: "XCUIApplication",
      bounds: { left: 0, top: 0, right: 375, bottom: 812 },
    };
    const base = { ...makeHierarchy(root), screenScale: 3.0, screenWidth: 375, screenHeight: 812 };
    const partials = [
      { nativeScale: 3.144 }, // pixelWidth/pixelHeight missing
      { nativeScale: 3.144, pixelWidth: 1179 }, // pixelHeight missing
      { nativeScale: 0, pixelWidth: 1179, pixelHeight: 2553 },
      { nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 0 },
    ];
    for (const partial of partials) {
      const result = subject.convertToViewHierarchyResult({ ...base, ...partial } as any);
      expect("nativeScale" in result).toBe(false);
      expect("pixelWidth" in result).toBe(false);
      expect("pixelHeight" in result).toBe(false);
    }
  });
});
