import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import type { ResetResult } from "../../../src/daemon/sessionBroker/devicePort";
import { openExportHarness, exportConfig } from "./fixtures/exportHarness";
import { drainUntil, drainUntilQuiescent } from "../../helpers/fakeTimerStepping";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";

describe("broker reset readiness lifecycle", () => {
  let harness: Awaited<ReturnType<typeof openExportHarness>>;
  let broker: SessionBroker;
  let finishReset: ReturnType<typeof Promise.withResolvers<ResetResult>>;
  let resetStarted: ReturnType<typeof Promise.withResolvers<void>>;

  beforeAll(async () => {
    const warm = await openExportHarness();
    await warm.broker.close();
    await warm.registry.close();
  });
  beforeEach(async () => {
    harness = await openExportHarness();
    harness.options.timer = harness.timer;
    harness.options.reuseCleanDevices = true;
    harness.options.limits = { idlePoolCap: 1 };
    harness.options.devices = {
      prepare: async (resource, options) => {
        const result = await harness.devices.prepare(resource, options);
        harness.timer.advanceTime(30);
        return { ...result, timing: { createMs: 10, bootMs: 20 } };
      },
      release: (sessionId) => harness.devices.release(sessionId),
      destroy: (resource) => harness.devices.destroy(resource),
      reset: async (resource) => {
        await harness.devices.reset(resource);
        harness.timer.advanceTime(10);
        return "clean";
      },
    };
    broker = new SessionBroker(harness.options);
    const seed = await broker.prepare(exportConfig("seed"), "token");
    await broker.release(seed.sessionUuid!);
    finishReset = Promise.withResolvers<ResetResult>();
    resetStarted = Promise.withResolvers<void>();
    harness.options.devices.reset = async () => {
      resetStarted.resolve();
      return finishReset.promise;
    };
  });
  afterEach(async () => {
    finishReset.resolve("clean");
    await broker.close();
    await harness.broker.close();
    await harness.registry.close();
  });

  async function startRelease() {
    const ready = await broker.prepare(exportConfig("release"), "token");
    const released = broker.release(ready.sessionUuid!);
    await resetStarted.promise;
    return { released, ready };
  }

  test("only one of two concurrent acquisitions waits for the same simulator", async () => {
    const { released } = await startRelease();
    const originalAdmit = harness.store.admit.bind(harness.store);
    const decisions: string[] = [];
    const admission = spyOn(harness.store, "admit").mockImplementation(async (input) => {
      const result = await originalAdmit(input);
      decisions.push(result.kind);
      return result;
    });
    try {
      const first = broker.prepare(exportConfig("first"), "token");
      const second = broker.prepare(exportConfig("second"), "token");
      await drainUntil(() => decisions.length === 2, { description: "concurrent admission" });
      expect(decisions.sort()).toEqual(["create", "wait"]);
      finishReset.resolve("clean");
      expect((await first).outcome).toBe("ready");
      expect((await second).outcome).toBe("ready");
      await released;
    } finally {
      admission.mockRestore();
    }
  });

  test("a refusal after waiting records failed acquisition timing", async () => {
    const { released, ready } = await startRelease();
    const source = (await harness.store.getRequest(ready.requestId))!;
    const request = {
      ...source,
      requestId: "refused-after-wait",
      state: "acquiring" as const,
      timing: {
        acquisition: {
          ...ready.timing!.acquisition!,
          admission: "wait" as const,
          outcome: "pending" as const,
        },
      },
    };
    const admit = spyOn(harness.store, "admit").mockResolvedValue({
      kind: "wait",
      request,
      resourceId: source.resourceId!,
      waitMs: 25,
    });
    const continueAdmission = spyOn(harness.store, "continueAdmission").mockResolvedValue({
      kind: "refused",
      request: {
        ...request,
        state: "failed",
        error: "capacity exhausted",
        errorCode: "capacity_exhausted",
        retryable: true,
      },
      reason: "total-device-cap-reached",
    });
    const recordTiming = spyOn(harness.store, "recordTiming");
    try {
      const pending = broker.prepare(exportConfig("refused-after-wait"), "token");
      await drainUntilQuiescent(harness.timer);
      harness.timer.advanceTime(25);
      // The reset is still running, so the wait extends once by the cold-create estimate (#14791).
      await drainUntilQuiescent(harness.timer);
      harness.timer.advanceTime(harness.timer.getMsUntilNextDueEvent() ?? 0);
      const result = await pending;
      expect(result.timing?.acquisition).toMatchObject({
        admission: "wait",
        outcome: "failed",
      });
      expect(recordTiming).toHaveBeenCalledWith(
        request.requestId,
        expect.objectContaining({
          acquisition: expect.objectContaining({ admission: "wait", outcome: "failed" }),
        }),
      );
      expect(continueAdmission).toHaveBeenCalledTimes(1);
    } finally {
      admit.mockRestore();
      continueAdmission.mockRestore();
      recordTiming.mockRestore();
      finishReset.resolve("clean");
      await released;
    }
  });

  test("failed reset wakes existing waiters after destruction commits, not before", async () => {
    const { released, ready } = await startRelease();
    const originalDestroy = harness.store.releaseByDestruction.bind(harness.store);
    const destructionEntered = Promise.withResolvers<void>();
    const commitDestruction = Promise.withResolvers<void>();
    const destruction = spyOn(harness.store, "releaseByDestruction").mockImplementation(
      async (...args) => {
        destructionEntered.resolve();
        await commitDestruction.promise;
        return originalDestroy(...args);
      },
    );
    try {
      const timeouts = harness.timer.getPendingTimeoutCount();
      const pending = broker.prepare(exportConfig("waiter"), "token");
      await drainUntil(() => harness.timer.getPendingTimeoutCount() > timeouts, {
        description: "reset waiter subscription",
      });
      await drainUntilQuiescent(harness.timer);
      const before = harness.timer.now();
      finishReset.reject(new Error("reset failed"));
      await destructionEntered.promise;
      await drainUntilQuiescent(harness.timer);
      const request = (await harness.store.getRequest(ready.requestId))!;
      expect((await harness.store.getResource(request.resourceId!))?.state).toBe("resetting");
      expect(harness.devices.prepared).toHaveLength(2);
      commitDestruction.resolve();
      const result = await pending;
      expect(result.outcome).toBe("ready");
      expect(result.timing?.acquisition?.admission).toBe("create");
      expect(harness.timer.now() - before).toBe(30);
      await released;
    } finally {
      commitDestruction.resolve();
      destruction.mockRestore();
    }
  });

  test("deadline failures while waiting are included in durable timing statistics", async () => {
    const { released } = await startRelease();
    const timeouts = harness.timer.getPendingTimeoutCount();
    const pending = broker.prepare(
      { ...exportConfig("deadline"), preparationTimeoutMs: 5 },
      "token",
    );
    await drainUntil(() => harness.timer.getPendingTimeoutCount() > timeouts, {
      description: "deadline waiter subscription",
    });
    await drainUntilQuiescent(harness.timer);
    harness.timer.advanceTime(5);
    const result = await pending;
    expect(result.outcome).toBe("failed");
    expect((await harness.store.getRequest("deadline"))?.timing?.acquisition).toMatchObject({
      outcome: "failed",
      totalMs: 5,
    });
    finishReset.resolve("clean");
    await released;
    expect(await harness.store.timingSamples(0, harness.timer.now(), 5000)).toContainEqual(
      expect.objectContaining({
        timing: expect.objectContaining({
          acquisition: expect.objectContaining({ outcome: "failed", totalMs: 5 }),
        }),
      }),
    );
  });

  test("a capacity-parked reset does not delay a later acquisition", async () => {
    const { released } = await startRelease();
    finishReset.reject(
      new BootCapacityExhaustedError(
        { platform: "ios", limit: 1, booted: 1, retryAfterMs: 5000 },
        "capacity full",
      ),
    );
    expect((await released).outcome).toBe("cleanup_pending");
    const result = await broker.prepare(exportConfig("replacement"), "token");
    expect(result.outcome).toBe("ready");
    expect(result.timing?.acquisition?.admission).toBe("create");
  });

  test("an unsettled drain does not advertise a reset that has not started", async () => {
    const ready = await broker.prepare(exportConfig("drain"), "token");
    harness.devices.canRelease = false;
    expect((await broker.release(ready.sessionUuid!)).outcome).toBe("cleanup_pending");
    const result = await broker.prepare(exportConfig("replacement"), "token");
    expect(result.outcome).toBe("ready");
    expect(result.timing?.acquisition?.admission).toBe("create");
    harness.devices.canRelease = true;
  });

  test("readiness history read failure does not fail an acquisition", async () => {
    const { released } = await startRelease();
    const history = spyOn(harness.store, "timingSamples").mockRejectedValue(
      new Error("history unavailable"),
    );
    try {
      expect((await broker.prepare(exportConfig("hint-failure"), "token")).outcome).toBe("ready");
    } finally {
      history.mockRestore();
      finishReset.resolve("clean");
      await released;
    }
  });

  test("a cancelled waiter frees the in-process reservation", async () => {
    const { released } = await startRelease();
    const controller = new AbortController();
    const timeouts = harness.timer.getPendingTimeoutCount();
    const cancelled = broker.prepare(exportConfig("cancelled"), "token", controller.signal);
    await drainUntil(() => harness.timer.getPendingTimeoutCount() > timeouts, {
      description: "cancelled waiter subscription",
    });
    controller.abort(new Error("cancelled"));
    expect((await cancelled).outcome).toBe("failed");
    const next = broker.prepare(exportConfig("next-waiter"), "token");
    await drainUntil(() => harness.timer.getPendingTimeoutCount() > timeouts, {
      description: "replacement waiter subscription",
    });
    finishReset.resolve("clean");
    expect((await next).timing?.acquisition?.admission).toBe("reuse");
    await released;
  });

  test("replaying a pending request cannot free its original wait reservation", async () => {
    const { released } = await startRelease();
    const timeouts = harness.timer.getPendingTimeoutCount();
    const pending = broker.prepare(exportConfig("waiter"), "token");
    await drainUntil(() => harness.timer.getPendingTimeoutCount() > timeouts, {
      description: "original waiter subscription",
    });
    expect((await broker.prepare(exportConfig("waiter"), "token")).outcome).toBe("pending");
    expect(
      (await broker.prepare(exportConfig("other"), "token")).timing?.acquisition?.admission,
    ).toBe("create");
    finishReset.resolve("clean");
    expect((await pending).outcome).toBe("ready");
    await released;
  });

  test("broker recovery shutdown leaves a completed native reset pending without destroying it", async () => {
    const ready = await broker.prepare(exportConfig("recovery-shutdown"), "token");
    const request = (await harness.store.beginRelease(ready.sessionUuid!, harness.options.owner))!;
    const destroy = spyOn(harness.options.devices, "destroy");
    const destruction = spyOn(harness.store, "releaseByDestruction");
    let nativeSignal: AbortSignal | undefined;
    let nativeCompleted = false;
    harness.options.devices.managesResetBootSlots = true;
    harness.options.devices.reset = async (_resource, signal) => {
      nativeSignal = signal;
      await broker.markRestartHandoff();
      signal?.throwIfAborted();
      nativeCompleted = true;
      return "clean";
    };
    try {
      await broker.recover();
      await broker.joinReleases();
      expect(nativeSignal).toBeUndefined();
      expect(nativeCompleted).toBe(true);
      expect(destroy).not.toHaveBeenCalled();
      expect(destruction).not.toHaveBeenCalled();
      expect((await harness.store.getResource(request.resourceId!))?.state).toBe("resetting");
      expect((await harness.store.getRequest(request.requestId))?.state).toBe("releasing");
    } finally {
      destroy.mockRestore();
      destruction.mockRestore();
    }
  });
});
