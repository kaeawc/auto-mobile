import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DeviceLifecyclePreemptedError,
  InMemoryVirtualDeviceLifecycleCoordinator,
} from "../../src/utils/virtualDeviceLifecycleCoordinator";

describe("InMemoryVirtualDeviceLifecycleCoordinator", () => {
  test("teardown preempts start, provision, recovery, and shutdown work", async () => {
    for (const operation of ["start", "provision", "recovery", "shutdown"] as const) {
      const timer = new FakeTimer();
      const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
      const identity = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
      const competing = await coordinator.reserve(identity, {
        operation,
        deadlineMs: 1_000,
      });

      const teardownPromise = coordinator.reserve(identity, {
        operation: "teardown",
        deadlineMs: 1_000,
      });

      expect(competing.signal.aborted).toBe(true);
      expect(competing.signal.reason).toBeInstanceOf(DeviceLifecyclePreemptedError);
      let acquired = false;
      void teardownPromise.then(() => {
        acquired = true;
      });
      await Promise.resolve();
      expect(acquired).toBe(false);

      competing.release();
      const teardown = await teardownPromise;
      expect(teardown.signal.aborted).toBe(false);
      teardown.release();
    }
  });

  test("canonical binding retains exclusion while releasing the selector", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const provisioning = await coordinator.reserve(
      { kind: "selector", platform: "ios", selector: "iPhone 17" },
      { operation: "provision", deadlineMs: 1_000 },
    );

    await provisioning.bindCanonicalIdentity({
      platform: "ios",
      stableId: "11111111-2222-3333-4444-555555555555",
    });

    const teardownPromise = coordinator.reserve(
      {
        kind: "stable",
        platform: "ios",
        stableId: "11111111-2222-3333-4444-555555555555",
      },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    expect(provisioning.signal.aborted).toBe(true);

    provisioning.release();
    const teardown = await teardownPromise;
    teardown.release();

    const selectorReuse = await coordinator.reserve(
      { kind: "selector", platform: "ios", selector: "iPhone 17" },
      { operation: "provision", deadlineMs: 1_000 },
    );
    selectorReuse.release();
  });

  test("canonical binding retains teardown priority after a lease transfer", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const provisioning = await coordinator.reserve(
      { kind: "selector", platform: "ios", selector: "iPhone 17" },
      { operation: "provision", deadlineMs: 1_000 },
    );

    provisioning.transitionToTeardown();
    await provisioning.bindCanonicalIdentity({
      platform: "ios",
      stableId: "11111111-2222-3333-4444-555555555555",
    });
    const competingTeardown = coordinator.reserve(
      {
        kind: "stable",
        platform: "ios",
        stableId: "11111111-2222-3333-4444-555555555555",
      },
      { operation: "teardown", deadlineMs: 1_000 },
    );

    expect(provisioning.signal.aborted).toBe(false);
    provisioning.release();
    const teardown = await competingTeardown;
    teardown.release();
  });

  test("replaces a provision signal already preempted by teardown", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const provisioning = await coordinator.reserve(
      { kind: "stable", platform: "android", stableId: "Pixel_8" },
      { operation: "provision", deadlineMs: 1_000 },
    );
    const competingTeardown = coordinator.reserve(
      { kind: "stable", platform: "android", stableId: "Pixel_8" },
      { operation: "teardown", deadlineMs: 1_000 },
    );

    expect(provisioning.signal.aborted).toBe(true);
    timer.advanceTime(1_000);
    await expect(competingTeardown).rejects.toThrow("Timed out waiting to teardown");
    provisioning.transitionToTeardown();
    expect(provisioning.signal.aborted).toBe(false);

    provisioning.release();
  });

  test("does not carry a cancelled provision caller signal into teardown binding", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const caller = new AbortController();
    const provisioning = await coordinator.reserve(
      { kind: "selector", platform: "ios", selector: "iPhone 17" },
      { operation: "provision", deadlineMs: 1_000, signal: caller.signal },
    );
    const stableTeardown = await coordinator.reserve(
      {
        kind: "stable",
        platform: "ios",
        stableId: "11111111-2222-3333-4444-555555555555",
      },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    caller.abort(new Error("provision caller disconnected"));
    provisioning.transitionToTeardown();
    let bindingSettled = false;
    const binding = provisioning
      .bindCanonicalIdentity({
        platform: "ios",
        stableId: "11111111-2222-3333-4444-555555555555",
      })
      .finally(() => {
        bindingSettled = true;
      });

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(bindingSettled).toBe(false);

    stableTeardown.release();
    await binding;
    provisioning.release();
  });

  test("different stable identities remain concurrent", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const first = await coordinator.reserve(
      { kind: "stable", platform: "android", stableId: "Pixel_8" },
      { operation: "start", deadlineMs: 1_000 },
    );
    const second = await coordinator.reserve(
      { kind: "stable", platform: "android", stableId: "Pixel_9" },
      { operation: "start", deadlineMs: 1_000 },
    );

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    first.release();
    second.release();
  });

  test("waiting reservations honor their deadline", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const identity = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
    const owner = await coordinator.reserve(identity, {
      operation: "start",
      deadlineMs: 1_000,
    });
    const waiting = coordinator.reserve(identity, {
      operation: "start",
      deadlineMs: 10,
    });

    timer.advanceTime(10);
    await expect(waiting).rejects.toThrow("Timed out waiting to start android device 'Pixel_8'");
    owner.release();
  });
});
