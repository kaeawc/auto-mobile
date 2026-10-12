import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { acquireManagedSlotsThroughDaemon } from "../../src/daemon/managedSlotProxyAcquisition";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { MANAGED_EXECUTION_RELEASE_TIMEOUT_MS } from "../../src/daemon/managedExecutionLiveness";
import { DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD } from "../../src/daemon/constants";
import { parseManagedSlotConfig } from "../../src/models/managedSlotConfig";
import { logger } from "../../src/utils/logger";
import type { ManagedSlotProxyAcquisitionPorts } from "../../src/daemon/managedSlotProxyAcquisition";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

const SESSION = "session-1";
const PREPARATION_TIMEOUT_MS = 100;
const TOKEN = "proxy-owner";

const CONFIG = parseManagedSlotConfig({
  contractVersion: 1,
  managedHostScope: "host",
  runnerNamespace: "runner",
  runnerIncarnation: "incarnation",
  localSlotCapacity: 1,
  preparationTimeoutMs: PREPARATION_TIMEOUT_MS,
  requests: [
    {
      slotIndex: 0,
      role: "app",
      platform: "ios",
      requestedSpec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      },
    },
  ],
});

const READY_RESULT = readyManagedSlotsResult(SESSION);

async function requireSettled<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await drainMicrotasks(48);
  expect(settled).toBe(true);
  return await pending;
}

interface AcquisitionRig {
  timer: FakeTimer;
  ports: ManagedSlotProxyAcquisitionPorts;
  calls: string[];
  tracked: string[][];
  trackedWhenHeld: string[][];
  holds: Array<{ id: string; signal: AbortSignal }>;
  releaseCalls: number;
  setReply(reply: unknown): void;
}

function rig(
  options: {
    hold?: (id: string, signal: AbortSignal) => Promise<void>;
    release?: () => Promise<void>;
    acquireReply?: () => Promise<unknown>;
    onTrack?: () => void;
    onAcquireReply?: () => void;
    enforceReplyDeadline?: boolean;
  } = {},
): AcquisitionRig {
  const timer = new FakeTimer();
  const calls: string[] = [];
  const tracked: string[][] = [];
  const trackedWhenHeld: string[][] = [];
  const holds: Array<{ id: string; signal: AbortSignal }> = [];
  let releaseCalls = 0;
  let reply: unknown = READY_RESULT;
  const ports: ManagedSlotProxyAcquisitionPorts = {
    ensureConnected: async () => {},
    callDaemonMethod: async (method, _params, callOptions) => {
      calls.push(method);
      if (method === "daemon/capabilities") {
        return { capabilities: ["managed-slots/v1"] };
      }
      if (options.acquireReply) {
        const rawReply =
          options.enforceReplyDeadline === false
            ? await options.acquireReply()
            : await raceWithDeadline(() => options.acquireReply?.() ?? Promise.resolve(reply), {
                timer,
                timeoutMs: callOptions.timeoutMs,
                signal: callOptions.signal,
                label: "test daemon acquisition",
                timeoutError: () =>
                  new McpTimeoutError({
                    toolName: DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
                    timeoutMs: callOptions.timeoutMs,
                    origin: "managedSlotProxyAcquisitionHoldDeadline.test",
                  }),
              });
        options.onAcquireReply?.();
        return rawReply;
      }
      options.onAcquireReply?.();
      return reply;
    },
    trackAcquiredSessions: (ids) => {
      tracked.push([...ids]);
      options.onTrack?.();
    },
    holdSession: (id, signal) => {
      holds.push({ id, signal });
      trackedWhenHeld.push(tracked.flatMap((ids) => ids));
      return options.hold ? options.hold(id, signal) : Promise.resolve();
    },
    releaseHeldSessions: () => {
      releaseCalls++;
      return options.release ? options.release() : Promise.resolve();
    },
    livenessOwnerToken: TOKEN,
    timer,
  };
  return {
    timer,
    ports,
    calls,
    tracked,
    trackedWhenHeld,
    holds,
    get releaseCalls() {
      return releaseCalls;
    },
    setReply(nextReply) {
      reply = nextReply;
    },
  };
}

