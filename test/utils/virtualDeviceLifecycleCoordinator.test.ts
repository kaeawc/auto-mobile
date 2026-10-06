import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DeviceLifecyclePreemptedError,
  InMemoryVirtualDeviceLifecycleCoordinator,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";

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

  test("explicit teardown rejects queued lifecycle work before granting stale ownership", async () => {
    for (const ownerOperation of ["start", "teardown"] as const) {
      const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
      const identity = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
      const owner = await coordinator.reserve(identity, {
        operation: ownerOperation,
        deadlineMs: 1_000,
      });
      const queued = (["start", "provision", "recovery", "shutdown"] as const).map((operation) =>
        coordinator
          .reserve(identity, {
            operation,
            deadlineMs: 1_000,
          })
          .then(
            (lease) => {
              lease.release();
              return lease;
            },
            (error: unknown) => error,
          ),
      );
      const teardownPromise = coordinator.reserve(identity, {
        operation: "teardown",
        deadlineMs: 1_000,
      });
      owner.release();
      const teardown = await teardownPromise;
      teardown.release();
      for (const result of await Promise.all(queued)) {
        expect(result).toBeInstanceOf(DeviceLifecyclePreemptedError);
      }
      const fresh = await coordinator.reserve(identity, {
        operation: "provision",
        deadlineMs: 1_000,
      });
      expect(fresh.signal.aborted).toBe(false);
      fresh.release();
    }
  });

  test("teardown rejects stale canonical binding while preserving queued teardown", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const identity = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
    const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
    const selector = await coordinator.reserve(
      { kind: "selector", platform: "android", selector: "api-35" },
      { operation: "start", deadlineMs: 1_000 },
    );
    const binding = selector.bindCanonicalIdentity(identity).catch((error: unknown) => error);
    const firstTeardown = coordinator.reserve(identity, {
      operation: "teardown",
      deadlineMs: 1_000,
    });
    const secondTeardown = coordinator.reserve(identity, {
      operation: "teardown",
      deadlineMs: 1_000,
    });
    expect(await binding).toBeInstanceOf(DeviceLifecyclePreemptedError);
    expect(selector.signal.aborted).toBe(true);
    selector.release();
    owner.release();
    const first = await firstTeardown;
    expect(first.signal.aborted).toBe(false);
    first.release();
    const second = await secondTeardown;
    expect(second.signal.aborted).toBe(false);
    second.release();
  });

  test("expired or cancelled teardown does not preempt existing lifecycle work", async () => {
    for (const expired of [true, false]) {
      const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
      const identity = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
      const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
      const queued = coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
      const caller = new AbortController();
      if (!expired) {
        caller.abort(new Error("caller cancelled"));
      }
      await expect(
        coordinator.reserve(identity, {
          operation: "teardown",
          deadlineMs: expired ? 0 : 1_000,
          signal: caller.signal,
        }),
      ).rejects.toThrow(expired ? "Timed out waiting to teardown" : "caller cancelled");
      expect(owner.signal.aborted).toBe(false);
      owner.release();
      const next = await queued;
      expect(next.signal.aborted).toBe(false);
      next.release();
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

  test("canonical waiter releases its selector for unrelated work", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const stable = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
    const selector = { kind: "selector", platform: "android", selector: "phone" } as const;
    const owner = await coordinator.reserve(stable, { operation: "start", deadlineMs: 1_000 });
    const waiting = await coordinator.reserve(selector, { operation: "start", deadlineMs: 1_000 });
    const binding = waiting.bindCanonicalIdentity(stable, async () => stable);
    const unrelated = await coordinator.reserve(selector, {
      operation: "start",
      deadlineMs: 1_000,
    });
    expect(unrelated.signal.aborted).toBe(false);
    unrelated.release();
    owner.release();
    await binding;
    waiting.release();
  });

  test("opposite-order canonical binds make progress", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const first = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
    const second = { kind: "stable", platform: "android", stableId: "Pixel_9" } as const;
    const firstLease = await coordinator.reserve(first, { operation: "start", deadlineMs: 1_000 });
    const secondLease = await coordinator.reserve(second, {
      operation: "start",
      deadlineMs: 1_000,
    });
    await Promise.all([
      firstLease.bindCanonicalIdentity(second, async () => second),
      secondLease.bindCanonicalIdentity(first, async () => first),
    ]);
    firstLease.release();
    secondLease.release();
  });

  test("rejects an identity that changed during canonical wait", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const selected = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;
    const changed = { platform: "android", stableId: "Pixel_9" } as const;
    const owner = await coordinator.reserve(selected, { operation: "start", deadlineMs: 1_000 });
    const waiting = await coordinator.reserve(
      { kind: "selector", platform: "android", selector: "phone" },
      { operation: "start", deadlineMs: 1_000 },
    );
    let revalidated = false;
    const binding = waiting.bindCanonicalIdentity(selected, async () => {
      revalidated = true;
      return changed;
    });
    owner.release();
    await expect(binding).rejects.toThrow("Device identity changed while waiting");
    expect(revalidated).toBe(true);
    waiting.release();
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

test("read-only lifecycle reservation query includes a waiting successor", async () => {
  const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
  const identity = {
    kind: "stable",
    platform: "android",
    stableId: "observation-lease-query",
  } as const;
  expect(coordinator.isReserved(identity)).toBe(false);
  const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 100 });
  const next = coordinator.reserve(identity, { operation: "recovery", deadlineMs: 100 });
  expect(coordinator.isReserved(identity)).toBe(true);
  owner.release();
  expect(coordinator.isReserved(identity)).toBe(true);
  const successor = await next;
  successor.release();
  expect(coordinator.isReserved(identity)).toBe(false);
});

