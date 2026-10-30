import { describe, expect, test } from "bun:test";
import {
  findWebViewNodes,
  iosSdkWebTarget,
  mergeIosSdkWebSnapshots,
} from "../../../../src/features/observe/ios/iosSdkWebMerge";
import type { IosSdkWebSnapshot } from "../../../../src/features/observe/ios/sdkWebViewBridge";
import { hashHierarchyForSettle } from "../../../../src/features/observe/wait/WaitSettle";
import type { Element, ViewHierarchyNode, ViewHierarchyResult } from "../../../../src/models";
import { isFocusEditableElement } from "../../../../src/features/utility/ElementResolverNodes";
import { isEditableElementProperties } from "../../../../src/features/utility/elementProperties";
import { FieldTypeDetector } from "../../../../src/features/action/FieldTypeDetector";
import { hierarchyFingerprint } from "../../../../src/utils/hierarchyFingerprint";

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

/** Every merged DOM element anywhere under `node`. */
function webElements(node: ViewHierarchyNode): Array<Record<string, unknown>> {
  const children = Array.isArray(node.node) ? node.node : node.node ? [node.node] : [];
  return [
    ...(node.extras?.["sdk.source"] === "sdkWebBridge" ? [node.$ ?? {}] : []),
    ...children.flatMap(webElements),
  ];
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

  test("two web views stay XCTest-only: registration order says nothing about screen order", () => {
    const hierarchy = screen(
      webView(),
      webView([], { left: 0, top: 800, right: 400, bottom: 900 }),
    );
    const merged = mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "first", snapshot: snapshot([submit]) },
      { webViewId: "second", snapshot: snapshot([submit]) },
    ]);
    expect(merged).toBeNull();
    expect(findWebViewNodes(hierarchy).flatMap(attached)).toEqual([]);
  });

  test("a single web view without a snapshot attaches nothing", () => {
    expect(mergeIosSdkWebSnapshots(screen(webView()), [{ webViewId: "first" }])).toBeNull();
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

describe("web snapshot identity and change detection (#5162)", () => {
  test("an unchanged page hashes the same across snapshot ids", () => {
    const first = screen(webView());
    const second = screen(webView());
    mergeIosSdkWebSnapshots(first, [
      { webViewId: "checkout", snapshot: { ...snapshot([submit]), snapshotId: "s1" } },
    ]);
    mergeIosSdkWebSnapshots(second, [
      { webViewId: "checkout", snapshot: { ...snapshot([submit]), snapshotId: "s2" } },
    ]);
    expect(hierarchyFingerprint(first)).toBe(hierarchyFingerprint(second));
    expect(hashHierarchyForSettle(first)).toBe(hashHierarchyForSettle(second));

    const moved = screen(webView());
    mergeIosSdkWebSnapshots(moved, [
      { webViewId: "checkout", snapshot: snapshot([{ ...submit, label: "Paid" }]) },
    ]);
    expect(hierarchyFingerprint(moved)).not.toBe(hierarchyFingerprint(first));
  });
});

describe("editable DOM fields (#5162)", () => {
  test("text entry roles stay editable for focus and sendKeys targeting", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "email", role: "input", label: "Email", bounds: [0, 0, 200, 40] },
          { ...submit, id: "notes", role: "textarea", label: "Notes", bounds: [0, 50, 200, 40] },
          { ...submit, id: "pay", role: "button", label: "Pay", bounds: [0, 100, 200, 40] },
        ]),
      },
    ]);
    const roles = attached(findWebViewNodes(hierarchy)[0]).map((element) => [
      element.class,
      element.role,
    ]);
    expect(roles).toEqual([
      ["input", "textfield"],
      ["textarea", "textfield"],
      ["button", "button"],
    ]);
    const [email] = attached(findWebViewNodes(hierarchy)[0]);
    expect(isFocusEditableElement(email as Element)).toBe(true);
    expect(isEditableElementProperties(email)).toBe(true);
    expect(new FieldTypeDetector().detect(email as Element)).not.toBe("unknown");
  });
});

