import { describe, expect, it } from "bun:test";
import { boundsEqual, boundsNearlyEqual } from "../../src/utils/bounds";

describe("boundsNearlyEqual", () => {
  it("returns true for identical bounds at epsilon 0", () => {
    const b = { left: 1, top: 2, right: 10, bottom: 20 };
    expect(boundsNearlyEqual(b, b, 0)).toBe(true);
    expect(boundsEqual(b, b)).toBe(true);
  });

  it("returns true within epsilon inclusive", () => {
    const a = { left: 0, top: 0, right: 100, bottom: 50 };
    const b = { left: 2, top: 2, right: 98, bottom: 48 };
    expect(boundsNearlyEqual(a, b, 3)).toBe(true);
    expect(boundsNearlyEqual(a, b, 1)).toBe(false);
  });
});
