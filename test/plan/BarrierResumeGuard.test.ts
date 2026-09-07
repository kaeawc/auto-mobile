import { describe, expect, test } from "bun:test";
import { computeSafeBarrierResumeStep } from "../../src/utils/plan/BarrierResumeGuard";
import { Plan } from "../../src/models/Plan";

/**
 * Regression coverage for issue #6234: AI recovery must not resume in the middle
 * of a barrier generation. computeSafeBarrierResumeStep rewinds a requested
 * resume step to the start of any barrier/criticalSection generation it would
 * split, and leaves a clean resume point untouched.
 */
describe("computeSafeBarrierResumeStep (#6234)", () => {
  const barrierStep = (device: string, lock: string, deviceCount: number) => ({
    tool: "barrier",
    params: { device, lock, deviceCount },
  });

  const actionStep = (device: string) => ({
    tool: "tapOn",
    params: { device, text: "ok" },
  });

  const plan = (steps: Plan["steps"]): Plan => ({
    name: "barrier-plan",
    mcpVersion: "1.0",
    devices: ["A", "B"],
    steps,
  });

  test("rewinds a resume step landing inside a barrier generation to the generation start", () => {
    // step 0: A arrives, step 1: B arrives (deviceCount=2 -> one generation
    // spanning [0,1]). Resuming at 1 would re-run B alone while A's arrival is
    // skipped -> B waits forever. Rewind to 0 so both re-arrive together.
    const p = plan([barrierStep("A", "L", 2), barrierStep("B", "L", 2), actionStep("A")]);
    expect(computeSafeBarrierResumeStep(p, 1)).toBe(0);
  });

  test("leaves a resume step at the generation boundary unchanged", () => {
    // Resuming at 0 runs the whole generation from its first arrival — no split.
    const p = plan([barrierStep("A", "L", 2), barrierStep("B", "L", 2), actionStep("A")]);
    expect(computeSafeBarrierResumeStep(p, 0)).toBe(0);
  });

  test("does not rewind a resume step past a fully-completed generation", () => {
    // Resuming at 2 (after both arrivals) skips the whole generation uniformly
    // across every track — no participant re-arrives, so nothing to rewind.
    const p = plan([
      barrierStep("A", "L", 2),
      barrierStep("B", "L", 2),
      actionStep("A"),
      actionStep("B"),
    ]);
    expect(computeSafeBarrierResumeStep(p, 2)).toBe(2);
    expect(computeSafeBarrierResumeStep(p, 3)).toBe(3);
  });

  test("rewinds only across the straddled generation, not earlier completed ones", () => {
    // Two generations of lock L: gen0 = [0,1], gen1 = [3,4], with an action at 2.
    // Resuming at 4 splits gen1 (arrival at 3 skipped, 4 re-run) -> rewind to 3,
    // NOT back to gen0's start at 0.
    const p = plan([
      barrierStep("A", "L", 2), // 0  gen0
      barrierStep("B", "L", 2), // 1  gen0
      actionStep("A"), // 2
      barrierStep("A", "L", 2), // 3  gen1
      barrierStep("B", "L", 2), // 4  gen1
    ]);
    expect(computeSafeBarrierResumeStep(p, 4)).toBe(3);
    // Resuming inside gen0 rewinds only to gen0's start.
    expect(computeSafeBarrierResumeStep(p, 1)).toBe(0);
  });

  test("iterates to a fixed point across interleaved barrier locks", () => {
    // Two locks whose generations interleave in plan order:
    //   X: [0,2]  (A@0, B@2)
    //   Y: [1,3]  (A@1, B@3)
    // Resuming at 3 splits Y -> rewind to 1; 1 then splits X ([0,2]) -> rewind to 0.
    const p = plan([
      barrierStep("A", "X", 2), // 0  X gen
      barrierStep("A", "Y", 2), // 1  Y gen
      barrierStep("B", "X", 2), // 2  X gen
      barrierStep("B", "Y", 2), // 3  Y gen
    ]);
    expect(computeSafeBarrierResumeStep(p, 3)).toBe(0);
  });

  test("treats a criticalSection lock as a single generation", () => {
    const p = plan([
      { tool: "criticalSection", params: { device: "A", lock: "cs", deviceCount: 2, steps: [] } },
      { tool: "criticalSection", params: { device: "B", lock: "cs", deviceCount: 2, steps: [] } },
      actionStep("A"),
    ]);
    expect(computeSafeBarrierResumeStep(p, 1)).toBe(0);
    expect(computeSafeBarrierResumeStep(p, 2)).toBe(2);
  });

  test("leaves plans without coordination steps unchanged", () => {
    const p = plan([actionStep("A"), actionStep("B"), actionStep("A")]);
    expect(computeSafeBarrierResumeStep(p, 2)).toBe(2);
  });

  test("never returns a negative or above-request resume step", () => {
    const p = plan([barrierStep("A", "L", 2), barrierStep("B", "L", 2)]);
    expect(computeSafeBarrierResumeStep(p, 0)).toBe(0);
    expect(computeSafeBarrierResumeStep(p, -3)).toBe(-3);
  });
});