describe("ambiguous DOM element ids (#5162)", () => {
  test("elements sharing an id are not attached, so no action can name the wrong one", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "e0", label: "Inserted", bounds: [0, 0, 100, 40] },
          { ...submit, id: "e0", label: "Original", bounds: [0, 50, 100, 40] },
          { ...submit, id: "e1", label: "Pay", bounds: [0, 100, 100, 40] },
        ]),
      },
    ]);
    expect(
      attached(findWebViewNodes(hierarchy)[0]).map((element) => element["content-desc"]),
    ).toEqual(["Pay"]);
  });

  test("an element with an empty id is not attached, since no action could name it", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "" },
          { ...submit, id: "e1", label: "Pay", bounds: [0, 100, 100, 40] },
        ]),
      },
    ]);
    expect(
      webElements(findWebViewNodes(hierarchy)[0]).map((element) => element["content-desc"]),
    ).toEqual(["Pay"]);
  });
});

describe("covered XCTest leaves (#5162)", () => {
  test("a DOM element that replaces an XCTest leaf keeps its native identifier", () => {
    const native: ViewHierarchyNode = {
      $: {
        class: "XCUIElementTypeButton",
        "resource-id": "submit-order",
        "content-desc": "Submit",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "checkout", snapshot: snapshot([submit]) },
    ]);
    expect(summary?.deduplicated).toBe(1);
    const element = webElements(findWebViewNodes(hierarchy)[0])[0];
    expect(element).toMatchObject({
      "resource-id": "submit-order",
      class: "XCUIElementTypeButton",
      "content-desc": "Submit",
      bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      "web-element-id": "e0",
    });
  });

  test("a native leaf two DOM elements both match is kept, so its id names neither", () => {
    // <div role="group"><button>Pay</button></div>: the wrapper and the button share bounds and label.
    const native: ViewHierarchyNode = {
      $: {
        class: "XCUIElementTypeButton",
        "resource-id": "pay",
        "content-desc": "Pay",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    const group = { ...submit, id: "e0", role: "group", label: "Pay" };
    const button = { ...submit, id: "e1", role: "button", label: "Pay" };
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "checkout", snapshot: snapshot([group, button]) },
    ]);
    expect(summary?.deduplicated).toBe(0);
    const elements = webElements(findWebViewNodes(hierarchy)[0]);
    expect(elements.map((element) => element["web-element-id"])).toEqual(["e0", "e1"]);
    expect(elements.some((element) => element["resource-id"] === "pay")).toBe(false);
  });
});

describe("replacement in place (#5162)", () => {
  test("a DOM element replaces its XCTest leaf inside the leaf's container", () => {
    const native: ViewHierarchyNode = {
      $: {
        "resource-id": "submit-order",
        "content-desc": "Submit",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const section: ViewHierarchyNode = { $: { "resource-id": "checkout-section" }, node: [native] };
    const hierarchy = screen(webView([section]));
    mergeIosSdkWebSnapshots(hierarchy, [{ webViewId: "checkout", snapshot: snapshot([submit]) }]);
    const children = Array.isArray(section.node) ? section.node : [];
    expect(children).toHaveLength(1);
    expect(children[0].$).toMatchObject({ "resource-id": "submit-order", "web-element-id": "e0" });
    // Not also appended under the web view.
    expect(attached(findWebViewNodes(hierarchy)[0])).toEqual([]);
  });
});

describe("native field semantics on replacement (#5162)", () => {
  test("a blank native text field replaced by a DOM input still skips text verification", () => {
    const native: ViewHierarchyNode = {
      $: {
        class: "UITextField",
        text: "Email",
        "content-desc": "Email",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "checkout", snapshot: snapshot([{ ...submit, role: "input", label: "Email" }]) },
    ]);
    const element = webElements(findWebViewNodes(hierarchy)[0])[0] as Element;
    expect(element.class).toBe("UITextField");
    const detector = new FieldTypeDetector();
    expect(detector.shouldSkipVerification(element, detector.detect(element))).toBe(true);
  });
});

describe("fresh native state on replacement (#5162)", () => {
  test("a replaced leaf keeps the device's current focus, not the snapshot's", () => {
    // The snapshot saw Email focused; focus has since moved to Name without a DOM change.
    const email: ViewHierarchyNode = {
      $: {
        class: "UITextField",
        "content-desc": "Email",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const name: ViewHierarchyNode = {
      $: {
        class: "UITextField",
        "content-desc": "Name",
        focused: "true",
        bounds: { left: 10, top: 170, right: 110, bottom: 210 },
      },
    };
    const hierarchy = screen(webView([email, name]));
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "email", role: "input", label: "Email", focused: true },
          { ...submit, id: "name", role: "input", label: "Name", bounds: [10, 70, 100, 40] },
        ]),
      },
    ]);
    const focused = webElements(findWebViewNodes(hierarchy)[0]).map((element) => [
      element["web-element-id"],
      element.focused,
    ]);
    expect(focused).toEqual([
      ["email", undefined],
      ["name", "true"],
    ]);
  });
});