describe("device held by an unkillable process (#9920)", () => {
  const identity = { kind: "stable", platform: "android", stableId: "Pixel_8" } as const;

  test("refuses start, provision and configure at once, naming the pid", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
    owner.markHeldByUnkillableProcess?.(4242);

    for (const operation of ["start", "provision", "configure"] as const) {
      await expect(coordinator.reserve(identity, { operation, deadlineMs: 1_000 })).rejects.toThrow(
        "android device 'Pixel_8' is held by unkillable process 4242",
      );
    }
    // A refused request leaves nothing queued behind the owner.
    owner.release();
    expect(coordinator.isReserved(identity)).toBe(false);
  });

  test("rejects start work already queued behind the owner when the hold is recorded", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
    const queuedStart = coordinator
      .reserve(identity, { operation: "start", deadlineMs: 1_000 })
      .catch((error: unknown) => error);
    const queuedRecovery = coordinator.reserve(identity, {
      operation: "recovery",
      deadlineMs: 1_000,
    });
    await Promise.resolve();

    owner.markHeldByUnkillableProcess?.(undefined);

    expect(String(((await queuedStart) as Error).message)).toContain(
      "held by unkillable process (pid unknown)",
    );
    // Recovery and teardown are how the hold gets cleared, so they keep waiting.
    owner.release();
    (await queuedRecovery).release();
    expect(coordinator.isReserved(identity)).toBe(false);
  });

  test("lets teardown wait for the release as before", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
    owner.markHeldByUnkillableProcess?.(4242);

    let acquired = false;
    const teardown = coordinator
      .reserve(identity, { operation: "teardown", deadlineMs: 1_000 })
      .then((lease) => {
        acquired = true;
        return lease;
      });
    await Promise.resolve();
    expect(acquired).toBe(false);

    owner.release();
    (await teardown).release();
    expect(acquired).toBe(true);
  });

  test("ends the hold with the lease, so the next owner is not refused", async () => {
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    const owner = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
    owner.markHeldByUnkillableProcess?.(4242);
    owner.release();

    const next = await coordinator.reserve(identity, { operation: "start", deadlineMs: 1_000 });
    next.release();
  });
});
