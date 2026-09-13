import { describe, expect, test } from "bun:test";
import {
  MAX_FILTERED_CHILDREN_PER_NODE,
  ViewHierarchy,
} from "../../../src/features/observe/ViewHierarchy";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";

const device = {
  name: "test-device",
  platform: "android",
  deviceId: "emulator-5554",
} as any;

describe("ViewHierarchy filtering", () => {
  test("preserves action-only interactive nodes", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const result = viewHierarchy.filterViewHierarchy({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              "resource-id": "com.example:id/icon_button",
              "view-id": "com.example:id/icon_button",
              bounds: { left: 900, top: 1700, right: 1020, bottom: 1820 },
              actions: ["click"],
            },
            {
              bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            },
          ],
        },
      },
    });

    expect(result.hierarchy.node).toEqual({
      "resource-id": "com.example:id/icon_button",
      "view-id": "com.example:id/icon_button",
      bounds: { left: 900, top: 1700, right: 1020, bottom: 1820 },
      actions: ["click"],
    });
  });

  test("preserves occlusion metadata when filtering retained nodes", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const result = viewHierarchy.filterViewHierarchy({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              "resource-id": "com.example:id/title",
              "view-id": "com.example:id/title",
              bounds: { left: 0, top: 100, right: 800, bottom: 180 },
              occlusionState: "partial",
              occludedBy: "unlabeled view",
              occludedByViewId: "stable-occluder",
            },
          ],
        },
      },
    });

    expect(result.hierarchy.node).toEqual({
      "resource-id": "com.example:id/title",
      "view-id": "com.example:id/title",
      bounds: { left: 0, top: 100, right: 800, bottom: 180 },
      occlusionState: "partial",
      occludedBy: "unlabeled view",
      occludedByViewId: "stable-occluder",
    });
  });

  test("filters a cloned hierarchy without mutating the source", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const source = {
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          node: [
            {
              text: "Keep me",
              bounds: { left: 10, top: 10, right: 100, bottom: 80 },
            },
            {
              bounds: { left: 0, top: 0, right: 10, bottom: 10 },
            },
          ],
        },
      },
    };
    const originalChildren = source.hierarchy.node.node;

    const result = viewHierarchy.filterViewHierarchy(source);

    expect(result).not.toBe(source);
    expect(result.hierarchy).not.toBe(source.hierarchy);
    expect(result.hierarchy.node).toEqual({
      text: "Keep me",
      bounds: { left: 10, top: 10, right: 100, bottom: 80 },
    });
    expect(source.hierarchy.node.node).toBe(originalChildren);
    expect(source.hierarchy.node.node).toHaveLength(2);
  });

  test("drops all root children when none meet the filter criteria", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const child = { class: "android.widget.FrameLayout", enabled: "true" };
    const root = { node: [child] };

    expect(viewHierarchy.meetsFilterCriteria(child)).toBe(false);

    const result = viewHierarchy.filterSingleNode(root, true);

    expect(result.node).toEqual([]);
  });

  test("keeps only surviving root children when some meet the filter criteria", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const root = {
      node: [{ class: "android.widget.FrameLayout", enabled: "true" }, { text: "Keep me" }],
    };

    const result = viewHierarchy.filterSingleNode(root, true);

    expect(result.node).toEqual({ text: "Keep me" });
  });

  test("leaves a root node without children unchanged", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const root = { class: "android.widget.FrameLayout", enabled: "true" };

    const result = viewHierarchy.filterSingleNode(root, true);

    expect(result).toEqual({ class: "android.widget.FrameLayout", enabled: "true" });
  });

  test("reports a truncation reason when a node has more children than the cap", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const total = 70;
    const children = Array.from({ length: total }, (_, index) => ({
      "resource-id": `com.example:id/row_${index}`,
      text: `Row ${index}`,
    }));
    const result = viewHierarchy.filterViewHierarchy({
      hierarchy: {
        node: {
          "resource-id": "com.example:id/list",
          scrollable: "true",
          node: children,
        },
      },
    });

    expect(result.hierarchy.node.node).toHaveLength(MAX_FILTERED_CHILDREN_PER_NODE);
    expect(result.truncationReasons).toEqual([
      `max_children[com.example:id/list kept ${MAX_FILTERED_CHILDREN_PER_NODE} of ${total}]`,
    ]);
  });

  test("does not report truncation when the child count is exactly the cap", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const children = Array.from({ length: MAX_FILTERED_CHILDREN_PER_NODE }, (_, index) => ({
      "resource-id": `com.example:id/row_${index}`,
    }));
    const result = viewHierarchy.filterViewHierarchy({
      hierarchy: { node: { "resource-id": "com.example:id/list", node: children } },
    });

    expect(result.hierarchy.node.node).toHaveLength(MAX_FILTERED_CHILDREN_PER_NODE);
    expect(result.truncationReasons).toBeUndefined();
  });

  test("appends child truncation to pre-existing truncation reasons", () => {
    const viewHierarchy = new ViewHierarchy(device, new FakeAdbClientFactory());
    const children = Array.from({ length: 65 }, () => ({ text: "row" }));
    const result = viewHierarchy.filterViewHierarchy({
      truncationReasons: ["max_nodes"],
      hierarchy: { node: { class: "android.widget.GridView", node: children } },
    });

    expect(result.truncationReasons).toEqual([
      "max_nodes",
      `max_children[android.widget.GridView kept ${MAX_FILTERED_CHILDREN_PER_NODE} of 65]`,
    ]);
  });
});
