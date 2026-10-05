import { androidEnabledObservation } from "../helpers/androidEnabledCapture";
import { describe, expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { hashHierarchyForSettle } from "../../src/server/observeTools";
import {
  loadAndroidHomeObserve,
  loadIosRemindersNoiseObservePair,
} from "../fixtures/observe/observeFixture";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function findNode(
  value: unknown,
  predicate: (node: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findNode(child, predicate);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  const current = record(value);
  if (!current) {
    return undefined;
  }
  if (predicate(current)) {
    return current;
  }
  const children = current.node;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findNode(child, predicate);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function withChangedNode(
  hierarchy: ViewHierarchyResult,
  predicate: (node: Record<string, unknown>) => boolean,
  change: (node: Record<string, unknown>) => void,
): ViewHierarchyResult {
  const copy = JSON.parse(JSON.stringify(hierarchy)) as ViewHierarchyResult;
  const node = findNode(copy.hierarchy.node, predicate);
  if (!node) {
    throw new Error("Expected matching node in captured hierarchy fixture");
  }
  change(node);
  return copy;
}

describe("hashHierarchyForSettle", () => {
  const fixtureHierarchy = loadAndroidHomeObserve().observe.viewHierarchy;
  if (!fixtureHierarchy) {
    throw new Error("Expected view hierarchy in captured Android fixture");
  }

  test("ignores extras and occlusion metadata", () => {
    const changed = withChangedNode(
      fixtureHierarchy,
      (node) => node["occlusionState"] !== undefined,
      (node) => {
        node["extras"] = { capture: "changed" };
        node["occlusionState"] = "visible";
        node["occludedBy"] = "different overlay";
        node["occludedByViewId"] = "different-id";
      },
    );

    expect(hashHierarchyForSettle(changed)).toBe(hashHierarchyForSettle(fixtureHierarchy));
  });

  test("changes when visible text or bounds change", () => {
    const textChanged = withChangedNode(
      fixtureHierarchy,
      (node) => typeof node.text === "string",
      (node) => {
        node.text = `${String(node.text)} changed`;
      },
    );
    const boundsChanged = withChangedNode(
      fixtureHierarchy,
      (node) => record(node.bounds) !== undefined,
      (node) => {
        const bounds = record(node.bounds);
        if (!bounds) {
          throw new Error("Expected bounds on captured fixture node");
        }
        bounds.right = Number(bounds.right) + 1;
      },
    );

    expect(hashHierarchyForSettle(textChanged)).not.toBe(hashHierarchyForSettle(fixtureHierarchy));
    expect(hashHierarchyForSettle(boundsChanged)).not.toBe(
      hashHierarchyForSettle(fixtureHierarchy),
    );
  });

  test("changes when an iOS value attribute changes", () => {
    const iosHierarchy = loadIosRemindersNoiseObservePair().after.viewHierarchy;
    if (!iosHierarchy) {
      throw new Error("Expected view hierarchy in captured iOS fixture");
    }
    const valueChanged = withChangedNode(
      iosHierarchy,
      (node) => typeof node.value === "string",
      (node) => {
        node.value = `${String(node.value)} changed`;
      },
    );

    expect(hashHierarchyForSettle(valueChanged)).not.toBe(hashHierarchyForSettle(iosHierarchy));
  });
});

test("settle hash sees an enabled-only flip after captured Android conversion", () => {
  const enabled = androidEnabledObservation();
  const disabled = androidEnabledObservation("false");
  expect(hashHierarchyForSettle(enabled.viewHierarchy)).not.toBeNull();
  expect(hashHierarchyForSettle(disabled.viewHierarchy)).not.toBe(
    hashHierarchyForSettle(enabled.viewHierarchy),
  );
});
