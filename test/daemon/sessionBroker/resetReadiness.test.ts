import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { ResetReadiness } from "../../../src/daemon/sessionBroker/resetReadiness";
import type {
  BrokerAdmissionInput,
  BrokerRequestRecord,
  BrokerResourceRecord,
  BrokerTimingSample,
} from "../../../src/daemon/sessionBroker/store";
import type { BrokerNativeProfile } from "../../../src/daemon/sessionBroker/profile";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

const PROFILE: BrokerNativeProfile = {
  platform: "ios",
  metadataState: "current",
  simulatorDeviceTypeIdentifier: "iphone",
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro" },
  runtimeId: "ios-27",
  osVersion: "27",
  compatibility: "supported",
};

class FakeReadinessStore {
  resource: BrokerResourceRecord = {
    resourceId: "resource",
    allocationIndex: 1,
    scopeKey: "scope",
    profile: { profile: PROFILE },
    state: "resetting",
    requestId: "release",
    revision: 1,
    idleOrder: 0,
  };
  request: BrokerRequestRecord = {
    requestId: "release",
    fingerprint: "fingerprint",
    parameters: {},
    owner: { daemonId: "daemon", pid: 1, processGenerationToken: "generation" },
    state: "releasing",
    resourceId: "resource",
    sessionId: "session",
    error: null,
    errorCode: null,
    retryable: false,
    timing: {
      reset: {
        mode: "erase",
        outcome: "pending",
        phases: {},
        reuseCount: 0,
        startedAtMs: 0,
        totalMs: 0,
      },
    },
  };
  samples: BrokerTimingSample[] = [
    {
      profile: PROFILE,
      timing: {
        acquisition: {
          admission: "create",
          reuseCount: 0,
          outcome: "ready",
          startedAtMs: 0,
          completedAtMs: 1000,
          queueMs: 0,
          admissionWaitMs: 0,
          createMs: 200,
          bootMs: 400,
          totalMs: 600,
        },
        reset: {
          mode: "erase",
          outcome: "clean",
          phases: { stop: 20, erase: 30, boot: 50 },
          reuseCount: 0,
          startedAtMs: 0,
          completedAtMs: 1000,
          totalMs: 100,
        },
      },
    },
  ];
  continuations = 0;
  readHook?: () => void;

  async listLiveResources() {
    return [this.resource];
  }
  async getRequest() {
    return this.request;
  }
  async getResource() {
    const resource = { ...this.resource };
    this.readHook?.();
    return resource;
  }
  async timingSamples() {
    return this.samples;
  }
  async continueAdmission(input: BrokerAdmissionInput) {
    this.continuations += 1;
    expect(input.resetReadiness).toBeUndefined();
    return {
      kind: this.resource.state === "idle" ? ("reuse" as const) : ("create" as const),
      request: { ...this.request, requestId: input.requestId, state: "acquiring" as const },
      resource: this.resource,
    };
  }
}

function harness() {
  const timer = new FakeTimer();
  timer.advanceTime(1000);
  const store = new FakeReadinessStore();
  store.request.timing!.reset!.startedAtMs = 950;
  const readiness = new ResetReadiness(store, timer);
  readiness.setResetActive("resource", true);
  const input: BrokerAdmissionInput = {
    requestId: "acquire",
    fingerprint: "fingerprint",
    parameters: {},
    owner: store.request.owner,
    limits: {},
    matches: () => true,
    resolveCreation: () => ({ profile: PROFILE }),
    timingStartedAtMs: 1000,
    resetReadiness: { thresholdMs: 600, expectedReadyMs: new Map([["resource", 50]]) },
  };
  const admission = {
    kind: "wait" as const,
    request: store.request,
    resourceId: "resource",
    waitMs: 600,
  };
  return { store, timer, readiness, input, admission, controller: new AbortController() };
}

