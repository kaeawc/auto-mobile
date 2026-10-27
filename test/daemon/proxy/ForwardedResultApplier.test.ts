import { describe, expect, test } from "bun:test";
import {
  ForwardedResultApplier,
  type ForwardedResultApplierDependencies,
} from "../../../src/daemon/proxy/ForwardedResultApplier";
import type { ForwardedResultContext } from "../../../src/daemon/proxy/ToolCallForwarder";
import { FakeTimer } from "../../fakes/FakeTimer";

type Binding = ForwardedResultApplierDependencies["sessionBinding"];

function createHarness(options: { foreign?: boolean; suspect?: unknown; hangMint?: boolean } = {}) {
  const events: string[] = [];
  const sessionBinding: Binding = {
    bindResultMintedDeviceSession: async (name: string) => {
      events.push(`mint:${name}`);
      if (options.hangMint) {
        await new Promise<void>(() => {});
      }
    },
    namesForeignOwnedSession: () => options.foreign === true,
    rememberSessionUuid: (name: string) => {
      events.push(`remember:${name}`);
    },
    bindForwardedSessionOnErrorResult: (name: string) => {
      events.push(`errorBind:${name}`);
    },
  };
  const timer = new FakeTimer();
  const applier = new ForwardedResultApplier({
    timer,
    releaseLedger: {
      retainAcquisitionReleaseEpoch: () => events.push("retain"),
      releaseAcquisitionReleaseEpoch: () => events.push("release"),
    },
    sessionBinding,
    port: {
      creditRoutedSession: () => events.push("credit"),
      rememberToolSelectionProfile: () => events.push("profile"),
      rememberActiveDeviceSession: () => events.push("active"),
      noteSuspectSessionResult: () => options.suspect as undefined,
      noteReleaseSurfacedBy: () => events.push("surfaced"),
      isDeviceBindingTool: (name) => name === "startDevice",
    },
  });
  return { applier, events, timer };
}

function context(overrides: Partial<ForwardedResultContext> = {}): ForwardedResultContext {
  return {
    name: "tapOn",
    callerArgs: {},
    forwardedArgs: { sessionUuid: "s1" },
    forwardedSessionUuid: "s1",
    callReleaseEpoch: 3,
    isSessionAcquisition: false,
    learnsResultSession: false,
    allowSuspectRetry: true,
    ...overrides,
  };
}

describe("ForwardedResultApplier", () => {
  test("a successful ordinary call remembers the forwarded session", async () => {
    const { applier, events } = createHarness();
    const applied = await applier.applyForwardedResult(context(), { content: [] });
    expect(applied).toEqual({ result: { content: [] }, forwardedSessionUuid: "s1" });
    expect(events).toEqual(["credit", "profile", "remember:tapOn", "active"]);
  });

  test("a foreign-owned session is not remembered", async () => {
    const { applier, events } = createHarness({ foreign: true });
    await applier.applyForwardedResult(context(), { content: [] });
    expect(events).toEqual(["credit", "profile", "active"]);
  });

  test("an acquisition binds the session the result minted", async () => {
    const { applier, events } = createHarness();
    await applier.applyForwardedResult(
      context({ name: "startDevice", isSessionAcquisition: true }),
      {
        content: [],
      },
    );
    expect(events).toEqual(["credit", "profile", "mint:startDevice"]);
  });

  test("an error result binds the forwarded session and notes the surfaced release", async () => {
    const { applier, events } = createHarness();
    const result = { isError: true, content: [] };
    const applied = await applier.applyForwardedResult(context(), result);
    expect(applied).toEqual({
      result,
      forwardedSessionUuid: "s1",
      retryableSuspectRefusal: undefined,
    });
    expect(events).toEqual(["credit", "errorBind:tapOn", "surfaced"]);
  });

  test("a failed provisionDevice still owns its minted session first", async () => {
    const { applier, events } = createHarness();
    await applier.applyForwardedResult(context({ name: "provisionDevice" }), {
      isError: true,
      content: [],
    });
    expect(events).toEqual([
      "credit",
      "mint:provisionDevice",
      "errorBind:provisionDevice",
      "surfaced",
    ]);
  });

  test("a task handle for a device-binding tool is deferred, not applied", () => {
    const { applier, events } = createHarness();
    const handle = { resultType: "task", taskId: "t1" };
    const frame = { ownerKey: "o", declared: true };
    expect(applier.deferredToTask(frame, handle, context({ name: "startDevice" }))).toBe(true);
    expect(applier.deviceBindingTasks?.isPending("t1")).toBe(true);
    expect(events).toEqual(["retain"]);
  });

  test("other results and calls without the relay are not deferred", () => {
    const { applier } = createHarness();
    const handle = { resultType: "task", taskId: "t1" };
    const frame = { ownerKey: "o", declared: true };
    expect(applier.deferredToTask(frame, handle, context({ name: "tapOn" }))).toBe(false);
    expect(applier.deferredToTask(undefined, handle, context({ name: "startDevice" }))).toBe(false);
    expect(applier.deferredToTask(frame, { content: [] }, context({ name: "startDevice" }))).toBe(
      false,
    );
    expect(applier.deviceBindingTasks).toBeUndefined();
  });

  test("a completed task applies the binding once without a suspect retry", async () => {
    const { applier, events } = createHarness();
    const frame = { ownerKey: "o", declared: true };
    applier.deferredToTask(
      frame,
      { resultType: "task", taskId: "t1" },
      context({ name: "startDevice", isSessionAcquisition: true }),
    );
    const bindings = applier.deviceBindingTasks!;
    const completed = { status: "completed", result: { content: [] } };
    await bindings.relayed("tasks/get", { taskId: "t1" }, Promise.resolve(completed));
    await bindings.relayed("tasks/get", { taskId: "t1" }, Promise.resolve(completed));
    expect(events.filter((event) => event === "mint:startDevice")).toHaveLength(1);
  });

  test("a binding stuck past the drain deadline is reported as abandoned", async () => {
    const { applier, timer } = createHarness({ hangMint: true });
    applier.deferredToTask(
      { ownerKey: "o", declared: true },
      { resultType: "task", taskId: "t1" },
      context({ name: "startDevice", isSessionAcquisition: true }),
    );
    expect(applier.deviceBindingTasksAbandoned).toBe(false);
    const bindings = applier.deviceBindingTasks!;
    void bindings.relayed(
      "tasks/get",
      { taskId: "t1" },
      Promise.resolve({ status: "completed", result: { content: [] } }),
    );
    await Promise.resolve();
    const drained = bindings.drain(50);
    await Promise.resolve();
    timer.advanceTime(50);
    await drained;
    expect(applier.deviceBindingTasksAbandoned).toBe(true);
  });
});