describe("redacted DOM values (#5162)", () => {
  test("a redacted input value is not reported as text, and text verification skips it", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "email", role: "input", label: "Email", value: "[REDACTED]" },
        ]),
      },
    ]);
    const [email] = attached(findWebViewNodes(hierarchy)[0]) as Element[];
    expect(email.text).toBeUndefined();
    const detector = new FieldTypeDetector();
    expect(detector.shouldSkipVerification(email, detector.detect(email))).toBe(true);
  });

  test("an unredacted input value is still verified", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "email", role: "input", label: "Email", value: "a@b.c" },
        ]),
      },
    ]);
    const [email] = attached(findWebViewNodes(hierarchy)[0]) as Element[];
    expect(email.text).toBe("a@b.c");
    const detector = new FieldTypeDetector();
    expect(detector.shouldSkipVerification(email, detector.detect(email))).toBe(false);
  });
});

describe("coordinate quantization (#5162)", () => {
  test("fractional DOM bounds truncate as the runner's XCTest bounds do, so the native twin is replaced", () => {
    // The runner reports a frame of x 10.75…110.75 as left 10, right 110 (`Int(value)` truncates).
    const native: ViewHierarchyNode = {
      $: {
        class: "XCUIElementTypeButton",
        "content-desc": "Submit",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([{ ...submit, bounds: [10.75, 20.75, 100, 40] }]),
      },
    ]);
    expect(summary?.deduplicated).toBe(1);
    const elements = webElements(findWebViewNodes(hierarchy)[0]);
    expect(elements).toHaveLength(1);
    expect(elements[0].bounds).toEqual({ left: 10, top: 120, right: 110, bottom: 160 });
  });
});

describe("redaction over a readable native value (#5162)", () => {
  test("a replaced native field whose value XCTest reads stays verifiable", () => {
    const native: ViewHierarchyNode = {
      $: {
        class: "UITextField",
        "content-desc": "Email",
        value: "correct",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([{ ...submit, role: "input", label: "Email", value: "[REDACTED]" }]),
      },
    ]);
    const element = webElements(findWebViewNodes(hierarchy)[0])[0] as Element;
    expect(element.value).toBe("correct");
    expect(element["value-redacted"]).toBeUndefined();
    const detector = new FieldTypeDetector();
    expect(detector.shouldSkipVerification(element, detector.detect(element))).toBe(false);
  });
});

describe("a native leaf matching two DOM elements by different attributes (#5162)", () => {
  test("is kept, so neither DOM element takes its identifiers", () => {
    const native: ViewHierarchyNode = {
      $: {
        class: "XCUIElementTypeButton",
        "resource-id": "checkout",
        "content-desc": "Pay",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    const summary = mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "e0", label: "checkout" },
          { ...submit, id: "e1", label: "Pay" },
        ]),
      },
    ]);
    expect(summary?.deduplicated).toBe(0);
    const elements = webElements(findWebViewNodes(hierarchy)[0]);
    expect(elements.map((element) => element["web-element-id"])).toEqual(["e0", "e1"]);
    expect(elements.some((element) => element["resource-id"] === "checkout")).toBe(false);
  });
});

