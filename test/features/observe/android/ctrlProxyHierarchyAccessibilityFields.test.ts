import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityNode,
  HierarchyDelegateContext,
} from "../../../../src/features/observe/android/types";
import { ViewHierarchy } from "../../../../src/features/observe/ViewHierarchy";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { projectAuditElements } from "../../../../src/features/accessibility/AuditElementProjection";
import { projectSkeleton } from "../../../../src/features/observe/output/SkeletonProjection";
import { ElementResolver } from "../../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

function convert(node: AccessibilityNode) {
  const timer = new FakeTimer();
  const context: HierarchyDelegateContext = {
    timer,
    requestManager: new RequestManager(timer),
    getWebSocket: () => null,
    ensureConnected: async () => true,
    cancelScreenshotBackoff: () => {},
    device: { name: "Fake Android", deviceId: "fake-android", platform: "android" },
    adb: new FakeAdbExecutor(),
    getCachedHierarchy: () => null,
    setCachedHierarchy: () => {},
    getLastWebSocketTimeout: () => 0,
    setLastWebSocketTimeout: () => {},
  };
  return new CtrlProxyHierarchy(context).convertToViewHierarchyResult({
    updatedAt: 1,
    packageName: "app",
    hierarchy: { node },
    "accessibility-focused-element": node,
  });
}

// No real captured Android CtrlProxy fixture in test/fixtures contains hint-text.
// This input is built from UIElementInfo.kt's exact Kotlin serialized key names
// and #9439's direct-WebSocket node, extended with bounds/identity/clickability;
// it is NOT a device capture.
const filledField = {
  text: "Ada",
  className: "android.widget.EditText",
  focused: "true",
  focusable: "true",
  clickable: "true",
  "hint-text": "First name",
  "view-id": "first-name",
  bounds: { left: 0, top: 0, right: 200, bottom: 40 },
};

const otherFields = [
  ["state-description", "Required"],
  ["error-message", "Enter a name"],
  ["tooltip-text", "Your given name"],
  ["pane-title", "Contact editor"],
  ["live-region", "polite"],
  ["collection-info", "rows:2,cols:1"],
  ["collection-item-info", "row:0,col:0"],
  ["range-info", "current:1.0,min:0.0,max:2.0"],
] as const;
const fields = ["hint-text", ...otherFields.map(([key]) => key)];

