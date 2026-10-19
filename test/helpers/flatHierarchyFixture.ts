import type { ViewHierarchyResult } from "../../src/models";
import {
  createFlatNodeForTest,
  type FlatHierarchyNode,
} from "../features/observe/flatHierarchyBuilders";
import { viewHierarchyFromFixture } from "./observeFixture";

/** Convert legacy capture roots, children and numeric bounds to the typed flat-node shape. */
export function flatNodeFromFixture(value: unknown): FlatHierarchyNode {
  if (Array.isArray(value)) {
    return createFlatNodeForTest({ node: value.map(flatNodeFromFixture) });
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected captured node");
  }
  const attributes = Object.fromEntries(Object.entries(value));
  const { node, bounds, ...rest } = attributes;
  const children =
    node === undefined
      ? {}
      : { node: (Array.isArray(node) ? node : [node]).map(flatNodeFromFixture) };
  if (bounds === undefined) {
    return createFlatNodeForTest({ ...rest, ...children });
  }
  if (Array.isArray(bounds)) {
    const [left, top, right, bottom] = bounds;
    if (
      bounds.length === 4 &&
      typeof left === "number" &&
      typeof top === "number" &&
      typeof right === "number" &&
      typeof bottom === "number"
    ) {
      return createFlatNodeForTest({ ...rest, ...children, bounds: { left, top, right, bottom } });
    }
  } else if (
    typeof bounds === "object" &&
    bounds !== null &&
    "left" in bounds &&
    "top" in bounds &&
    "right" in bounds &&
    "bottom" in bounds &&
    typeof bounds.left === "number" &&
    typeof bounds.top === "number" &&
    typeof bounds.right === "number" &&
    typeof bounds.bottom === "number"
  ) {
    return createFlatNodeForTest({
      ...rest,
      ...children,
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    });
  }
  throw new Error("Expected captured numeric bounds");
}

export function flatHierarchyFromFixture(value: unknown): ViewHierarchyResult {
  const capture = viewHierarchyFromFixture(value);
  return {
    ...capture,
    hierarchy: {
      ...capture.hierarchy,
      ...(capture.hierarchy.node === undefined
        ? {}
        : { node: flatNodeFromFixture(capture.hierarchy.node) }),
    },
  };
}
