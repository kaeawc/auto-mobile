import { describe, expect, test } from "bun:test";
import {
  matchesCtrlProxyNodeSelector,
  matchesCtrlProxyResourceId,
} from "../../../src/features/utility/SearchableNode";

describe("matchesCtrlProxyResourceId", () => {
  test.each([
    ["com.example:id/save", "com.example:id/save", true],
    ["com.example:id/save", "save", true],
    ["com.example:id/save_button", "save", false],
    ["com.example:id/xsave", "save", false],
    ["save", "save", true],
    ["com.example:id/save", "other:id/save", false],
  ])("%p against %p -> %p", (nativeId, resourceId, expected) => {
    expect(matchesCtrlProxyResourceId(nativeId, resourceId)).toBe(expected);
  });

  test("a missing or non-string id never matches", () => {
    expect(matchesCtrlProxyResourceId(undefined, "save")).toBe(false);
    expect(matchesCtrlProxyResourceId(42, "save")).toBe(false);
  });
});

describe("matchesCtrlProxyNodeSelector", () => {
  const properties = {
    "resource-id": "com.example:id/cell",
    "test-tag": "grid-cell",
    "unique-id": "u-7",
    "collection-row-index": 2,
    "collection-column-index": 3,
  };

  test("requires every populated field to agree", () => {
    expect(
      matchesCtrlProxyNodeSelector(properties, {
        resourceId: "cell",
        testTag: "grid-cell",
        uniqueId: "u-7",
        collectionRow: 2,
        collectionColumn: 3,
      }),
    ).toBe(true);
    expect(matchesCtrlProxyNodeSelector(properties, { resourceId: "cell", collectionRow: 1 })).toBe(
      false,
    );
    expect(matchesCtrlProxyNodeSelector(properties, { testTag: "other" })).toBe(false);
    expect(matchesCtrlProxyNodeSelector(properties, { uniqueId: "u-8" })).toBe(false);
    expect(matchesCtrlProxyNodeSelector(properties, { collectionColumn: 0 })).toBe(false);
  });

  test("an empty selector matches any node, as CtrlProxy's first-node lookup does", () => {
    expect(matchesCtrlProxyNodeSelector({}, {})).toBe(true);
  });

  test("a resource-id selector does not match a node without an id", () => {
    expect(matchesCtrlProxyNodeSelector({ "test-tag": "grid-cell" }, { resourceId: "cell" })).toBe(
      false,
    );
  });
});