describe("CSS pixels to web-view points (#5162)", () => {
  test("a page laid out wider than the web view is scaled down before clipping", () => {
    // A 400 pt web view showing an 800 px layout viewport: half a point per CSS pixel.
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: {
          ...snapshot([{ ...submit, bounds: [400, 40, 100, 40] }]),
          viewport: { offsetLeft: 0, offsetTop: 0, width: 800, height: 1400, scale: 0.5 },
        },
      },
    ]);
    const [element] = attached(findWebViewNodes(hierarchy)[0]);
    expect(element?.bounds).toEqual({ left: 200, top: 120, right: 250, bottom: 140 });
  });

  test("a pinch-zoomed page maps through the visual viewport's offset and scale", () => {
    // Zoomed 2x and panned: the 200 px visual viewport starts at (100, 50) in the layout viewport.
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: {
          ...snapshot([{ ...submit, bounds: [150, 70, 20, 10] }]),
          viewport: { offsetLeft: 100, offsetTop: 50, width: 200, height: 350, scale: 2 },
        },
      },
    ]);
    const [element] = attached(findWebViewNodes(hierarchy)[0]);
    expect(element?.bounds).toEqual({ left: 100, top: 140, right: 140, bottom: 160 });
  });
});

describe("input types (#5162)", () => {
  test("only text-like inputs are reported as text fields", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "agree", role: "input", inputType: "checkbox", bounds: [0, 0, 20, 20] },
          { ...submit, id: "email", role: "input", inputType: "email", bounds: [0, 30, 200, 40] },
          { ...submit, id: "legacy", role: "input", bounds: [0, 80, 200, 40] },
        ]),
      },
    ]);
    const roles = attached(findWebViewNodes(hierarchy)[0]).map((element) => [
      element["web-element-id"],
      element.role,
      element["input-type"],
    ]);
    expect(roles).toEqual([
      ["agree", "input", undefined],
      ["email", "textfield", "text"],
      ["legacy", "textfield", "text"],
    ]);
  });
});

describe("the DOM role (#5162)", () => {
  test("each merged element carries its DOM role, even where a native class wins", () => {
    const native: ViewHierarchyNode = {
      $: {
        class: "UITextField",
        "content-desc": "Email",
        bounds: { left: 10, top: 120, right: 110, bottom: 160 },
      },
    };
    const hierarchy = screen(webView([native]));
    mergeIosSdkWebSnapshots(hierarchy, [
      {
        webViewId: "checkout",
        snapshot: snapshot([
          { ...submit, id: "email", role: "input", label: "Email" },
          { ...submit, id: "notes", role: "textbox", label: "Notes", bounds: [0, 300, 200, 40] },
        ]),
      },
    ]);
    const roles = webElements(findWebViewNodes(hierarchy)[0]).map((element) => [
      element["web-element-id"],
      element.class,
      element["web-role"],
    ]);
    expect(roles).toEqual([
      ["email", "UITextField", "input"],
      ["notes", "textbox", "textbox"],
    ]);
  });
});

describe("page identity (#5162)", () => {
  test("each merged element carries its snapshot's document id, and its web target reads it", () => {
    const hierarchy = screen(webView());
    mergeIosSdkWebSnapshots(hierarchy, [
      { webViewId: "checkout", snapshot: { ...snapshot([submit]), documentId: "d1" } },
    ]);
    const [element] = attached(findWebViewNodes(hierarchy)[0]);
    expect(element["web-document-id"]).toBe("d1");
    expect(iosSdkWebTarget(element)).toEqual({
      webViewId: "checkout",
      snapshotId: "s7",
      elementId: "e0",
      documentId: "d1",
    });
  });
});
