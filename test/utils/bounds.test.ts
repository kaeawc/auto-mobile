import { describe, expect, it } from "bun:test";
import {
  boundsArea,
  boundsEqual,
  boundsNearlyEqual,
  clamp,
  isElementBounds,
  parseBounds,
  parseBoundsString,
} from "../../src/utils/bounds";

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

describe("clamp", () => {
  it("returns the value when it is within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps a value below the minimum up to the minimum", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps a value above the maximum down to the maximum", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });

  it("returns the boundary value exactly at the minimum", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  it("returns the boundary value exactly at the maximum", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("returns the minimum for NaN rather than propagating NaN", () => {
    expect(clamp(NaN, 3, 10)).toBe(3);
  });

  it("clamps negative infinity to the minimum", () => {
    expect(clamp(-Infinity, 0, 10)).toBe(0);
  });

  it("clamps positive infinity to the maximum", () => {
    expect(clamp(Infinity, 0, 10)).toBe(10);
  });
});

describe("boundsArea", () => {
  it("computes width times height for a positive rectangle", () => {
    expect(boundsArea({ left: 0, top: 0, right: 10, bottom: 5 })).toBe(50);
  });

  it("returns 0 for a zero-width rectangle", () => {
    expect(boundsArea({ left: 5, top: 0, right: 5, bottom: 10 })).toBe(0);
  });

  it("returns 0 when right is left of left (negative width clamped)", () => {
    expect(boundsArea({ left: 10, top: 0, right: 4, bottom: 10 })).toBe(0);
  });

  it("returns 0 when bottom is above top (negative height clamped)", () => {
    expect(boundsArea({ left: 0, top: 10, right: 10, bottom: 4 })).toBe(0);
  });

  it("returns 0 when both dimensions are inverted", () => {
    expect(boundsArea({ left: 10, top: 10, right: 0, bottom: 0 })).toBe(0);
  });
});

describe("isElementBounds", () => {
  it("accepts a fully-populated numeric bounds object", () => {
    expect(isElementBounds({ left: 0, top: 0, right: 1, bottom: 1 })).toBe(true);
  });

  it("rejects null", () => {
    expect(isElementBounds(null)).toBe(false);
  });

  it("rejects an array", () => {
    expect(isElementBounds([0, 0, 1, 1])).toBe(false);
  });

  it("rejects an object with a non-numeric edge", () => {
    expect(isElementBounds({ left: 0, top: 0, right: 1, bottom: "1" })).toBe(false);
  });
});

describe("parseBoundsString / parseBounds", () => {
  it("parses the Android [l,t][r,b] format", () => {
    expect(parseBoundsString("[1,2][30,40]")).toEqual({ left: 1, top: 2, right: 30, bottom: 40 });
  });

  it("parses negative coordinates", () => {
    expect(parseBoundsString("[-5,-6][7,8]")).toEqual({ left: -5, top: -6, right: 7, bottom: 8 });
  });

  it("returns null for a malformed bounds string", () => {
    expect(parseBoundsString("not-bounds")).toBeNull();
  });

  it("passes an already-valid bounds object through unchanged", () => {
    const b = { left: 1, top: 2, right: 3, bottom: 4 };
    expect(parseBounds(b)).toEqual(b);
  });

  it("returns null for an unparseable value", () => {
    expect(parseBounds(12345)).toBeNull();
  });
});
