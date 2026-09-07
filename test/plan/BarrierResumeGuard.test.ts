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

  test("groups generations by device-track order, not contiguous global index", () => {
    // Device-grouped plan order: device A's two arrivals (0,1) precede device B's
    // two arrivals (2,3). A global-order slice would wrongly pair {0,1} and {2,3},
    // but the coordinator rendezvous is the g-th arrival of EACH device track:
    //   gen0 = A@0 + B@2  (span [0,2])
    //   gen1 = A@1 + B@3  (span [1,3])
    const p = plan([
      barrierStep("A", "L", 2), // 0  A arrival #0 -> gen0
      barrierStep("A", "L", 2), // 1  A arrival #1 -> gen1
      barrierStep("B", "L", 2), // 2  B arrival #0 -> gen0
      barrierStep("B", "L", 2), // 3  B arrival #1 -> gen1
    ]);
    // Resume at 2 splits gen0 ([0,2]): A@0 would be skipped while B@2 re-arrives
    // alone. The old global-slice guard saw span {2,3}, left 2 unchanged, and the
    // survivor still deadlocked. Rewinding to gen0's first arrival (0) re-arrives
    // A@0/B@2 together and then gen1.
    expect(computeSafeBarrierResumeStep(p, 2)).toBe(0);
    // Resume at 3 splits gen1 ([1,3]) -> rewind to 1, which then splits gen0
    // ([0,2]) -> rewind to 0. (Old guard rewound only to 2 and still deadlocked.)
    expect(computeSafeBarrierResumeStep(p, 3)).toBe(0);
    // A clean boundary (gen0's first arrival) is untouched.
    expect(computeSafeBarrierResumeStep(p, 0)).toBe(0);
    // Resume at 1 splits gen0 ([0,2]) -> rewind to 0.
    expect(computeSafeBarrierResumeStep(p, 1)).toBe(0);
  });

  test("handles a three-device lock grouped by track order", () => {
    // A@0,A@1 | B@2,B@3 | C@4,C@5 with deviceCount=3.
    //   gen0 = {0,2,4} span [0,4]
    //   gen1 = {1,3,5} span [1,5]
    const p: Plan = {
      name: "barrier-plan",
      mcpVersion: "1.0",
      devices: ["A", "B", "C"],
      steps: [
        barrierStep("A", "L", 3), // 0 gen0
        barrierStep("A", "L", 3), // 1 gen1
        barrierStep("B", "L", 3), // 2 gen0
        barrierStep("B", "L", 3), // 3 gen1
        barrierStep("C", "L", 3), // 4 gen0
        barrierStep("C", "L", 3), // 5 gen1
      ],
    };
    // Resume at 5 splits gen1 ([1,5]) -> 1 -> gen0 ([0,4]) straddles 1 -> 0.
    expect(computeSafeBarrierResumeStep(p, 5)).toBe(0);
    // Resume at 4 splits gen0 ([0,4]) -> 0.
    expect(computeSafeBarrierResumeStep(p, 4)).toBe(0);
  });

  test("rejects an invalid barrier shape instead of replaying the entire lock", () => {
    // deviceCount=2 but three distinct devices each arrive once: plan validation
    // would reject this, and the coordinator cannot form a clean generation.
    // Recovery must reject the plan rather than guess and replay completed work.
    const p: Plan = {
      name: "barrier-plan",
      mcpVersion: "1.0",
      devices: ["A", "B", "C"],
      steps: [
        barrierStep("A", "L", 2), // 0
        barrierStep("B", "L", 2), // 1
        barrierStep("C", "L", 2), // 2
      ],
    };
    expect(() => computeSafeBarrierResumeStep(p, 1)).toThrow("Cannot safely recover barrier lock");
    expect(() => computeSafeBarrierResumeStep(p, 2)).toThrow("Cannot safely recover barrier lock");
  });

  test("uses per-device frontiers for validator-permitted changing participant sets", () => {
    // Generation 0 is A+B; after its release, A's next arrival pairs with C.
    // The validator permits this (four arrivals, count two, no device appears
    // more than twice). The old equal-column model classified it as ragged and
    // rewound start=4 all the way to 0, replaying the completed A+B round and
    // the destructive action at 2. Recovery must rewind only to A+C's start.
    const p: Plan = {
      name: "changing-participants",
      mcpVersion: "1.0",
      devices: ["A", "B", "C"],
      steps: [
        barrierStep("A", "L", 2), // 0 generation 0
        barrierStep("B", "L", 2), // 1 generation 0
        actionStep("B"), // 2 already-completed destructive work
        barrierStep("A", "L", 2), // 3 generation 1
        barrierStep("C", "L", 2), // 4 generation 1
      ],
    };

    expect(computeSafeBarrierResumeStep(p, 4)).toBe(3);
    expect(computeSafeBarrierResumeStep(p, 3)).toBe(3);
    expect(computeSafeBarrierResumeStep(p, 2)).toBe(2);
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

  test("treats deviceCount=1 arrivals as singleton generations, never grouping them by device track (#6234 P2 follow-up)", () => {
    // deviceCount=1 means EVERY arrival completes its own generation
    // immediately, regardless of which (or how many distinct) devices share
    // the lock. The device-track/column model used for deviceCount>1 assumes
    // a generation is filled by `deviceCount` distinct devices arriving
    // together, which never holds here (two distinct devices, A and B, share
    // a count-one lock) - it used to fall through to the irregular, whole-
    // lock fallback and needlessly rewind past an already-completed arrival.
    const p = plan([
      barrierStep("A", "L", 1), // 0  A's own generation, already complete
      actionStep("A"), // 1  destructive action, already run
      actionStep("B"), // 2  the step that failed and triggered recovery
      barrierStep("B", "L", 1), // 3  B's own generation, not yet reached
    ]);
    // Resuming at the failed step (2) does not split any generation: A's
    // count-one arrival at 0 already completed on its own, and B's at 3
    // has not happened yet. There is nothing to rewind for.
    expect(computeSafeBarrierResumeStep(p, 2)).toBe(2);
    // Resuming exactly at a count-one arrival is likewise a clean boundary.
    expect(computeSafeBarrierResumeStep(p, 3)).toBe(3);
    // Resuming strictly between the two singleton arrivals (e.g. at the
    // destructive action) is also clean - it does not land inside either
    // one-arrival generation.
    expect(computeSafeBarrierResumeStep(p, 1)).toBe(1);
  });
});
