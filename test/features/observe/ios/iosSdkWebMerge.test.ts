import { describe, expect, test } from "bun:test";
import {
  findWebViewNodes,
  iosSdkWebTarget,
  mergeIosSdkWebSnapshots,
} from "../../../../src/features/observe/ios/iosSdkWebMerge";
import type { IosSdkWebSnapshot } from "../../../../src/features/observe/ios/sdkWebViewBridge";
import type { ViewHierarchyNode, ViewHierarchyResult } from "../../../../src/models";

const webViewBounds = { left: 0, top: 100, right: 400, bottom: 800 };

function webView(children: ViewHierarchyNode[] = [], bounds = webViewBounds): ViewHierarchyNode {
  return {
    $: { class: "WKWebView", "resource-id": "WebView", scrollable: "true", bounds },
    node: [{ $: { class: "WKWebView", bounds }, node: children }],
  };
}

function screen(...webViews: ViewHierarchyNode[]): ViewHierarchyResult {
  return {
    packageName: "com.example.app",
    hierarchy: {
      node: {
        $: { class: "XCUIApplication", bounds: { left: 0, top: 0, right: 400, bottom: 900 } },
        node: [{ $: { class: "UIButton", text: "Native" } }, ...webViews],
      },
    },
  };
}

const snapshot = (elements: IosSdkWebSnapshot["elements"]): IosSdkWebSnapshot => ({
  snapshotId: "s7",
  url: "https://fixture.local/form?q=1",
  elements,
});

const submit = {
  id: "e0",
  role: "button",
  label: "Submit",
  bounds: [10, 20, 100, 40],
  enabled: true,
  visible: true,
  focused: false,
};

function attached(node: ViewHierarchyNode): Array<Record<string, unknown>> {
  const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
  return children
    .filter((child) => child.extras?.["sdk.source"] === "sdkWebBridge")
    .map((child) => child.$ ?? {});
}

describe("mergeIosSdkWebSnapshots (#5162)", () => {
  test("attaches DOM elements under the outermost WKWebView with screen bounds and web identity", () => {
    const hierarchy = screen(webView());
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "checkout", snapshot: snapshot([submit]) },
    ]);

    expect(summary).toEqual({ webViews: 1, attached: 1, deduplicated: 0 });
    const [outer] = findWebViewNodes(hierarchy);
    const [element] = attached(outer);
    expect(element).toMatchObject({
      class: "button",
      "content-desc": "Submit",
      clickable: "true",
      bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      "web-origin": "https://fixture.local",
    });
    expect(iosSdkWebTarget(element)).toEqual({
      webViewId: "checkout",
      snapshotId: "s7",
      elementId: "e0",
    });
  });

  test("clips elements to the web view and drops hidden or fully scrolled-out ones", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "tall", bounds: [0, 650, 50, 200] },
          { ...submit, id: "hidden", visible: false },
          { ...submit, id: "below", bounds: [0, 900, 50, 20] },
          { ...submit, id: "unbounded", bounds: [] },
        ]),
      },
    ]);
    const elements = attached(findWebViewNodes(hierarchy)[0]);
    expect(elements.map((element) => element["web-element-id"])).toEqual(["tall"]);
    expect(elements[0].bounds).toEqual({ left: 0, top: 750, right: 50, bottom: 800 });
  });

  test("pairs registered web views with WKWebView nodes in order, skipping one with no snapshot", () => {
    const hierarchy = screen(
      webView(),
      webView([], { left: 0, top: 800, right: 400, bottom: 900 }),
    );
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "first" },
      { webViewId: "second", snapshot: snapshot([{ ...submit, bounds: [0, 0, 40, 40] }]) },
    ]);
    expect(summary?.webViews).toBe(1);
    const [first, second] = findWebViewNodes(hierarchy);
    expect(attached(first)).toEqual([]);
    expect(attached(second)[0]).toMatchObject({
      "web-view-id": "second",
      bounds: { left: 0, top: 800, right: 40, bottom: 840 },
    });
  });

  test("attaches nothing when the web-view count does not match the WKWebView count", () => {
    const hierarchy = screen(webView(), webView());
    expect(
      mergeIosSdkWebSnapshots(hierarchy, [{ webViewId: "only", snapshot: snapshot([submit]) }]),
    ).toBeNull();
    expect(findWebViewNodes(hierarchy).flatMap(attached)).toEqual([]);
    expect(
      mergeIosSdkWebSnapshots(screen(), [{ webViewId: "only", snapshot: snapshot([submit]) }]),
    ).toBeNull();
  });

  test("removes an XCTest leaf a DOM element already covers", () => {
    const xctestCopy: ViewHierarchyNode = {
      $: {
        class: "XCUIElementTypeButton",
        "content-desc": "Submit",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([xctestCopy]));
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "checkout", snapshot: snapshot([submit]) },
    ]);
    expect(summary?.deduplicated).toBe(1);
  });

  test("a web identity needs all three ids", () => {
    expect(iosSdkWebTarget({ "web-view-id": "w", "web-snapshot-id": "s" })).toBeNull();
  });
});
