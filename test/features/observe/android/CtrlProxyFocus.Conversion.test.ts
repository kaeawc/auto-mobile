import {
  capturedAndroidControl,
  androidControlObservation,
} from "../../../helpers/androidDisabledControlCapture";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";
import { describe, expect, test } from "bun:test";
import { CtrlProxyFocus } from "../../../../src/features/observe/android/CtrlProxyFocus";
import type { AccessibilityNode } from "../../../../src/features/observe/android/types";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

function focus(): CtrlProxyFocus {
  const timer = new FakeTimer();
  return new CtrlProxyFocus({
    timer,
    requestManager: new RequestManager(timer),
    getWebSocket: () => null,
    ensureConnected: async () => false,
    cancelScreenshotBackoff: () => {},
  });
}

describe("CtrlProxyFocus typed node conversion", () => {
  test("copies identity, metadata, bounds and child nodes while preserving aliases", () => {
    const node: AccessibilityNode = {
      text: "Focus",
      "content-desc": "Label",
      "resource-id": "pkg:id/view",
      "test-tag": "tag",
      "view-id": "view",
      className: "android.widget.Button",
      packageName: "pkg",
      occlusionState: "partial",
      occludedBy: "overlay",
      occludedByViewId: "overlay-view",
      extras: { role: "button" },
      recomposition: { id: "composition", total: 2 },
      bounds: { left: 0, top: 0, right: 20, bottom: 10 },
      node: [{ text: "Child" }],
    };
    const result = focus()["convertAccessibilityNode"](node);
    expect(result).toEqual({ ...node, class: node.className, node: { text: "Child" } });
    expect(result.bounds).toBe(node.bounds);
    expect(result.extras).toBe(node.extras);
    expect(result.recomposition).toBe(node.recomposition);
    expect(node.node).toEqual([{ text: "Child" }]);
  });

  for (const key of [
    "clickable",
    "enabled",
    "focusable",
    "focused",
    "scrollable",
    "password",
    "checkable",
    "checked",
    "selected",
    "long-clickable",
  ] as const) {
    for (const value of [undefined, "", "false", "true", "yes"]) {
      test(`${key}=${String(value)} retains supplied enabled values and filters default-false flags`, () => {
        const result = focus()["convertAccessibilityNode"]({ [key]: value });
        expect(result).toEqual(
          key === "enabled" && value !== undefined
            ? { [key]: value }
            : value && value !== "false"
              ? { [key]: value }
              : {},
        );
      });
    }
  }

  test("omits absent and empty metadata", () => {
    expect(
      focus()["convertAccessibilityNode"]({
        text: "",
        className: "",
        "resource-id": "",
        "view-id": "",
        "test-tag": "",
        "content-desc": "",
        packageName: "",
        occludedBy: "",
        occludedByViewId: "",
      }),
    ).toEqual({});
  });

  test("preserves zero, one and multiple node-array cardinality recursively", () => {
    const converter = focus();
    expect(converter["convertAccessibilityNode"]([])).toEqual([]);
    expect(converter["convertAccessibilityNode"]([{ text: "One" }])).toEqual({ text: "One" });
    expect(
      converter["convertAccessibilityNode"]([
        { text: "One", node: [] },
        { text: "Two", node: [{ text: "Nested" }] },
      ]),
    ).toEqual([
      { text: "One", node: [] },
      { text: "Two", node: { text: "Nested" } },
    ]);
  });
});

test("captured Android disabled control survives focused-element conversion and output", () => {
  const focusedElement = focus().convertAccessibilityNodeToElement(capturedAndroidControl());
  expect(focusedElement?.enabled).toBe("false");
  const observation = {
    ...androidControlObservation(),
    focusedElement: focusedElement ?? undefined,
  };
  expect(
    sanitizeObserveResult(observation, { dropElements: false, project: "full", compact: true })
      .focusedElement?.enabled,
  ).toBe("false");
});
