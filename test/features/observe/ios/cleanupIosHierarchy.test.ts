import { describe, expect, test } from "bun:test";
import { cleanupIosXCTestHierarchy } from "../../../../src/features/observe/ios/cleanupIosHierarchy";
import { loadIosRemindersNoiseObservePair } from "../../../fixtures/observe/observeFixture";

function collectNodes(node: any): any[] {
  if (!node) {
    return [];
  }
  const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
  return [node, ...children.flatMap(collectNodes)];
}

describe("cleanupIosXCTestHierarchy", () => {
  test("dedupes noise in a deep hierarchy without re-reading every ancestor subtree", () => {
    let boundsReads = 0;
    const depth = 40;
    const noisyBounds = new Proxy([47, 811, 342, 841], {
      get: (target, property, receiver) => {
        if (property === "length" || (typeof property === "string" && /^[0-9]+$/.test(property))) {
          boundsReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const duplicateNoise = [
      {
        className: "UIView",
        text: "Horizontal scroll bar, 1 page",
        bounds: noisyBounds,
      },
      {
        className: "UIView",
        text: "Horizontal scroll bar, 1 page",
        bounds: noisyBounds,
      },
    ];
    let child: any = {
      className: "UIView",
      text: "Content",
      node: duplicateNoise,
    };

    for (let index = 0; index < depth; index += 1) {
      const currentChild = child;
      const parent: any = {
        className: "UIView",
        text: `Container ${index}`,
      };
      Object.defineProperty(parent, "node", {
        enumerable: true,
        get: () => currentChild,
      });
      child = parent;
    }

    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: child,
      },
    });

    expect(
      collectNodes(result.hierarchy).filter(
        (node) => node.text === "Horizontal scroll bar, 1 page",
      ),
    ).toHaveLength(1);
    expect(boundsReads).toBeLessThan(20);
  });

  test("dedupes exact duplicate known-noise siblings", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIButton",
            text: "Dictate",
            "resource-id": "Dictate",
            clickable: "true",
            bounds: [360, 108, 378, 130],
          },
          {
            className: "UIButton",
            text: "Dictate",
            "resource-id": "Dictate",
            clickable: "true",
            bounds: [360, 108, 378, 130],
          },
        ],
      },
    });

    expect(collectNodes(result.hierarchy).filter((node) => node.text === "Dictate")).toHaveLength(
      1,
    );
  });

  test("preserves focused known-noise leaf while deduping matching unfocused leaves", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIButton",
            text: "Dictate",
            "resource-id": "Dictate",
            clickable: "true",
            bounds: [360, 108, 378, 130],
          },
          {
            className: "UIButton",
            text: "Dictate",
            "resource-id": "Dictate",
            clickable: "true",
            focused: "true",
            bounds: [360, 108, 378, 130],
          },
        ],
      },
    });

    const dictateNodes = collectNodes(result.hierarchy).filter((node) => node.text === "Dictate");
    expect(dictateNodes).toHaveLength(2);
    expect(dictateNodes.some((node) => node.focused === "true")).toBe(true);
  });

  test("preserves accessibility-focused known-noise leaf while deduping matching unfocused leaves", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIButton",
            text: "Dictate",
            "resource-id": "Dictate",
            clickable: "true",
            bounds: [360, 108, 378, 130],
          },
          {
            className: "UIButton",
            text: "Dictate",
            "resource-id": "Dictate",
            clickable: "true",
            "accessibility-focused": "true",
            bounds: [360, 108, 378, 130],
          },
        ],
      },
    });

    const dictateNodes = collectNodes(result.hierarchy).filter((node) => node.text === "Dictate");
    expect(dictateNodes).toHaveLength(2);
    expect(dictateNodes.some((node) => node["accessibility-focused"] === "true")).toBe(true);
  });

  test("drops redundant static label child represented by actionable parent text", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "UIButton",
          text: "New Reminder",
          role: "button",
          clickable: "true",
          bounds: [16, 806, 166, 830],
          node: {
            className: "UILabel",
            text: "New Reminder",
            role: "text",
            bounds: [51, 808, 166, 828],
          },
        },
      },
    });

    const button = collectNodes(result.hierarchy).find((node) => node.className === "UIButton");
    expect(button.text).toBe("New Reminder");
    expect(button.node).toBeUndefined();
  });

  test("preserves redundant-looking label child when it has operations or metadata", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "UIButton",
          text: "Options",
          role: "button",
          clickable: "true",
          bounds: [16, 120, 166, 166],
          node: [
            {
              className: "UILabel",
              text: "Options",
              role: "text",
              actions: ["custom_action"],
              bounds: [51, 128, 140, 150],
            },
            {
              className: "UILabel",
              text: "Options",
              role: "text",
              "long-clickable": "true",
              bounds: [51, 152, 140, 174],
            },
            {
              className: "UILabel",
              text: "Options",
              role: "text",
              "resource-id": "options-label",
              bounds: [51, 176, 140, 198],
            },
            {
              className: "UILabel",
              text: "Options",
              role: "text",
              "hint-text": "Options hint",
              bounds: [51, 200, 140, 222],
            },
          ],
        },
      },
    });

    const labels = collectNodes(result.hierarchy).filter((node) => node.className === "UILabel");
    expect(
      labels.map(
        (node) =>
          node["resource-id"] ?? node.actions?.[0] ?? node["long-clickable"] ?? node["hint-text"],
      ),
    ).toEqual(["custom_action", "true", "options-label", "Options hint"]);
  });

  test("drops redundant static label child whose only metadata is a generated view-id", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "UITableViewCell",
          text: "List",
          role: "listitem",
          clickable: "true",
          bounds: [20, 369, 382, 417],
          node: {
            className: "UILabel",
            text: "List",
            role: "text",
            "view-id": "5513e3ea-bba6-d754-02c1-c34c7365c6fa",
            bounds: [85, 383, 249, 403],
          },
        },
      },
    });

    expect(
      collectNodes(result.hierarchy).filter((node) => node.className === "UILabel"),
    ).toHaveLength(0);
  });

  test("dedupes known-noise leaves repeated in different descendant branches", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "WKWebView",
            node: {
              className: "UIView",
              text: "Horizontal scroll bar, 1 page",
              bounds: [47, 811, 342, 841],
            },
          },
          {
            className: "UIScrollView",
            node: {
              className: "UIView",
              text: "Horizontal scroll bar, 1 page",
              bounds: [47, 811, 342, 841],
            },
          },
        ],
      },
    });

    expect(
      collectNodes(result.hierarchy).filter(
        (node) => node.text === "Horizontal scroll bar, 1 page",
      ),
    ).toHaveLength(1);
  });

  test("drops structural wrappers containing only scroll bar noise", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIView",
            bounds: [383, 156, 390, 704],
            node: {
              className: "UIView",
              text: "Vertical scroll bar, 1 page",
              bounds: [383, 156, 390, 704],
            },
          },
          {
            className: "UIView",
            text: "Vertical scroll bar, 1 page",
            bounds: [383, 156, 390, 704],
          },
        ],
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Vertical scroll bar, 1 page")).toHaveLength(1);
    expect(
      nodes.some((node) => {
        const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
        return (
          node.className === "UIView" &&
          children.length > 0 &&
          children.every((child) => child.text === "Vertical scroll bar, 1 page")
        );
      }),
    ).toBe(false);
  });

  test("drops structural scroll bar wrappers after an earlier sibling registers the same noise", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIView",
            text: "Vertical scroll bar, 1 page",
            bounds: [383, 156, 390, 704],
          },
          {
            className: "UIView",
            bounds: [383, 156, 390, 704],
            node: {
              className: "UIView",
              text: "Vertical scroll bar, 1 page",
              bounds: [383, 156, 390, 704],
            },
          },
        ],
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Vertical scroll bar, 1 page")).toHaveLength(1);
    expect(
      nodes.some((node) => {
        const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
        return node.className === "UIView" && children.length === 0 && node.text === undefined;
      }),
    ).toBe(false);
  });

  test("drops Reminders fixture scroll bar wrappers in raw TS cleanup", () => {
    const { before } = loadIosRemindersNoiseObservePair();
    const result = cleanupIosXCTestHierarchy(before.viewHierarchy);
    const nodes = collectNodes(result.hierarchy);

    expect(
      nodes.some((node) => {
        const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
        return (
          node.class === "UIView" &&
          children.length > 0 &&
          children.every(
            (child) =>
              typeof child.text === "string" && child.text.toLowerCase().includes("scroll bar"),
          )
        );
      }),
    ).toBe(false);
  });

  test("preserves focused static label child represented by a link parent", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "UILink",
          text: "Privacy",
          role: "link",
          clickable: "true",
          bounds: [239, 710, 285, 727],
          node: {
            className: "UILabel",
            text: "Privacy",
            role: "text",
            focused: "true",
            bounds: [239, 710, 285, 727],
          },
        },
      },
    });

    const link = collectNodes(result.hierarchy).find((node) => node.className === "UILink");
    expect(link.text).toBe("Privacy");
    expect(link.node).toEqual({
      className: "UILabel",
      text: "Privacy",
      role: "text",
      focused: "true",
      bounds: [239, 710, 285, 727],
    });
  });

  test("preserves accessibility-focused static label child represented by actionable parent text", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "UIButton",
          text: "Continue",
          role: "button",
          clickable: "true",
          bounds: [20, 700, 370, 744],
          node: {
            className: "UILabel",
            text: "Continue",
            role: "text",
            "accessibility-focused": "true",
            bounds: [44, 710, 346, 734],
          },
        },
      },
    });

    const button = collectNodes(result.hierarchy).find((node) => node.className === "UIButton");
    expect(button.node).toEqual({
      className: "UILabel",
      text: "Continue",
      role: "text",
      "accessibility-focused": "true",
      bounds: [44, 710, 346, 734],
    });
  });

  test("collapses idless single-child WKWebView wrappers with identical bounds", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "WKWebView",
          "resource-id": "WebView",
          bounds: [0, 0, 390, 844],
          node: {
            className: "WKWebView",
            bounds: [0, 0, 390, 844],
            node: {
              className: "WKWebView",
              bounds: [0, 0, 390, 844],
              node: {
                className: "UIView",
                text: "Google",
                bounds: [0, 47, 390, 781],
              },
            },
          },
        },
      },
    });

    const webViews = collectNodes(result.hierarchy).filter(
      (node) => node.className === "WKWebView",
    );
    expect(webViews).toHaveLength(1);
    expect(webViews[0]["resource-id"]).toBe("WebView");
    expect(collectNodes(result.hierarchy).some((node) => node.text === "Google")).toBe(true);
  });

  test("does not leave an empty WKWebView when duplicate noise removes its only child", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIView",
            text: "Horizontal scroll bar, 1 page",
            bounds: [47, 811, 342, 841],
          },
          {
            className: "WKWebView",
            bounds: [0, 0, 390, 844],
            node: {
              className: "UIView",
              text: "Horizontal scroll bar, 1 page",
              bounds: [47, 811, 342, 841],
            },
          },
        ],
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Horizontal scroll bar, 1 page")).toHaveLength(1);
    expect(nodes.filter((node) => node.className === "WKWebView")).toHaveLength(0);
  });

  test("drops empty UIView wrappers when several noise children are pruned", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIView",
            text: "Horizontal scroll bar, 1 page",
            bounds: [47, 811, 342, 841],
          },
          {
            className: "UIView",
            bounds: [0, 0, 390, 844],
            node: [
              {
                className: "UIView",
                text: "Horizontal scroll bar, 1 page",
                bounds: [47, 811, 342, 841],
              },
              {
                className: "UIView",
                bounds: [0, 0, 390, 844],
                node: {
                  className: "UIView",
                  text: "Vertical scroll bar, 1 page",
                  bounds: [383, 156, 390, 704],
                },
              },
            ],
          },
        ],
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Horizontal scroll bar, 1 page")).toHaveLength(1);
    expect(
      nodes.some(
        (node) => node.className === "UIView" && node.text === undefined && node.node === undefined,
      ),
    ).toBe(false);
  });

  test("drops empty WKWebView wrappers when several noise children are pruned", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIView",
            text: "Horizontal scroll bar, 1 page",
            bounds: [47, 811, 342, 841],
          },
          {
            className: "WKWebView",
            bounds: [0, 0, 390, 844],
            node: [
              {
                className: "UIView",
                text: "Horizontal scroll bar, 1 page",
                bounds: [47, 811, 342, 841],
              },
              {
                className: "UIView",
                bounds: [0, 0, 390, 844],
                node: {
                  className: "UIView",
                  text: "Vertical scroll bar, 1 page",
                  bounds: [383, 156, 390, 704],
                },
              },
            ],
          },
        ],
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Horizontal scroll bar, 1 page")).toHaveLength(1);
    expect(nodes.filter((node) => node.className === "WKWebView")).toHaveLength(0);
  });

  test("preserves unique noise when an idless WKWebView collapses", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "WKWebView",
          bounds: [0, 0, 390, 844],
          node: {
            className: "UIView",
            text: "Vertical scroll bar, 1 page",
            bounds: [383, 156, 390, 704],
          },
        },
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Vertical scroll bar, 1 page")).toHaveLength(1);
    expect(nodes.filter((node) => node.className === "WKWebView")).toHaveLength(0);
  });

  test("preserves unique same-class noise when nested idless WKWebViews collapse", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "WKWebView",
          bounds: [0, 0, 390, 844],
          node: {
            className: "WKWebView",
            bounds: [0, 0, 390, 844],
            node: {
              className: "WKWebView",
              text: "Horizontal scroll bar, 1 page",
              bounds: [47, 811, 342, 841],
            },
          },
        },
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Horizontal scroll bar, 1 page")).toHaveLength(1);
    expect(
      nodes.some(
        (node) =>
          node.className === "WKWebView" && node.text === undefined && node.node === undefined,
      ),
    ).toBe(false);
  });

  test("preserves multi-child WKWebView wrappers after duplicate noise pruning", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: [
          {
            className: "UIView",
            text: "Dictate",
          },
          {
            className: "WKWebView",
            bounds: [0, 0, 390, 844],
            node: [
              {
                className: "UIView",
                text: "Dictate",
              },
              {
                className: "UIView",
                text: "Content",
                bounds: [0, 47, 390, 781],
              },
            ],
          },
        ],
      },
    });

    const webViews = collectNodes(result.hierarchy).filter(
      (node) => node.className === "WKWebView",
    );
    expect(webViews).toHaveLength(1);
    expect(collectNodes(webViews[0]).some((node) => node.text === "Content")).toBe(true);
    expect(collectNodes(result.hierarchy).filter((node) => node.text === "Dictate")).toHaveLength(
      1,
    );
  });

  test("collapses multi-child WKWebView wrappers when only noise remains", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "WKWebView",
          bounds: [0, 0, 390, 844],
          node: [
            {
              className: "UIView",
              text: "Horizontal scroll bar, 1 page",
              bounds: [47, 811, 342, 841],
            },
            {
              className: "UIView",
              text: "Horizontal scroll bar, 1 page",
              bounds: [47, 811, 342, 841],
            },
          ],
        },
      },
    });

    const nodes = collectNodes(result.hierarchy);
    expect(nodes.filter((node) => node.text === "Horizontal scroll bar, 1 page")).toHaveLength(1);
    expect(nodes.filter((node) => node.className === "WKWebView")).toHaveLength(0);
  });

  test("preserves scrollable idless single-child WKWebView wrappers", () => {
    const result = cleanupIosXCTestHierarchy({
      updatedAt: 1,
      hierarchy: {
        className: "XCUIApplication",
        node: {
          className: "WKWebView",
          bounds: [0, 0, 390, 844],
          scrollable: "true",
          node: {
            className: "UIView",
            text: "Google",
            bounds: [0, 47, 390, 781],
          },
        },
      },
    });

    const webViews = collectNodes(result.hierarchy).filter(
      (node) => node.className === "WKWebView",
    );
    expect(webViews).toHaveLength(1);
    expect(webViews[0].scrollable).toBe("true");
    expect(collectNodes(result.hierarchy).some((node) => node.text === "Google")).toBe(true);
  });
});
