import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { UNSETTLED_EXECUTION_VETO_CEILING_MS } from "../../src/daemon/unsettledExecutionVeto";
import {
  LivenessScenario,
  NO_HEARTBEAT_BUDGET_MS,
  SCAN_MS,
} from "../helpers/livenessScenarioHarness";

// #11162 item 4: the unsettled-execution veto stamps and judges its bound on the session clock,
// against request deadlines converted onto that clock, so a wall-clock step neither ends a call's
// veto early (releasing its device mid-call) nor stretches it.

const HOUR_MS = 3_600_000;

let scenario: LivenessScenario | undefined;

// The first scenario pays for module-level one-time costs, outside the per-test budget.
beforeAll(async () => {
  await (await LivenessScenario.start()).stop();
});

afterEach(async () => {
  await scenario?.stop();
  scenario = undefined;
});

describe("unsettled-execution veto across a wall-clock step (#11162)", () => {
  test("a forward step does not release a silent owner's session mid-call; the call's end does", async () => {
    scenario = await LivenessScenario.start();
    // Where the monotonic clock runs through sleep (Linux, Windows) the session clock ignores a
    // forward wall step; only the raw wall clock moves.
    scenario.timer.simulateSleepCountingMonotonicClock();
    const session = await scenario.acquire();
    const call = scenario.startLongCall(session);
    scenario.dropHeartbeats = true;

    // The owner's lease runs out with the call in flight: the veto keeps the session.
    await scenario.idle(2 * NO_HEARTBEAT_BUDGET_MS);
    expect(scenario.isHeld(session)).toBe(true);

    scenario.timer.stepWallClock(UNSETTLED_EXECUTION_VETO_CEILING_MS + HOUR_MS);
    await scenario.idle(4 * SCAN_MS);

    expect(scenario.isHeld(session)).toBe(true);
    expect(scenario.releaseOf(session)).toBeUndefined();

    await call.settle();
    await scenario.idle(2 * SCAN_MS);
    expect(scenario.isHeld(session)).toBe(false);
  });
});
