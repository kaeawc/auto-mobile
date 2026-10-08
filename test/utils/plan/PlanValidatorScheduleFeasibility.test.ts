import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PlanValidator } from "../../../src/utils/plan/PlanValidator";
import {
  findUnavoidableCoordinationDeadlock,
  splitIndependentComponents,
  type CoordinationTrack,
} from "../../../src/utils/plan/CoordinationScheduleFeasibility";
import type { Plan } from "../../../src/models/Plan";

// Issue #6231: static scheduling feasibility for multi-lock barrier plans.
//
// The plan-level cases live in a shared fixture that the Kotlin
// TestPlanValidator (CoordinationScheduleFeasibilityTest) also consumes, so both
// validators must reach the same verdict and the same exact message.

interface FeasibilityCase {
  name: string;
  plan: Plan;
  expected: { valid: true } | { valid: false; message: string };
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../fixtures/plan-schedule-feasibility/cases.json"),
    "utf8",
  ),
) as { cases: FeasibilityCase[] };

function validationMessage(plan: Plan): string | null {
  try {
    PlanValidator.validate(plan);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("PlanValidator coordination schedule feasibility (shared fixture)", () => {
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

describe("PlanValidator coordination schedule feasibility", () => {
  describe("findUnavoidableCoordinationDeadlock", () => {
    const ev = (lock: string, stepIndex: number) => ({
      tool: "barrier",
      lock,
      deviceCount: 2,
      stepIndex,
    });
    const abba: CoordinationTrack[] = [
      { device: "A", events: [ev("X", 0), ev("Y", 1)] },
      { device: "B", events: [ev("Y", 2), ev("X", 3)] },
    ];

    test("returns null (unknown, accept) when the state budget is exhausted", () => {
      expect(findUnavoidableCoordinationDeadlock(abba, 1)).toBeNull();
    });

    test("reports the stalled devices for an unavoidable deadlock", () => {
      const deadlock = findUnavoidableCoordinationDeadlock(abba);
      expect(deadlock?.stalled.map((s) => [s.device, s.event.lock])).toEqual([
        ["A", "X"],
        ["B", "Y"],
      ]);
      expect(deadlock?.finished).toEqual([]);
    });

    test("splitIndependentComponents groups tracks that share a lock", () => {
      const tracks: CoordinationTrack[] = [
        ...abba,
        { device: "C", events: [ev("Z", 4)] },
        { device: "D", events: [ev("Z", 5), ev("W", 6)] },
        { device: "E", events: [ev("W", 7)] },
      ];
      const components = splitIndependentComponents(tracks);
      expect(components.map((c) => c.map((t) => t.device).sort())).toEqual([
        ["A", "B"],
        ["C", "D", "E"],
      ]);
    });

    test("skips only the component containing an unmodeled event", () => {
      const tainted: CoordinationTrack[] = [
        { device: "A", events: [{ ...ev("X", 0), unmodeled: true }, ev("Y", 1)] },
        { device: "B", events: [ev("Y", 2), ev("X", 3)] },
      ];
      expect(findUnavoidableCoordinationDeadlock(tainted)).toBeNull();
      const independent: CoordinationTrack[] = [
        { device: "C", events: [{ ...ev("Z", 4), unmodeled: true }] },
        { device: "D", events: [ev("Z", 5)] },
        ...abba,
      ];
      const deadlock = findUnavoidableCoordinationDeadlock(independent);
      expect(deadlock?.stalled.map((s) => s.device)).toEqual(["A", "B"]);
    });

    test("returns null when there are no coordination events", () => {
      expect(findUnavoidableCoordinationDeadlock([{ device: "A", events: [] }])).toBeNull();
    });
  });
});