describe("CtrlProxyHierarchy accessibility fields", () => {
  test("conversion exposes the wire hint to search, projection and the focused mirror", () => {
    const converted = convert(filledField);
    expect(converted.hierarchy.node).toHaveProperty("hint-text", "First name");
    expect(converted["accessibility-focused-element"]).toHaveProperty("hint-text", "First name");
    const nodes = new SearchableHierarchy().project(converted);
    expect(nodes.find((node) => node.nodeKey === "first-name")?.properties["hint-text"]).toBe(
      "First name",
    );
    const elements = new DefaultObserveElementCollector().collect(converted, "android");
    expect(elements?.clickable?.[0]["hint-text"]).toBe("First name");
    const projection = Object.create(ViewHierarchy.prototype) as ViewHierarchy;
    expect(projection.cleanNodeProperties(converted.hierarchy.node)).toHaveProperty(
      "hint-text",
      "First name",
    );
  });

  test.each(["tap", "input", "focus-input"] as const)(
    "%s resolves the converted filled field by hint only when opted in",
    (action) => {
      const converted = convert(filledField);
      const snapshot = { id: "capture", nodes: new SearchableHierarchy().project(converted) };
      const resolver = new ElementResolver();
      const selector = { text: "First name" };
      expect(resolver.resolve(snapshot, selector, { action }).chosen).toBeNull();
      const resolved = resolver.resolve(snapshot, selector, { action, allowHintFallback: true });
      expect(resolved.chosen?.nodeKey).toBe("first-name");
      expect(resolved.chosen?.label).toBe("Ada");
      expect(resolved.matchMode).toBe("exact");
      expect(
        resolver.resolve(snapshot, selector, { action, allowHintFallback: true, negative: true })
          .chosen,
      ).toBeNull();
    },
  );

  test.each(["absent", "null", "empty"] as const)(
    "%s semantics retain the exact previous converted node shape",
    (absence) => {
      const withoutHint: AccessibilityNode = { ...filledField };
      delete withoutHint["hint-text"];
      const omitted =
        absence === "absent"
          ? {}
          : Object.fromEntries(fields.map((key) => [key, absence === "null" ? null : ""]));
      const converted = convert({ ...withoutHint, ...omitted });
      expect(converted.hierarchy).toStrictEqual({
        node: {
          text: "Ada",
          class: "android.widget.EditText",
          className: "android.widget.EditText",
          focused: "true",
          focusable: "true",
          clickable: "true",
          "view-id": "first-name",
          bounds: { left: 0, top: 0, right: 200, bottom: 40 },
        },
      });
      for (const key of fields) {
        expect(Object.hasOwn(converted.hierarchy.node, key)).toBe(false);
      }
    },
  );

  test.each(otherFields)(
    "preserves non-empty %s in conversion and existing full projection",
    (key, value) => {
      const converted = convert({ ...filledField, [key]: value });
      expect(converted.hierarchy.node).toHaveProperty(key, value);
      // cleanNodeProperties is a pure projection; no ViewHierarchy transport/DB is constructed.
      const projection = Object.create(ViewHierarchy.prototype) as ViewHierarchy;
      expect(projection.cleanNodeProperties(converted.hierarchy.node)).toHaveProperty(key, value);
      const collector = new DefaultObserveElementCollector();
      expect(projectSkeleton(collector.collect(converted, "android")).skeleton).toEqual(
        projectSkeleton(collector.collect(convert(filledField), "android")).skeleton,
      );
    },
  );

  test("existing skeleton keeps filled text as the label and carries the converted hint as sublabel (#9346)", () => {
    const collector = new DefaultObserveElementCollector();
    const skeleton = (text: string) =>
      projectSkeleton(collector.collect(convert({ ...filledField, text }), "android")).skeleton;
    expect(skeleton("Ada")).toEqual([
      {
        elementId: "first-name",
        label: "Ada",
        sublabel: "First name",
        bounds: [0, 0, 200, 40],
        affordances: ["tap", "input"],
      },
    ]);
    expect(skeleton("")).toEqual([
      {
        elementId: "first-name",
        label: "First name",
        bounds: [0, 0, 200, 40],
        affordances: ["tap", "input"],
      },
    ]);
  });

  test("stable identity consumes the converted hint, survives typing and distinguishes fields", () => {
    const id = (hint: string, text: string) =>
      convert({
        ...filledField,
        "view-id": "12345678-0000-4000-8000-000000000000",
        "hint-text": hint,
        text,
      }).hierarchy.node?.["view-id"];
    expect(id("First name", "")).toBe(id("First name", "Ada"));
    expect(id("First name", "Ada")).not.toBe(id("Last name", "Ada"));
  });

  // Wire shape per ViewHierarchyExtractor.kt (`textSize` = textSizeInPx); the repo has no
  // numeric-textSize CtrlProxy capture (only null), so this node is not a device capture.
  test("reported textSize (px) survives conversion to the audit element (#10134)", () => {
    const converted = convert({ ...filledField, textSize: 48 });
    expect(converted.hierarchy.node).toHaveProperty("textSize", 48);
    const { elements } = projectAuditElements(converted);
    expect(elements.find((element) => element.text === "Ada")?.textSize).toBe(48);
  });

  test.each([null, 0, -1, Number.NaN])("unreported textSize %p is not forwarded", (textSize) => {
    const converted = convert({ ...filledField, textSize });
    expect(converted.hierarchy.node).not.toHaveProperty("textSize");
  });
});
