import { describe, expect, test } from "bun:test";
import { MAX_PLAN_NESTING_DEPTH, nextPlanNestingDepth } from "../../../src/utils/plan/planNesting";

describe("nextPlanNestingDepth", () => {
  test("the outermost plan is level 1 and each nested plan adds one", () => {
    expect(nextPlanNestingDepth(undefined)).toBe(1);
    expect(nextPlanNestingDepth(1)).toBe(2);
    expect(nextPlanNestingDepth(MAX_PLAN_NESTING_DEPTH - 1)).toBe(MAX_PLAN_NESTING_DEPTH);
  });

  test("a plan past the limit is refused with an actionable message", () => {
    expect(() => nextPlanNestingDepth(MAX_PLAN_NESTING_DEPTH)).toThrow(
      `nested more than ${MAX_PLAN_NESTING_DEPTH} plans deep`,
    );
  });
});
