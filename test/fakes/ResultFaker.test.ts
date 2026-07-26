import { describe, expect, test } from "bun:test";
import { ResultFaker } from "./ResultFaker";

describe("ResultFaker.elementBounds", () => {
  test("never generates an inverted rectangle across many seeds", () => {
    // Before the fix ~65% of drawn rects had right < left (or bottom < top).
    for (let seed = 0; seed < 300; seed += 1) {
      ResultFaker.setSeed(seed);
      const bounds = ResultFaker.elementBounds();
      expect(bounds.right).toBeGreaterThanOrEqual(bounds.left);
      expect(bounds.bottom).toBeGreaterThanOrEqual(bounds.top);
    }
  });

  test("the geometric centre lies inside the generated bounds (seed 3)", () => {
    // Seed 3 produced an inverted rect before the fix, so its centre fell
    // outside the box — a concrete garbage value any geometry consumer inherits.
    ResultFaker.setSeed(3);
    const bounds = ResultFaker.elementBounds();
    const centreX = (bounds.left + bounds.right) / 2;
    const centreY = (bounds.top + bounds.bottom) / 2;

    expect(centreX).toBeGreaterThanOrEqual(bounds.left);
    expect(centreX).toBeLessThanOrEqual(bounds.right);
    expect(centreY).toBeGreaterThanOrEqual(bounds.top);
    expect(centreY).toBeLessThanOrEqual(bounds.bottom);
  });

  test("passes explicit overrides through unchanged", () => {
    const bounds = ResultFaker.elementBounds({ left: 10, top: 20, right: 100, bottom: 200 });

    expect(bounds).toEqual({ left: 10, top: 20, right: 100, bottom: 200 });
  });
});

// Ported from the never-executed ResultFakerTest.ts (it did not match *.test.ts,
// so bun never ran it): the activeWindowInfo format and override cases carry
// real value and now actually run.
describe("ResultFaker.activeWindowInfo", () => {
  test("produces a well-formed, capitalized activity name", () => {
    const info = ResultFaker.activeWindowInfo();

    expect(info.appId).toBeTypeOf("string");
    expect(info.activityName).toMatch(/^com\..*\.activities\.[A-Z].*Activity$/);
  });

  test("respects appId and activityName overrides", () => {
    const info = ResultFaker.activeWindowInfo({
      appId: "com.custom.package",
      activityName: "com.custom.package.CustomActivity",
    });

    expect(info.appId).toBe("com.custom.package");
    expect(info.activityName).toBe("com.custom.package.CustomActivity");
  });
});