describe("reset readiness", () => {
  test("estimates remaining reset time from successful profile timing history", async () => {
    const context = harness();
    expect(await context.readiness.snapshot(() => true)).toMatchObject({
      thresholdMs: 600,
      expectedReadyMs: new Map([["resource", 50]]),
    });
    expect(await context.readiness.snapshot(() => false)).toBeUndefined();
  });

  test("cold-create break-even includes the readiness phase observed on device (#14791)", async () => {
    const context = harness();
    // Measured batch 20261022a: create 5.6 s, boot 27-49 s, readiness 60-70 s, total 111-123 s;
    // erase resets 54-60 s. The third acquisition began shortly after release (about 50 s of reset remain).
    const acquisition = context.store.samples[0].timing.acquisition!;
    const cold = (createMs: number, bootMs: number, automationReadyMs: number, totalMs: number) =>
      ({
        profile: PROFILE,
        timing: { acquisition: { ...acquisition, createMs, bootMs, automationReadyMs, totalMs } },
      }) satisfies BrokerTimingSample;
    const reset = (totalMs: number) =>
      ({
        profile: PROFILE,
        timing: {
          reset: { ...context.store.samples[0].timing.reset!, phases: {}, totalMs },
        },
      }) satisfies BrokerTimingSample;
    context.store.samples = [
      cold(5_569, 49_184, 68_000, 123_433),
      cold(900, 38_000, 65_000, 110_992),
      reset(60_500),
      reset(56_500),
    ];
    context.timer.advanceTime(10_000);
    context.store.request.timing!.reset!.startedAtMs = 1000;
    const snapshot = (await context.readiness.snapshot(() => true))!;
    expect(snapshot.thresholdMs).toBeGreaterThanOrEqual(110_992);
    // About 50 s of reset remain: far cheaper than a 111-123 s cold create, so wait.
    expect(snapshot.expectedReadyMs.get("resource")).toBeLessThanOrEqual(snapshot.thresholdMs);
  });

  test("parked and failed pending resets never offer readiness", async () => {
    const context = harness();
    context.readiness.setResetActive("resource", false);
    expect(await context.readiness.snapshot(() => true)).toBeUndefined();
  });

  test("stale snapshots cannot give two requests the same resetting device", async () => {
    const context = harness();
    const first = (await context.readiness.snapshot(() => true))!;
    const second = (await context.readiness.snapshot(() => true))!;
    expect(first.canWait!("resource")).toBe(true);
    first.reserveWait!("first", "resource");
    expect(second.canWait!("resource")).toBe(false);
    expect(await context.readiness.snapshot(() => true)).toBeUndefined();
    context.readiness.releaseWait("first");
    expect(second.canWait!("resource")).toBe(true);
    context.readiness.setResetActive("resource", false);
    expect(second.canWait!("resource")).toBe(false);
  });

  test.each(["listLiveResources", "timingSamples", "getRequest"] as const)(
    "%s failure warns and discards the readiness hint",
    async (method) => {
      const context = harness();
      const error = new Error("read unavailable");
      const read = spyOn(context.store, method).mockRejectedValue(error);
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(await context.readiness.snapshot(() => true)).toBeUndefined();
        expect(warning).toHaveBeenCalledWith(
          "Could not estimate resetting simulator readiness",
          error,
        );
      } finally {
        read.mockRestore();
        warning.mockRestore();
      }
    },
  );

  test("a waiter arriving after a failed reset wakeup does not sleep before destroy commits", async () => {
    const context = harness();
    context.readiness.setResetActive("resource", false);
    context.readiness.notify("resource");
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      1000,
      context.controller.signal,
    );
    await drainUntilQuiescent(context.timer);
    expect(context.store.resource.state).toBe("resetting");
    expect(context.store.continuations).toBe(1);
    expect(context.timer.now()).toBe(1000);
    expect((await pending).admission.kind).toBe("create");
  });

  test("ignores reused acquisitions and failed resets when estimating readiness", async () => {
    const context = harness();
    const sample = context.store.samples[0];
    context.store.samples.push({
      ...sample,
      timing: {
        acquisition: { ...sample.timing.acquisition!, admission: "reuse", createMs: 0, bootMs: 0 },
        reset: { ...sample.timing.reset!, outcome: "destroyed", totalMs: 99999 },
      },
    });
    expect((await context.readiness.snapshot(() => true))?.thresholdMs).toBe(600);
    expect((await context.readiness.snapshot(() => true))?.expectedReadyMs.get("resource")).toBe(
      50,
    );
  });

  test("offers readiness after p50 while the p90 reset estimate is still in the future", async () => {
    const context = harness();
    context.store.samples.push({
      ...context.store.samples[0],
      timing: {
        ...context.store.samples[0].timing,
        reset: { ...context.store.samples[0].timing.reset!, totalMs: 300 },
      },
    });
    context.store.request.timing!.reset!.startedAtMs = 750;

    expect((await context.readiness.snapshot(() => true))?.expectedReadyMs.get("resource")).toBe(
      30,
    );
  });

  test("missing history and overdue resets do not offer readiness", async () => {
    const context = harness();
    context.timer.advanceTime(101);
    expect(await context.readiness.snapshot(() => true)).toBeUndefined();
    context.store.samples = [];
    expect(await context.readiness.snapshot(() => true)).toBeUndefined();
  });

  test.each(["idle", "destroying"] as const)(
    "wakes immediately on %s and reconsiders admission without another wait",
    async (state) => {
      const context = harness();
      const pending = context.readiness.continueAfterWait(
        context.admission,
        context.input,
        1000,
        context.controller.signal,
      );
      await drainUntilQuiescent(context.timer);
      context.store.resource.state = state;
      context.readiness.notify("resource");
      expect(await pending).toMatchObject({
        admission: { kind: state === "idle" ? "reuse" : "create" },
        preparationTimeoutMs: 1000,
      });
      expect(context.store.continuations).toBe(1);
      expect(context.timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a readiness notification during the fresh read is not lost", async () => {
    const context = harness();
    context.store.readHook = () => context.readiness.notify("resource");
    await context.readiness.wait("resource", 600, context.controller.signal);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("wait timeout falls back to create with only the remaining preparation budget", async () => {
    const context = harness();
    context.store.samples[0].timing.reset!.phases = { erase: 1000 };
    context.store.samples[0].timing.reset!.totalMs = 1000;
    const readiness = (await context.readiness.snapshot(() => true))!;
    readiness.reserveWait!(context.input.requestId, "resource");
    context.input.resetReadiness = readiness;
    const continued = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const continueAdmission = context.store.continueAdmission.bind(context.store);
    const continuation = spyOn(context.store, "continueAdmission").mockImplementation(
      async (input) => {
        entered.resolve();
        await continued.promise;
        return continueAdmission(input);
      },
    );
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      1000,
      context.controller.signal,
    );
    try {
      await drainUntilQuiescent(context.timer);
      context.readiness.setResetActive("resource", false);
      context.timer.advanceTime(600);
      await entered.promise;
      context.readiness.setResetActive("resource", true);
      expect(await context.readiness.snapshot(() => true)).toBeDefined();
      continued.resolve();
      expect(await pending).toMatchObject({
        admission: { kind: "create" },
        preparationTimeoutMs: 400,
      });
      expect(context.timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      continued.resolve();
      continuation.mockRestore();
    }
  });

  test("reset completing just AFTER the initial wait expires is reused, not created", async () => {
    const context = harness();
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      5000,
      context.controller.signal,
    );
    await drainUntilQuiescent(context.timer);
    context.timer.advanceTime(600);
    await drainUntilQuiescent(context.timer);
    expect(context.store.continuations).toBe(0);
    expect(context.timer.getPendingTimeoutCount()).toBe(1);
    context.timer.advanceTime(400);
    context.store.resource.state = "idle";
    context.readiness.notify("resource");
    expect((await pending).admission.kind).toBe("reuse");
    expect(context.store.continuations).toBe(1);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("reset completing just BEFORE the initial wait expires is reused without extension", async () => {
    const context = harness();
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      5000,
      context.controller.signal,
    );
    await drainUntilQuiescent(context.timer);
    context.timer.advanceTime(599);
    context.store.resource.state = "idle";
    context.readiness.notify("resource");
    expect((await pending).admission.kind).toBe("reuse");
    expect(context.store.continuations).toBe(1);
    expect(context.timer.now()).toBe(1599);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a reset still running after the extension falls back to create", async () => {
    const context = harness();
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      5000,
      context.controller.signal,
    );
    await drainUntilQuiescent(context.timer);
    context.timer.advanceTime(600);
    await drainUntilQuiescent(context.timer);
    expect(context.store.continuations).toBe(0);
    context.timer.advanceTime(600);
    expect(await pending).toMatchObject({
      admission: { kind: "create" },
      preparationTimeoutMs: 3800,
    });
    expect(context.store.continuations).toBe(1);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("the extension never outlives the preparation deadline", async () => {
    const context = harness();
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      900,
      context.controller.signal,
    );
    const rejected = pending.catch((error: unknown) => error);
    await drainUntilQuiescent(context.timer);
    context.timer.advanceTime(600);
    await drainUntilQuiescent(context.timer);
    expect(context.store.continuations).toBe(0);
    expect(context.timer.getPendingTimeouts()).toEqual([300]);
    context.timer.advanceTime(300);
    expect(await rejected).toMatchObject({ message: expect.stringContaining("deadline expired") });
    expect(context.store.continuations).toBe(0);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a waiter holds its reservation across the extension", async () => {
    const context = harness();
    const readiness = (await context.readiness.snapshot(() => true))!;
    readiness.reserveWait!(context.input.requestId, "resource");
    context.input.resetReadiness = readiness;
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      5000,
      context.controller.signal,
    );
    await drainUntilQuiescent(context.timer);
    context.timer.advanceTime(600);
    await drainUntilQuiescent(context.timer);
    expect(await context.readiness.snapshot(() => true)).toBeUndefined();
    expect(readiness.canWait!("resource")).toBe(false);
    context.timer.advanceTime(400);
    context.store.resource.state = "idle";
    context.readiness.notify("resource");
    expect((await pending).admission.kind).toBe("reuse");
    expect(readiness.canWait!("resource")).toBe(true);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("the caller deadline ends waiting without starting creation", async () => {
    const context = harness();
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      200,
      context.controller.signal,
    );
    const rejected = pending.catch((error: unknown) => error);
    await drainUntilQuiescent(context.timer);
    context.timer.advanceTime(200);
    expect(await rejected).toMatchObject({ message: expect.stringContaining("deadline expired") });
    expect(context.store.continuations).toBe(0);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("cancellation removes readiness listeners and does not create", async () => {
    const context = harness();
    const pending = context.readiness.continueAfterWait(
      context.admission,
      context.input,
      1000,
      context.controller.signal,
    );
    const rejected = pending.catch((error: unknown) => error);
    await drainUntilQuiescent(context.timer);
    context.controller.abort(new Error("cancelled"));
    expect(await rejected).toMatchObject({ message: "cancelled" });
    context.readiness.notify("resource");
    expect(context.store.continuations).toBe(0);
    expect(context.timer.getPendingTimeoutCount()).toBe(0);
  });
});
