import { describe, expect, test } from "bun:test";
import {
  buildIosLayoutTelemetryTree,
  hashIosLayoutTelemetryTree,
} from "../../../../src/features/observe/ios/IosLayoutTelemetryTree";
import { goldenLayoutHierarchy, largeLayoutHierarchy } from "./iosLayoutTelemetryFixture";
import type { ViewHierarchyNode } from "../../../../src/models";

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
    const first = { $: { text: "a", bounds: "old" } };
    const same = { $: { bounds: "new", text: "a" } };
    const different = { $: { text: "b" } };
    const key = hashIosLayoutTelemetryTree(first, "app", 1, 1);
    expect(hashIosLayoutTelemetryTree(same, "app", 1, 1)).toBe(key);
    expect(hashIosLayoutTelemetryTree(different, "app", 1, 1)).not.toBe(key);
    expect(hashIosLayoutTelemetryTree(first, "other", 1, 1)).not.toBe(key);
    expect(hashIosLayoutTelemetryTree(first, "app", 2, 1)).not.toBe(key);
  });

  test("includes the full node count in the fingerprint", () => {
    const root = { $: { text: "a" } };
    expect(hashIosLayoutTelemetryTree(root, "app", 1, 1)).not.toBe(
      hashIosLayoutTelemetryTree(root, "app", 1, 2),
    );
  });

  test("fingerprints omitted nodes while retaining the compact payload cap", () => {
    const root = { node: Array.from({ length: 100 }, () => ({ $: { text: "leaf" } })) };
    const compact = buildIosLayoutTelemetryTree(root);
    const key = hashIosLayoutTelemetryTree(root, "app", 1, 101);
    root.node[99].$.text = "changed";
    expect(buildIosLayoutTelemetryTree(root)).toEqual(compact);
    expect(hashIosLayoutTelemetryTree(root, "app", 1, 101)).not.toBe(key);
  });

  test("uses the same projection beyond the cutoff and normalizes wire child objects", () => {
    const root = {
      node: Array.from({ length: 100 }, () => ({ $: { text: "leaf", bounds: "old" } })),
    };
    const key = hashIosLayoutTelemetryTree(root, "app", 1, 101);
    root.node[99].$.bounds = "new";
    expect(hashIosLayoutTelemetryTree(root, "app", 1, 101)).toBe(key);
    const wire: ViewHierarchyNode = JSON.parse('{"node":{"$":{"text":"leaf"}}}');
    expect(hashIosLayoutTelemetryTree(wire, "app", 1, 2)).toBe(
      hashIosLayoutTelemetryTree({ node: [{ $: { text: "leaf" } }] }, "app", 1, 2),
    );
  });

  test("distinguishes nesting and child order with equal node counts", () => {
    const a = { $: { text: "a" } };
    const b = { $: { text: "b" } };
    const key = hashIosLayoutTelemetryTree({ node: [a, b] }, "app", 1, 3);
    expect(hashIosLayoutTelemetryTree({ node: [b, a] }, "app", 1, 3)).not.toBe(key);
    expect(hashIosLayoutTelemetryTree({ node: [{ ...a, node: [b] }] }, "app", 1, 3)).not.toBe(key);
  });
});
