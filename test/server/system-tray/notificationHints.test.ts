import { describe, it, expect } from "bun:test";
import {
  getNodeProperties,
  traverseForHint,
  getHierarchyRoots,
  nodeHasSystemTrayHint,
  nodeHasIosNotificationCenterHint,
  SYSTEM_TRAY_PACKAGE,
} from "../../../src/server/system-tray/notificationHints";
import type { ViewHierarchyResult } from "../../../src/models";

/** Build a ViewHierarchyResult wrapping an arbitrary hierarchy shape. */
function viewHierarchy(hierarchy: unknown): ViewHierarchyResult {
  return { hierarchy } as unknown as ViewHierarchyResult;
}

describe("getNodeProperties", () => {
  it("returns the $ attribute bag when present", () => {
    expect(getNodeProperties({ $: { class: "Foo" } })).toEqual({ class: "Foo" });
  });
  it("returns the node itself when there is no $ wrapper", () => {
    expect(getNodeProperties({ class: "Foo" })).toEqual({ class: "Foo" });
  });
  it("returns null for null", () => {
    expect(getNodeProperties(null)).toBeNull();
  });
  it("returns null for a non-object", () => {
    expect(getNodeProperties("nope")).toBeNull();
  });
  it("treats an empty $ as no wrapper and returns the node", () => {
    expect(getNodeProperties({ $: null, class: "Bar" })).toEqual({ $: null, class: "Bar" });
  });
});

describe("getHierarchyRoots", () => {
  it("returns [] when the hierarchy carries an error", () => {
    expect(getHierarchyRoots(viewHierarchy({ error: "boom", node: { $: {} } }))).toEqual([]);
  });
  it("returns [] when the hierarchy is missing", () => {
    expect(getHierarchyRoots(viewHierarchy(undefined))).toEqual([]);
  });
  it("wraps a single node object in an array", () => {
    const single = { $: { class: "A" } };
    expect(getHierarchyRoots(viewHierarchy({ node: single }))).toEqual([single]);
  });
  it("returns a node array unchanged", () => {
    const nodes = [{ $: { class: "A" } }, { $: { class: "B" } }];
    expect(getHierarchyRoots(viewHierarchy({ node: nodes }))).toEqual(nodes);
  });
  it("unwraps a nested .hierarchy shape", () => {
    const nested = { $: { class: "Nested" } };
    expect(getHierarchyRoots(viewHierarchy({ hierarchy: nested }))).toEqual([nested]);
  });
  it("falls back to wrapping the hierarchy object itself", () => {
    const bare = { $: { class: "Bare" } };
    expect(getHierarchyRoots(viewHierarchy(bare))).toEqual([bare]);
  });
});

describe("traverseForHint", () => {
  const isTarget = (node: { $?: { id?: string } }): boolean => node?.$?.id === "target";

  it("returns false for a null node", () => {
    expect(traverseForHint(null, isTarget)).toBe(false);
  });
  it("matches the root itself", () => {
    expect(traverseForHint({ $: { id: "target" } }, isTarget)).toBe(true);
  });
  it("finds a match in an array of children", () => {
    const tree = { $: { id: "root" }, node: [{ $: { id: "x" } }, { $: { id: "target" } }] };
    expect(traverseForHint(tree, isTarget)).toBe(true);
  });
  it("finds a match through a single-object child", () => {
    const tree = { $: { id: "root" }, node: { $: { id: "target" } } };
    expect(traverseForHint(tree, isTarget)).toBe(true);
  });
  it("finds a match nested several levels deep", () => {
    const tree = { $: { id: "a" }, node: [{ $: { id: "b" }, node: [{ $: { id: "target" } }] }] };
    expect(traverseForHint(tree, isTarget)).toBe(true);
  });
  it("returns false when nothing matches", () => {
    const tree = { $: { id: "a" }, node: [{ $: { id: "b" } }] };
    expect(traverseForHint(tree, isTarget)).toBe(false);
  });
});

describe("nodeHasSystemTrayHint", () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    [
      "matches systemui package + resource-id hint",
      { packageName: SYSTEM_TRAY_PACKAGE, "resource-id": "notification_panel" },
      true,
    ],
    [
      "matches systemui package + class hint",
      { packageName: SYSTEM_TRAY_PACKAGE, class: "NotificationShade" },
      true,
    ],
    [
      "matches when resource-id embeds the systemui package",
      { "resource-id": `${SYSTEM_TRAY_PACKAGE}:id/qs_panel` },
      true,
    ],
    [
      "rejects a systemui node with no matching hint",
      { packageName: SYSTEM_TRAY_PACKAGE, "resource-id": "random_thing" },
      false,
    ],
    [
      "rejects a hint from a non-systemui package",
      { packageName: "com.example.app", "resource-id": "notification_panel" },
      false,
    ],
    ["rejects a node with no properties at all", {}, false],
  ];
  it.each(cases)("%s", (_name, props, expected) => {
    expect(nodeHasSystemTrayHint({ $: props })).toBe(expected);
  });
  it("returns false for a null node", () => {
    expect(nodeHasSystemTrayHint(null)).toBe(false);
  });
});

describe("nodeHasIosNotificationCenterHint", () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["matches a NotificationCenter class", { class: "NotificationCenterView" }, true],
    ["matches a hint in the content-desc", { "content-desc": "NCNotificationShortLookView" }, true],
    ["matches a hint in the identifier", { identifier: "PLPlatterView-1" }, true],
    [
      "matches via the ios-accessibility-label",
      { "ios-accessibility-label": "NotificationListCell" },
      true,
    ],
    ["rejects a node with no ios hints", { class: "UIView", "content-desc": "ok button" }, false],
    ["rejects an empty node", {}, false],
  ];
  it.each(cases)("%s", (_name, props, expected) => {
    expect(nodeHasIosNotificationCenterHint({ $: props })).toBe(expected);
  });
  it("returns false for a null node", () => {
    expect(nodeHasIosNotificationCenterHint(null)).toBe(false);
  });
});
