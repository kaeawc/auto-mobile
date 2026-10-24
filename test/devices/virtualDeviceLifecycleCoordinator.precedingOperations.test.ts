import { describe, expect, test } from "bun:test";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
  type VirtualDeviceLifecycleOperation,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";

function harness() {
  const timer = new FakeTimer();
  const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  const identity: VirtualDeviceLifecycleIdentity = {
    kind: "stable",
    platform: "android",
    stableId: "Pixel",
  };
  const reserve = (
    operation: VirtualDeviceLifecycleOperation,
    target: VirtualDeviceLifecycleIdentity = identity,
    signal?: AbortSignal,
    deadlineMs = 1000,
  ) => coordinator.reserve(target, { operation, signal, deadlineMs });
  return { timer, coordinator, identity, reserve };
}

describe("lifecycle preceding operations", () => {
  test("immediate acquisition has no preceding operations", async () => {
    const h = harness();
    const lease = await h.reserve("start");
    expect(lease.precedingOperations).toEqual([]);
    lease.release();
    expect(h.coordinator.isReserved(h.identity)).toBe(false);
  });

  test("start queued behind shutdown records its release", async () => {
    const h = harness();
    const shutdown = await h.reserve("shutdown");
    const pending = h.reserve("start");
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    shutdown.release();
    const lease = await pending;
    expect(lease.precedingOperations).toEqual(["shutdown"]);
    lease.release();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("queued chain records release order and excludes releases before queueing", async () => {
    const h = harness();
    const first = await h.reserve("start");
    const secondPending = h.reserve("shutdown");
    const thirdPending = h.reserve("start");
    expect(h.timer.getPendingTimeoutCount()).toBe(2);
    first.release();
    const second = await secondPending;
    expect(second.precedingOperations).toEqual(["start"]);
    const latePending = h.reserve("start");
    second.release();
    const third = await thirdPending;
    expect(third.precedingOperations).toEqual(["start", "shutdown"]);
    third.release();
    const late = await latePending;
    expect(late.precedingOperations).toEqual(["shutdown", "start"]);
    late.release();
  });

  test("release records the owner's transitioned teardown operation", async () => {
    const h = harness();
    const first = await h.reserve("start");
    const pending = h.reserve("start");
    first.transitionToTeardown();
    first.release();
    const lease = await pending;
    expect(lease.precedingOperations).toEqual(["teardown"]);
    lease.release();
  });

  for (const cancellation of ["timeout", "abort"] as const) {
    test(`${cancellation} waiter never acquires or contributes a released operation`, async () => {
      const h = harness();
      const first = await h.reserve("shutdown");
      const controller = new AbortController();
      const cancelled = h.reserve("configure", h.identity, controller.signal, 10);
      const rejection = cancelled.catch((error: unknown) => error);
      const pending = h.reserve("start");
      if (cancellation === "timeout") {
        h.timer.advanceTime(10);
      } else {
        controller.abort();
      }
      expect(await rejection).toBeInstanceOf(Error);
      expect(h.timer.getPendingTimeoutCount()).toBe(1);
      first.release();
      const lease = await pending;
      expect(lease.precedingOperations).toEqual(["shutdown"]);
      lease.release();
      const fresh = await h.reserve("start");
      expect(fresh.precedingOperations).toEqual([]);
      fresh.release();
      expect(h.coordinator.isReserved(h.identity)).toBe(false);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    });
  }

  test("bindCanonicalIdentity appends each acquisition's wait history", async () => {
    const h = harness();
    const selector: VirtualDeviceLifecycleIdentity = {
      kind: "selector",
      platform: "android",
      selector: "named",
    };
    const selectorOwner = await h.reserve("configure", selector);
    const pending = h.reserve("start", selector);
    selectorOwner.release();
    const lease = await pending;
    const blocker = await h.reserve("shutdown");
    const canonical = { platform: "android" as const, stableId: "Pixel" };
    const binding = lease.bindCanonicalIdentity(canonical, async () => canonical);
    await drainUntil(() => h.timer.getPendingTimeoutCount() === 1, {
      description: "canonical wait",
    });
    expect(lease.precedingOperations).toEqual(["configure"]);
    blocker.release();
    await binding;
    expect(lease.precedingOperations).toEqual(["configure", "shutdown"]);
    await lease.bindCanonicalIdentity(canonical);
    expect(lease.precedingOperations).toEqual(["configure", "shutdown"]);
    lease.release();
    expect(h.coordinator.isReserved(selector)).toBe(false);
    expect(h.coordinator.isReserved(h.identity)).toBe(false);
  });

  test("teardown-priority waiters retain enqueue-relative release slices", async () => {
    const h = harness();
    const first = await h.reserve("start");
    const preempted = h.reserve("start");
    const rejection = preempted.catch((error: unknown) => error);
    const teardownPending = h.reserve("teardown");
    expect(await rejection).toBeInstanceOf(Error);
    const nextTeardownPending = h.reserve("teardown");
    const readPending = h.reserve("start");
    first.release();
    const teardown = await teardownPending;
    expect(teardown.precedingOperations).toEqual(["start"]);
    teardown.release();
    const nextTeardown = await nextTeardownPending;
    expect(nextTeardown.precedingOperations).toEqual(["start", "teardown"]);
    nextTeardown.release();
    const read = await readPending;
    expect(read.precedingOperations).toEqual(["start", "teardown", "teardown"]);
    read.release();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });
});
