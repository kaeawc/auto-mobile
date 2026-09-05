import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Regression test for issue #6139: `captureFailureObservation` scheduled its
 * failure-observation timeout via the injected `Timer` but cancelled it with
 * the global `clearTimeout`, and the cancel sat after the `Promise.race`
 * outside a `finally` — so it was skipped whenever the race settled via
 * rejection (an injected `Timer` such as `FakeTimer` never has the handle
 * cancelled, leaking a pending timer). The fix cancels through
 * `this.timer.clearTimeout(...)` inside a `finally` around the race so the
 * timer is always cancelled, on both the resolve and reject paths.
 */
describe("PlanExecutor — captureFailureObservation timer cancellation", () => {
  let planExecutor: DefaultPlanExecutor;
  let fakeTimer: FakeTimer;

  const deviceSchema = z.object({
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  const markDevice = (name: string) => {
    (ToolRegistry.getTool(name) as { requiresDevice: boolean }).requiresDevice = true;
  };

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    planExecutor = new DefaultPlanExecutor(fakeTimer);

    ToolRegistry.register(
      "captureTimerFailStep",
      "always fails, triggering captureFailureObservation",
      deviceSchema,
      mock(async () => createStructuredToolResponse({ success: false, error: "boom" })),
    );
    markDevice("captureTimerFailStep");
  });

  afterEach(() => {
    registerObserveTools();
  });

  test("cancels the injected timer via this.timer, not global clearTimeout, on the success path", async () => {
    ToolRegistry.register(
      "observe",
      "observe resolves before the failure-observation timeout",
      deviceSchema,
      mock(async () =>
        createStructuredToolResponse({
          updatedAt: 0,
          screenSize: { width: 100, height: 100 },
          systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
        }),
      ),
    );
    markDevice("observe");

    const plan: Plan = {
      name: "capture-failure-observation-success",
      steps: [{ tool: "captureTimerFailStep", params: {} }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    expect(result.failedStep?.failureObservation).toBeDefined();
    expect(result.failedStep?.failureObservation?.observeError).toBeUndefined();
    // The observe tool resolved before the failure-observation timeout fired,
    // so the `finally` block must have cancelled it through the injected
    // FakeTimer — no pending timer should remain.
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
  });

  test("cancels the injected timer via this.timer, not global clearTimeout, on the rejection path", async () => {
    ToolRegistry.register(
      "observe",
      "observe rejects before the failure-observation timeout",
      deviceSchema,
      mock(async () => {
        throw new Error("observe blew up");
      }),
    );
    markDevice("observe");

    const plan: Plan = {
      name: "capture-failure-observation-rejection",
      steps: [{ tool: "captureTimerFailStep", params: {} }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    // captureFailureObservation's own catch turns the rejection into an
    // observeError summary rather than throwing.
    expect(result.failedStep?.failureObservation?.observeError).toContain("observe blew up");
    // Before the fix, the cancel after Promise.race was skipped on this
    // rejection path (and used the global clearTimeout even when reached),
    // so the FakeTimer's pending timeout was never removed.
    expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
  });
});
