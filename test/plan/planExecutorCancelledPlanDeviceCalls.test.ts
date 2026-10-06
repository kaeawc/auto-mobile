import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

// #9885: a plan whose signal is aborted by a session release has handed its device
// back to the pool, so it must issue no further device call (observe included) and
// must settle without riding out a bounded wait.

const deviceSchema = z.object({
  platform: z.string().optional(),
  deviceId: z.string().optional(),
  sessionUuid: z.string().optional(),
  device: z.string().optional(),
});
const TOOLS = ["cancelStep", "cancelFailStep", "cancelAfterStep", "observe"] as const;

interface Call {
  tool: string;
  device: string | undefined;
  atMs: number;
}

const markDevice = (name: string) => {
  (ToolRegistry.getTool(name) as { requiresDevice: boolean }).requiresDevice = true;
};

const waitForAbort = (signal: AbortSignal | undefined) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) {
      fail();
    } else {
      signal?.addEventListener("abort", fail, { once: true });
    }
  });

describe("PlanExecutor after its signal is aborted by a release (#9885)", () => {
  let timer: FakeTimer;
  let calls: Call[];
  let release: AbortController;
  let abortAtMs: number | undefined;
  let observeSignals: Array<AbortSignal | undefined>;

  const log = (tool: string, params: { device?: string }) => {
    calls.push({ tool, device: params.device, atMs: timer.now() });
  };
  const releaseSession = () => {
    // Move fake time so "after the abort instant" is a strict timestamp comparison.
    timer.advanceTime(1);
    abortAtMs = timer.now();
    release.abort(new DOMException("explicit-release", "AbortError"));
  };
  const callsAfterAbort = () => calls.filter((call) => call.atMs >= (abortAtMs ?? Infinity));

  beforeEach(() => {
    timer = new FakeTimer();
    calls = [];
    release = new AbortController();
    abortAtMs = undefined;
    observeSignals = [];
    // The plan's own observe, failure observation included, is a recorded device call.
    ToolRegistry.register(
      "observe",
      "recorded observe",
      deviceSchema,
      async (params: { device?: string }, _progress, signal) => {
        log("observe", params);
        observeSignals.push(signal);
        return createStructuredToolResponse({
          updatedAt: 0,
          screenSize: { width: 1, height: 1 },
          systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
        });
      },
    );
    ToolRegistry.register(
      "cancelStep",
      "waits on its signal like a long waitFor",
      deviceSchema,
      async (params: { device?: string }, _progress, signal) => {
        log("cancelStep", params);
        return waitForAbort(signal);
      },
    );
    ToolRegistry.register(
      "cancelAfterStep",
      "a step that would run after the long one",
      deviceSchema,
      async (params: { device?: string }) => {
        log("cancelAfterStep", params);
        return { success: true };
      },
    );
    ToolRegistry.register(
      "cancelFailStep",
      "reports an ordinary failure",
      deviceSchema,
      async (params: { device?: string }) => {
        log("cancelFailStep", params);
        return createStructuredToolResponse({ success: false, error: "boom" });
      },
    );
    for (const name of TOOLS) {
      markDevice(name);
    }
  });

  afterEach(() => {
    for (const name of TOOLS) {
      ToolRegistry.unregister(name);
    }
  });

  test("aborting mid-step issues no device call after the abort and settles with no timer advance", async () => {
    const plan: Plan = {
      name: "release mid-step",
      steps: [
        { tool: "cancelStep", params: {} },
        { tool: "cancelAfterStep", params: {} },
      ],
    };
    let settled = false;
    const run = new DefaultPlanExecutor(timer)
      .executePlan(plan, 0, "android", "emulator-5554", undefined, release.signal)
      .finally(() => {
        settled = true;
      });

    await drainUntil(() => calls.length === 1, { description: "first step started" });
    releaseSession();
    await run;

    expect(settled).toBe(true);
    // Bound: settles within the abort instant, so 0 ms of fake time after the release.
    expect(timer.now()).toBe(abortAtMs!);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(callsAfterAbort()).toEqual([]);
    expect(calls.map((call) => call.tool)).toEqual(["cancelStep"]);
  });

  test("a release landing during the failure observation aborts it instead of waiting out its deadline", async () => {
    // Replace the recorded observe with one that hangs until its signal fires.
    ToolRegistry.unregister("observe");
    ToolRegistry.register(
      "observe",
      "failure observation that never answers",
      deviceSchema,
      async (params: { device?: string }, _progress, signal) => {
        log("observe", params);
        observeSignals.push(signal);
        return waitForAbort(signal);
      },
    );
    markDevice("observe");
    const plan: Plan = {
      name: "release in failure observation",
      steps: [{ tool: "cancelFailStep", params: {} }],
    };
    let settled = false;
    const run = new DefaultPlanExecutor(timer)
      .executePlan(plan, 0, "android", "emulator-5554", undefined, release.signal)
      .finally(() => {
        settled = true;
      });

    await drainUntil(() => calls.some((call) => call.tool === "observe"), {
      description: "failure observation started",
    });
    releaseSession();
    await drainMicrotasks(200);

    // Before the fix the observe ran with no plan signal and the plan sat here until the
    // 3 s failure-observation deadline fired.
    expect(settled).toBe(true);
    expect(observeSignals[0]?.aborted).toBe(true);
    expect(timer.now()).toBe(abortAtMs!);
    const result = await run;
    expect(result.success).toBe(false);
    expect(result.failedStep?.failureObservation).toBeUndefined();
    expect(callsAfterAbort()).toEqual([]);
  });

  test("two devices aborted while one track waits at a barrier stop both tracks with no later calls", async () => {
    const plan: Plan = {
      name: "release at barrier",
      devices: ["A", "B"],
      steps: [
        { tool: "cancelStep", params: { device: "A" } }, // A waits (barrier stand-in)
        { tool: "cancelStep", params: { device: "B" } }, // B is mid-step too
        { tool: "cancelAfterStep", params: { device: "A" } },
        { tool: "cancelAfterStep", params: { device: "B" } },
      ],
    };
    let settled = false;
    const run = new DefaultPlanExecutor(timer)
      .executePlan(plan, 0, "android", undefined, undefined, release.signal)
      .finally(() => {
        settled = true;
      });

    await drainUntil(() => calls.length === 2, { description: "both tracks mid-step" });
    releaseSession();
    const result = await run;

    expect(settled).toBe(true);
    expect(result.success).toBe(false);
    expect(timer.now()).toBe(abortAtMs!);
    expect(callsAfterAbort()).toEqual([]);
    expect(calls.map((call) => call.tool).sort()).toEqual(["cancelStep", "cancelStep"]);
  });

  test("a plan that fails normally still captures its failure observation", async () => {
    const plan: Plan = {
      name: "ordinary failure",
      steps: [{ tool: "cancelFailStep", params: {} }],
    };

    const result = await new DefaultPlanExecutor(timer).executePlan(
      plan,
      0,
      "android",
      "emulator-5554",
      undefined,
      release.signal,
    );

    expect(result.success).toBe(false);
    expect(result.failedStep?.failureObservation).toBeDefined();
    expect(result.failedStep?.failureObservation?.observeError).toBeUndefined();
    expect(calls.map((call) => call.tool)).toEqual(["cancelFailStep", "observe"]);
    expect(observeSignals[0]?.aborted).not.toBe(true);
  });
});
