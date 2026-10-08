import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlanValidator } from "../../../src/utils/plan/PlanValidator";
import type { Plan } from "../../../src/models/Plan";

// criticalSection lock consistency and barrier per-step params. The cases live in a
// shared fixture that the Kotlin TestPlanValidator (CoordinationParamsParityTest) also
// consumes, so both validators must reach the same verdict and the same messages.

interface ParamsCase {
  name: string;
  plan: Plan;
  expected: { valid: true } | { valid: false; message: string };
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "../../fixtures/plan-coordination-params/cases.json"), "utf8"),
) as { cases: ParamsCase[] };

function validationMessage(plan: Plan): string | null {
  try {
    PlanValidator.validate(plan);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("PlanValidator criticalSection lock and barrier params (shared fixture)", () => {
  test("the shared fixture covers both verdicts", () => {
    expect(fixture.cases.some((c) => c.expected.valid)).toBe(true);
    expect(fixture.cases.some((c) => !c.expected.valid)).toBe(true);
  });

  for (const { name, plan, expected } of fixture.cases) {
    test(name, () => {
      expect(validationMessage(plan)).toBe(expected.valid ? null : expected.message);
    });
  }
});
