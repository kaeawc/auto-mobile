import { describe, expect, test } from "bun:test";
import { PlanValidator } from "../../../src/utils/plan/PlanValidator";
import {
  findUnavoidableCoordinationDeadlock,
  type CoordinationTrack,
} from "../../../src/utils/plan/CoordinationScheduleFeasibility";
import type { Plan, PlanStep } from "../../../src/models/Plan";

// Issue #6231: static scheduling feasibility for multi-lock barrier plans.

function barrier(device: string, lock: string, deviceCount = 2): PlanStep {
  return { tool: "barrier", params: { device, lock, deviceCount } };
}

function critical(device: string, lock: string, deviceCount = 2): PlanStep {
  return {
    tool: "criticalSection",
    params: { device, lock, deviceCount, steps: [{ tool: "tapOn", params: { device } }] },
  };
}

function tap(device: string): PlanStep {
  return { tool: "tapOn", params: { device, text: "Next" } };
}

function plan(devices: string[], steps: PlanStep[]): Plan {
  return { name: "Feasibility", devices, steps };
}

describe("PlanValidator coordination schedule feasibility", () => {
  describe("rejects plans no arrival order can complete", () => {
    test("AB-BA cross-lock cycle between two barrier locks", () => {
      const p = plan(
        ["A", "B"],
        [barrier("A", "X"), barrier("A", "Y"), barrier("B", "Y"), barrier("B", "X")],
      );
      let message = "";
      try {
        PlanValidator.validate(p);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("coordination can never complete");
      expect(message).toContain('device "A" waits at barrier lock "X" (step 0; 1/2 arrived: A)');
      expect(message).toContain('device "B" waits at barrier lock "Y" (step 2; 1/2 arrived: B)');
      expect(message).toContain('Locks involved: "X", "Y"');
      expect(message).toContain("Generations released before the stall: none");
    });

    test("three-device cycle X -> Y -> Z", () => {
      const p = plan(
        ["A", "B", "C"],
        [
          barrier("A", "X"),
          barrier("A", "Y"),
          barrier("B", "Y"),
          barrier("B", "Z"),
          barrier("C", "Z"),
          barrier("C", "X"),
        ],
      );
      expect(() => PlanValidator.validate(p)).toThrow("coordination can never complete");
    });

    test("cycle that only forms after an earlier shared generation completes", () => {
      const p = plan(
        ["A", "B"],
        [
          barrier("A", "start"),
          barrier("B", "start"),
          tap("A"),
          barrier("A", "X"),
          barrier("A", "Y"),
          barrier("B", "Y"),
          barrier("B", "X"),
        ],
      );
      expect(() => PlanValidator.validate(p)).toThrow(
        'Generations released before the stall: "start" {A, B}',
      );
    });

    test("criticalSection and barrier visited in opposite orders", () => {
      const p = plan(
        ["A", "B"],
        [critical("A", "cs"), barrier("A", "sync"), barrier("B", "sync"), critical("B", "cs")],
      );
      expect(() => PlanValidator.validate(p)).toThrow(
        'device "A" waits at criticalSection lock "cs" (step 0; 1/2 arrived: A)',
      );
    });

    test("generation stranded behind another lock (finished track cannot arrive again)", () => {
      // X (deviceCount 2): A twice, B once, C once. B and C must pair at X
      // before either can reach Y, but Y needs A, which is still waiting for
      // its first X generation; the only pairings left strand A forever.
      const p = plan(
        ["A", "B", "C"],
        [
          barrier("A", "X"),
          barrier("A", "X"),
          barrier("B", "Y"),
          barrier("B", "X"),
          barrier("C", "X"),
          barrier("A", "Y"),
        ],
      );
      expect(() => PlanValidator.validate(p)).toThrow("coordination can never complete");
    });
  });

  describe("accepts plans some arrival order can complete", () => {
    test("devices visiting shared locks in the same order", () => {
      const p = plan(
        ["A", "B"],
        [barrier("A", "X"), barrier("A", "Y"), barrier("B", "X"), barrier("B", "Y")],
      );
      expect(() => PlanValidator.validate(p)).not.toThrow();
    });

    test("slack on a lock breaks an apparent AB-BA cycle", () => {
      // A: X,Y  B: Y,X  C: X,X -- C can substitute for B at X's first
      // generation, freeing A to reach Y with B.
      const p = plan(
        ["A", "B", "C"],
        [
          barrier("A", "X"),
          barrier("A", "Y"),
          barrier("B", "Y"),
          barrier("B", "X"),
          barrier("C", "X"),
          barrier("C", "X"),
        ],
      );
      expect(() => PlanValidator.validate(p)).not.toThrow();
    });

    test("timing-dependent stranding is accepted (completes under some orders)", () => {
      // deviceCount=3, A,A / B,B / C / D: completes if A,B,C pair first.
      const p = plan(
        ["A", "B", "C", "D"],
        [
          barrier("A", "X", 3),
          barrier("A", "X", 3),
          barrier("B", "X", 3),
          barrier("B", "X", 3),
          barrier("C", "X", 3),
          barrier("D", "X", 3),
        ],
      );
      expect(() => PlanValidator.validate(p)).not.toThrow();
    });

    test("opposite orders on independent locks with disjoint participants", () => {
      const p = plan(
        ["A", "B", "C", "D"],
        [
          barrier("A", "X"),
          barrier("B", "X"),
          barrier("C", "Y"),
          barrier("D", "Y"),
          barrier("A", "Y2"),
          barrier("C", "Y2"),
        ],
      );
      expect(() => PlanValidator.validate(p)).not.toThrow();
    });

    test("optional coordination steps opt the plan out of the check", () => {
      const steps = [barrier("A", "X"), barrier("A", "Y"), barrier("B", "Y"), barrier("B", "X")];
      steps[0] = { ...steps[0], optional: true };
      expect(() => PlanValidator.validate(plan(["A", "B"], steps))).not.toThrow();
    });

    test("criticalSection with nested coordination sub-steps opts out of the check", () => {
      const nested: PlanStep = {
        tool: "criticalSection",
        params: {
          device: "A",
          lock: "cs",
          deviceCount: 2,
          steps: [{ tool: "barrier", params: { device: "A", lock: "inner", deviceCount: 1 } }],
        },
      };
      const p = plan(
        ["A", "B"],
        [nested, barrier("A", "sync"), barrier("B", "sync"), critical("B", "cs")],
      );
      expect(() => PlanValidator.validate(p)).not.toThrow();
    });
  });

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

    test("returns null when there are no coordination events", () => {
      expect(findUnavoidableCoordinationDeadlock([{ device: "A", events: [] }])).toBeNull();
    });
  });
});
