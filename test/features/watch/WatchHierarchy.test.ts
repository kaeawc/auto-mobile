import { expect, test } from "bun:test";
import { normalizeWatchHierarchy } from "../../../src/features/watch/WatchHierarchy";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ActionableError } from "../../../src/models/ActionableError";
import hierarchy from "../../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";

function elements(value: unknown) {
  return new DefaultElementParser()
    .flattenViewHierarchy(normalizeWatchHierarchy(value))
    .map((entry) => entry.element);
}

test("normalizes the live SDK watch tree through the iOS observation model", () => {
  const normalized = normalizeWatchHierarchy(hierarchy);
  expect(normalized).toMatchObject({
    screenWidth: 184,
    screenHeight: 224,
    screenScale: 1,
    updatedAt: hierarchy.timestamp,
  });
  const nodes = elements(hierarchy);
  expect(nodes.find((element) => element.text === "CtrlProxyWatch")).toMatchObject({
    class: "XCUIElementType(2)",
    bounds: { left: 0, top: 0, right: 184, bottom: 224 },
  });
  expect(nodes.find((element) => element["resource-id"] === "ctrlproxy-crown")).toMatchObject({
    text: "CtrlProxy Watch",
    class: "XCUIElementType(48)",
    bounds: { left: 29, top: 114, right: 154, bottom: 134 },
  });
  const crownValue = nodes.find((element) => element["resource-id"] === "ctrlproxy-crown-value");
  expect(crownValue).toMatchObject({
    text: "crown 0.00",
    bounds: { left: 48, top: 154, right: 135, bottom: 174 },
  });
  expect(crownValue).not.toHaveProperty("clickable");
  expect(
    nodes.find((element) => element["resource-id"] === "ctrlproxy-non-hittable"),
  ).toMatchObject({
    bounds: { left: 92, top: 124, right: 92, bottom: 124 },
  });
});

test("preserves point bounds regardless of screen scale and uses the wire bundle id", () => {
  const scaled = { ...hierarchy, screenScale: 2, bundleId: "dev.example.watch" };
  expect(normalizeWatchHierarchy(scaled)).toMatchObject({
    packageName: "dev.example.watch",
    screenScale: 2,
    screenWidth: 184,
    screenHeight: 224,
  });
  expect(elements(scaled)).toEqual(elements(hierarchy));
});

test.each([{ isHidden: true }, { isOccluded: true }, { alpha: 0 }])(
  "omits invisible SDK subtrees: %j",
  (visibility) => {
    const tree = structuredClone(hierarchy);
    Object.assign(tree.root.children[0], visibility);
    expect(elements(tree).some((element) => element["resource-id"] === "ctrlproxy-crown")).toBe(
      false,
    );
  },
);

test("maps SDK interaction, focus and trait flags without inferring them from class names", () => {
  const tree = structuredClone(hierarchy);
  Object.assign(tree.root, {
    isUserInteractionEnabled: false,
    hasTapTarget: true,
    isAccessibilityElement: true,
    isAccessibilityFocused: true,
    accessibilityTraits: ["header"],
  });
  expect(elements(tree).find((element) => element.text === "CtrlProxyWatch")).toMatchObject({
    enabled: "false",
    clickable: "true",
    focusable: "true",
    "accessibility-focused": "true",
    role: "heading",
  });
});

test("accepts SDK optional node fields omitted or null using the wire defaults", () => {
  const root = { className: hierarchy.root.className, bounds: hierarchy.root.bounds };
  expect(() => normalizeWatchHierarchy({ ...hierarchy, root })).not.toThrow();
  expect(() =>
    normalizeWatchHierarchy({ ...hierarchy, root: { ...root, children: null } }),
  ).not.toThrow();
});

test("accepts an invisible root without publishing its contents", () => {
  const tree = structuredClone(hierarchy);
  tree.root.isHidden = true;
  expect(elements(tree).some((element) => element.text === "CtrlProxyWatch")).toBe(false);
});

test.each([
  null,
  { children: [] },
  { ...hierarchy, root: null },
  { ...hierarchy, screenWidth: NaN },
  { ...hierarchy, screenHeight: 0 },
  { ...hierarchy, screenScale: Infinity },
  { ...hierarchy, timestamp: "invalid" },
  { ...hierarchy, root: { ...hierarchy.root, bounds: { left: 0 } } },
  { ...hierarchy, root: { ...hierarchy.root, children: [{}] } },
])("rejects malformed SDK hierarchies with an actionable error: %j", (value) => {
  expect(() => normalizeWatchHierarchy(value)).toThrow(ActionableError);
  expect(() => normalizeWatchHierarchy(value)).toThrow("invalid hierarchy");
});
