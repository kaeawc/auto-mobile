import { describe, expect, test } from "bun:test";
import {
  rawContentDesc,
  rawNodeString,
  rawNodeValue,
  rawResourceId,
  rawText,
} from "../../../src/features/utility/elementProperties";

describe("raw node accessors", () => {
  test("rawResourceId prefers resource-id, then resourceId, then extra keys, else empty", () => {
    expect(rawResourceId({ "resource-id": "a", resourceId: "b" })).toBe("a");
    expect(rawResourceId({ resourceId: "b" })).toBe("b");
    expect(rawResourceId({ identifier: "c" }, ["identifier"])).toBe("c");
    expect(rawResourceId({ identifier: "c" })).toBe("");
    expect(rawResourceId(undefined)).toBe("");
    expect(rawResourceId(null)).toBe("");
  });

  test("an empty string is a present value, only null and undefined fall through (?? semantics)", () => {
    expect(rawResourceId({ "resource-id": "", resourceId: "b" })).toBe("");
    expect(rawResourceId({ "resource-id": null, resourceId: "b" })).toBe("b");
  });

  test("rawContentDesc and rawText read their own fields and stringify non-strings", () => {
    expect(rawContentDesc({ contentDesc: "x" })).toBe("x");
    expect(rawContentDesc({ "content-desc": 5, contentDesc: "x" })).toBe("5");
    expect(rawText({ text: "t" })).toBe("t");
    expect(rawText({})).toBe("");
  });

  test("rawNodeString takes the first present key; rawNodeValue returns the unconverted value", () => {
    expect(rawNodeString({ b: "2" }, ["a", "b"])).toBe("2");
    expect(rawNodeValue({ text: 3 }, "text")).toBe(3);
    expect(rawNodeValue(undefined, "content-desc")).toBeUndefined();
  });
});
