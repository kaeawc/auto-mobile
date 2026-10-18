import { describe, expect, test } from "bun:test";
import { staleSyntheticTarget } from "../../../src/features/action/tapHierarchyRefreshPhase";
import type { Element, ViewHierarchyResult } from "../../../src/models";

const hierarchy = {
  hierarchy: { node: { "resource-id": "x", bounds: "[0,0][10,10]" } },
} as never as ViewHierarchyResult;

describe("staleSyntheticTarget", () => {
  test("ignores targets that carry a resource id", () => {
    const el = { "resource-id": "id", "view-id": "v1" } as never as Element;
    expect(staleSyntheticTarget(el, hierarchy, hierarchy)).toBeUndefined();
  });

  test("ignores targets without a view-id or a previous hierarchy", () => {
    expect(staleSyntheticTarget(null, hierarchy, hierarchy)).toBeUndefined();
    expect(staleSyntheticTarget({} as Element, hierarchy, hierarchy)).toBeUndefined();
    expect(
      staleSyntheticTarget({ "view-id": "v1" } as never as Element, undefined, hierarchy),
    ).toBeUndefined();
  });

  test("reports a reference that is no longer identifiable in the previous hierarchy", () => {
    const el = { "view-id": "missing" } as never as Element;
    expect(staleSyntheticTarget(el, hierarchy, hierarchy)).toBe(
      "Stale tap target: the observed reference is no longer identifiable.",
    );
  });
});
