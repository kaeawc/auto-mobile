import { describe, expect, test } from "bun:test";
import {
  buildIosLayoutTelemetryTree,
  hashIosLayoutTelemetryTree,
} from "../../../../src/features/observe/ios/IosLayoutTelemetryTree";
import { goldenLayoutHierarchy, largeLayoutHierarchy } from "./iosLayoutTelemetryFixture";

describe("iOS layout telemetry display tree", () => {
  test("maps only Android's flat display properties and recursively preserves children", () => {
    const result = buildIosLayoutTelemetryTree({
      $: {
        class: "UIButton",
        "resource-id": "id",
        text: "Title",
        "content-desc": "Label",
        scrollable: "true",
        bounds: "omitted",
        enabled: "true",
        "view-id": "omitted",
      },
      node: [{ $: { class: "UILabel", text: "child", scrollable: "false" } }],
    });
    expect(result).toEqual({
      node: {
        className: "UIButton",
        "resource-id": "id",
        text: "Title",
        "content-desc": "Label",
        scrollable: "true",
        node: [{ className: "UILabel", text: "child" }],
      },
      truncated: false,
    });
  });

  test("normalizes lone object children from the wire despite the array-only model type", () => {
    const node = JSON.parse('{"$":{"class":"UIView"},"node":{"$":{"text":"child"}}}');
    expect(buildIosLayoutTelemetryTree(node).node).toEqual({
      className: "UIView",
      node: [{ text: "child" }],
    });
  });

  test("handles an absent root without inventing display content", () => {
    expect(buildIosLayoutTelemetryTree(undefined)).toEqual({ node: {}, truncated: false });
  });

  test("caps at 100 nodes in pre-order and keeps the golden frame complete", () => {
    const count = (node: { node?: object[] }): number =>
      1 + (node.node ?? []).reduce<number>((sum, child) => sum + count(child), 0);
    const golden = buildIosLayoutTelemetryTree(goldenLayoutHierarchy().hierarchy.node);
    const large = buildIosLayoutTelemetryTree(largeLayoutHierarchy().hierarchy.node);
    expect(count(golden.node)).toBe(55);
    expect(golden.truncated).toBe(false);
    expect(count(large.node)).toBe(100);
    expect(large.truncated).toBe(true);
  });

  test("marks truncation only when a node was actually omitted", () => {
    const root = { node: Array.from({ length: 99 }, () => ({ $: { text: "leaf" } })) };
    expect(buildIosLayoutTelemetryTree(root).truncated).toBe(false);
    root.node.push({ $: { text: "omitted" } });
    expect(buildIosLayoutTelemetryTree(root).truncated).toBe(true);
  });

  test("hashes structure, package and window count, ignoring omitted capture fields", () => {
    const first = buildIosLayoutTelemetryTree({ $: { text: "a", bounds: "old" } });
    const same = buildIosLayoutTelemetryTree({ $: { bounds: "new", text: "a" } });
    const different = buildIosLayoutTelemetryTree({ $: { text: "b" } });
    const key = hashIosLayoutTelemetryTree(first.node, "app", 1);
    expect(hashIosLayoutTelemetryTree(same.node, "app", 1)).toBe(key);
    expect(hashIosLayoutTelemetryTree(different.node, "app", 1)).not.toBe(key);
    expect(hashIosLayoutTelemetryTree(first.node, "other", 1)).not.toBe(key);
    expect(hashIosLayoutTelemetryTree(first.node, "app", 2)).not.toBe(key);
  });
});
