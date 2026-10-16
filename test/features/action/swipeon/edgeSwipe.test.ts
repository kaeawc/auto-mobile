import { describe, expect, test } from "bun:test";
import {
  EDGE_INSET_DEFAULT,
  EDGE_INSET_MAX,
  edgeSwipeCoordinates,
  validateEdgeSwipeOptions,
} from "../../../../src/features/action/swipeon/edgeSwipe";

const screen = { left: 0, top: 0, right: 1000, bottom: 2000 };
const panel = { left: 100, top: 200, right: 600, bottom: 1200 };

describe("edgeSwipeCoordinates (#12537)", () => {
  test("left edge starts a default inset inside, centered, and travels inward", () => {
    expect(edgeSwipeCoordinates({ edge: "left", bounds: screen })).toEqual({
      x1: EDGE_INSET_DEFAULT,
      y1: 1000,
      x2: EDGE_INSET_DEFAULT + 700,
      y2: 1000,
    });
  });

  test("right edge uses the last pixel column minus the inset", () => {
    expect(edgeSwipeCoordinates({ edge: "right", bounds: screen, inset: 0 })).toEqual({
      x1: 999,
      y1: 1000,
      x2: 299,
      y2: 1000,
    });
  });

  test("top and bottom edges follow `at` along the edge", () => {
    expect(edgeSwipeCoordinates({ edge: "top", bounds: screen, at: 0.25, inset: 10 })).toEqual({
      x1: 250,
      y1: 10,
      x2: 250,
      y2: 10 + 1400,
    });
    expect(edgeSwipeCoordinates({ edge: "bottom", bounds: screen, at: 1, inset: 10 })).toEqual({
      x1: 999,
      y1: 2000 - 1 - 10,
      x2: 999,
      y2: 2000 - 1 - 10 - 1400,
    });
  });

  test("a panel's own edges are used, not the physical screen's", () => {
    expect(edgeSwipeCoordinates({ edge: "left", bounds: panel, at: 0 })).toEqual({
      x1: 100 + EDGE_INSET_DEFAULT,
      y1: 200,
      x2: 100 + EDGE_INSET_DEFAULT + 350,
      y2: 200,
    });
    expect(edgeSwipeCoordinates({ edge: "bottom", bounds: panel }).y1).toBe(
      1199 - EDGE_INSET_DEFAULT,
    );
  });

  test("content-edge bounds (system insets excluded) move the start inward", () => {
    const content = { left: 0, top: 100, right: 1000, bottom: 1900 };
    expect(edgeSwipeCoordinates({ edge: "top", bounds: content, inset: 0 }).y1).toBe(100);
  });
});

describe("validateEdgeSwipeOptions", () => {
  test("no edge option means no constraint; stray edge fields are rejected", () => {
    expect(validateEdgeSwipeOptions({ direction: "up" })).toBeNull();
    expect(validateEdgeSwipeOptions({ direction: "up", at: 0.5 })).toContain("require fromEdge");
    expect(validateEdgeSwipeOptions({ direction: "up", edgeInset: 3 })).toContain(
      "require fromEdge",
    );
  });

  test("direction must point inward", () => {
    expect(validateEdgeSwipeOptions({ fromEdge: "left", direction: "right" })).toBeNull();
    expect(validateEdgeSwipeOptions({ fromEdge: "left", direction: "left" })).toContain('"right"');
    expect(validateEdgeSwipeOptions({ fromEdge: "bottom", direction: "up" })).toBeNull();
    expect(validateEdgeSwipeOptions({ fromEdge: "top", direction: "up" })).toContain('"down"');
  });

  test("rejects range violations and container/lookFor/autoTarget combinations", () => {
    const base = { fromEdge: "left", direction: "right" } as const;
    expect(validateEdgeSwipeOptions({ ...base, edgeInset: EDGE_INSET_MAX + 1 })).toContain(
      "edgeInset",
    );
    expect(validateEdgeSwipeOptions({ ...base, edgeInset: -1 })).toContain("edgeInset");
    expect(validateEdgeSwipeOptions({ ...base, edgeInset: 1.5 })).toContain("edgeInset");
    expect(validateEdgeSwipeOptions({ ...base, at: 1.1 })).toContain("at must");
    expect(validateEdgeSwipeOptions({ ...base, at: Number.NaN })).toContain("at must");
    expect(validateEdgeSwipeOptions({ ...base, container: { text: "x" } })).toContain(
      "cannot be combined",
    );
    expect(validateEdgeSwipeOptions({ ...base, lookFor: { text: "x" } })).toContain(
      "cannot be combined",
    );
    expect(validateEdgeSwipeOptions({ ...base, autoTarget: true })).toContain("cannot be combined");
    expect(
      validateEdgeSwipeOptions({ ...base, autoTarget: false, edgeInset: 8, at: 0 }),
    ).toBeNull();
  });
});