describe("managed slot proxy acquisition hold deadline", () => {
  const warnings: ReturnType<typeof spyOn>[] = [];

  afterEach(() => {
    for (const warning of warnings.splice(0)) {
      warning.mockRestore();
    }
  });

  function silenceWarnings(): void {
    warnings.push(spyOn(logger, "warn").mockImplementation(() => {}));
  }

  test("a stalled hold times out retryably, nulls slot sessions, releases once, and aborts the hold signal", async () => {
    silenceWarnings();
    const parked = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parked.promise });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);

    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    expect(testRig.tracked).toEqual([[SESSION]]);
    testRig.timer.advanceTime(PREPARATION_TIMEOUT_MS);
    await drainUntil(
      () => testRig.releaseCalls === 1 && testRig.holds[0]?.signal.aborted === true,
      { description: "timed out hold is released and aborted" },
    );
    const result = await requireSettled(pending);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("timeout");
    expect(result.failure?.retryable).toBe(true);
    expect(result.slots.map((slot) => slot.sessionUuid)).toEqual([null]);
    expect(testRig.releaseCalls).toBe(1);
    expect(testRig.holds[0]?.signal.aborted).toBe(true);
    parked.resolve();
    await drainMicrotasks(8);
  });

  test("an abort while hold is parked cancels, releases once, and aborts the hold signal", async () => {
    silenceWarnings();
    const parked = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parked.promise });
    const controller = new AbortController();
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports, controller.signal);

    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    controller.abort();
    await drainUntil(
      () => testRig.releaseCalls === 1 && testRig.holds[0]?.signal.aborted === true,
      { description: "cancelled hold is released and aborted" },
    );
    const result = await requireSettled(pending);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("cancelled");
    expect(result.slots.map((slot) => slot.sessionUuid)).toEqual([null]);
    expect(testRig.releaseCalls).toBe(1);
    parked.resolve();
    await drainMicrotasks(8);
  });

  test("tracks ready session ids synchronously after reply before starting any hold", async () => {
    const parkedReply = Promise.withResolvers<unknown>();
    const testRig = rig({ acquireReply: () => parkedReply.promise });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);

    await drainUntil(() => testRig.calls.includes(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD), {
      description: "daemon acquisition starts",
    });
    expect(testRig.tracked).toEqual([]);
    parkedReply.resolve(READY_RESULT);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });

    expect(testRig.tracked).toEqual([[SESSION]]);
    expect(testRig.trackedWhenHeld).toEqual([[SESSION]]);
    expect(testRig.holds.map((hold) => hold.id)).toEqual([SESSION]);
    expect((await requireSettled(pending)).outcome).toBe("ready");
    expect(testRig.releaseCalls).toBe(0);
  });

  test("abort at the ready reply tracks sessions before returning and skips holds", async () => {
    silenceWarnings();
    const parkedReply = Promise.withResolvers<unknown>();
    const controller = new AbortController();
    const testRig = rig({
      acquireReply: () => parkedReply.promise,
      onAcquireReply: () => controller.abort(),
      enforceReplyDeadline: false,
    });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports, controller.signal);
    await drainUntil(() => testRig.calls.includes(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD), {
      description: "daemon acquisition starts",
    });
    parkedReply.resolve(READY_RESULT);
    const result = await requireSettled(pending);

    expect(testRig.tracked).toEqual([[SESSION]]);
    expect(testRig.holds).toEqual([]);
    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("cancelled");
    expect(result.slots.map((slot) => slot.sessionUuid)).toEqual([null]);
    expect(testRig.releaseCalls).toBe(1);
  });

  test("late hold success cannot restore ready state or release twice", async () => {
    silenceWarnings();
    const parked = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parked.promise });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    testRig.timer.advanceTime(PREPARATION_TIMEOUT_MS);
    const result = await requireSettled(pending);
    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("timeout");
    parked.resolve();
    await drainMicrotasks(12);

    expect(result.outcome).toBe("failed");
    expect(testRig.releaseCalls).toBe(1);
    expect(testRig.calls).toEqual(["daemon/capabilities", DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD]);
  });

  test("late hold failure cannot replace timeout failure, release twice, or call the daemon again", async () => {
    silenceWarnings();
    const parked = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parked.promise });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    testRig.timer.advanceTime(PREPARATION_TIMEOUT_MS);
    const result = await requireSettled(pending);
    parked.reject(new Error("late hold error"));
    await drainMicrotasks(12);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("timeout");
    expect(testRig.releaseCalls).toBe(1);
    expect(testRig.calls).toEqual(["daemon/capabilities", DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD]);
  });

  test("a hold that resolves after cancellation does not return ready", async () => {
    silenceWarnings();
    const parked = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parked.promise });
    const controller = new AbortController();
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports, controller.signal);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    controller.abort();
    parked.resolve();
    const result = await requireSettled(pending);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("cancelled");
    expect(result.slots.map((slot) => slot.sessionUuid)).toEqual([null]);
    expect(testRig.releaseCalls).toBe(1);
  });

  test("a parked release is bounded and a release rejection preserves the hold failure", async () => {
    silenceWarnings();
    const parkedHold = Promise.withResolvers<void>();
    const parkedRelease = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parkedHold.promise, release: () => parkedRelease.promise });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    parkedHold.reject(new Error("claim refused"));
    await drainUntil(() => testRig.releaseCalls === 1, {
      description: "held sessions release starts",
    });
    testRig.timer.advanceTime(MANAGED_EXECUTION_RELEASE_TIMEOUT_MS);
    const result = await requireSettled(pending);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("execution_hold_failed");
    expect(result.failure?.message).toContain("claim refused");
    expect(testRig.releaseCalls).toBe(1);
    parkedRelease.reject(new Error("late release failure"));
    await drainMicrotasks(8);
    expect(result.failure?.code).toBe("execution_hold_failed");
  });

  test("successful holds preserve result identity and never release", async () => {
    const expected = READY_RESULT;
    const testRig = rig();
    testRig.setReply(expected);

    const result = await acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);

    expect(result).toBe(expected);
    expect(testRig.tracked).toEqual([[SESSION]]);
    expect(testRig.holds.map((hold) => hold.id)).toEqual([SESSION]);
    expect(testRig.releaseCalls).toBe(0);
  });

  test("a timeout with a parked release returns timeout once the release bound elapses", async () => {
    silenceWarnings();
    const parkedHold = Promise.withResolvers<void>();
    const parkedRelease = Promise.withResolvers<void>();
    const testRig = rig({ hold: () => parkedHold.promise, release: () => parkedRelease.promise });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    testRig.timer.advanceTime(PREPARATION_TIMEOUT_MS);
    await drainUntil(() => testRig.releaseCalls === 1, { description: "timeout release starts" });
    let result: Awaited<typeof pending> | undefined;
    void pending.then((value) => {
      result = value;
    });
    testRig.timer.advanceTime(MANAGED_EXECUTION_RELEASE_TIMEOUT_MS - 1);
    await drainMicrotasks(48);
    expect(result).toBeUndefined();
    testRig.timer.advanceTime(1);
    expect(await requireSettled(pending)).toMatchObject({
      outcome: "failed",
      failure: { code: "timeout", retryable: true },
    });
    expect(testRig.releaseCalls).toBe(1);
    expect(testRig.holds[0]?.signal.aborted).toBe(true);
    parkedRelease.resolve();
    parkedHold.resolve();
    await drainMicrotasks(12);
    expect(testRig.releaseCalls).toBe(1);
  });

  test("a release rejection after timeout still returns the typed timeout failure", async () => {
    silenceWarnings();
    const parkedHold = Promise.withResolvers<void>();
    const testRig = rig({
      hold: () => parkedHold.promise,
      release: async () => {
        throw new Error("release refused");
      },
    });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);
    await drainUntil(() => testRig.holds.length === 1, { description: "session hold starts" });
    testRig.timer.advanceTime(PREPARATION_TIMEOUT_MS);
    expect(await requireSettled(pending)).toMatchObject({
      outcome: "failed",
      failure: { code: "timeout", retryable: true },
    });
    expect(testRig.releaseCalls).toBe(1);
    parkedHold.resolve();
    await drainMicrotasks(12);
  });

  test("an in-time hold rejection yields execution_hold_failed and releases once", async () => {
    silenceWarnings();
    const testRig = rig({ hold: async () => Promise.reject(new Error("hold rejected")) });

    const result = await acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("execution_hold_failed");
    expect(result.failure?.message).toContain("hold rejected");
    expect(result.slots.map((slot) => slot.sessionUuid)).toEqual([null]);
    expect(testRig.releaseCalls).toBe(1);
  });

  test("pre-reply timeout and cancellation do not track or release sessions", async () => {
    for (const cancelled of [false, true]) {
      silenceWarnings();
      const parkedReply = Promise.withResolvers<unknown>();
      const testRig = rig({ acquireReply: () => parkedReply.promise });
      const controller = new AbortController();
      const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports, controller.signal);
      await drainUntil(() => testRig.calls.includes(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD), {
        description: "daemon acquisition starts",
      });
      if (cancelled) {
        controller.abort();
      } else {
        testRig.timer.advanceTime(PREPARATION_TIMEOUT_MS);
      }
      const result = await requireSettled(pending);

      expect(result.outcome).toBe("failed");
      expect(result.failure?.code).toBe(cancelled ? "cancelled" : "timeout");
      expect(testRig.tracked).toEqual([]);
      expect(testRig.releaseCalls).toBe(0);
      expect(testRig.holds).toEqual([]);
      parkedReply.resolve(READY_RESULT);
      await drainMicrotasks(8);
    }
  });

  test("a ready reply at the preparation deadline is tracked and released without starting a hold", async () => {
    silenceWarnings();
    const parkedReply = Promise.withResolvers<unknown>();
    const testRig = rig({
      acquireReply: () => parkedReply.promise,
      enforceReplyDeadline: false,
    });
    const pending = acquireManagedSlotsThroughDaemon(CONFIG, testRig.ports);
    await drainUntil(() => testRig.calls.includes(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD), {
      description: "daemon acquisition starts",
    });
    testRig.timer.setCurrentTime(PREPARATION_TIMEOUT_MS);
    parkedReply.resolve(READY_RESULT);
    const result = await requireSettled(pending);

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("timeout");
    expect(testRig.tracked).toEqual([[SESSION]]);
    expect(testRig.holds).toEqual([]);
    expect(testRig.releaseCalls).toBe(1);
  });
});
