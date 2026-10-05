import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { DeviceLostError, rememberDeviceLossAbort } from "../../src/models/DeviceLostError";
import { ActionableError } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

describe("CriticalSectionCoordinator", () => {
  let coordinator: CriticalSectionCoordinator;
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    // Inject a FakeTimer via the createForTesting seam so barrier timeouts,
    // cleanup delays, and now() are deterministic — no global setTimeout /
    // clearTimeout / Date.now patching (#4183 item 14).
    fakeTimer = new FakeTimer();
    coordinator = CriticalSectionCoordinator.createForTesting(fakeTimer);
  });

  afterEach(() => {
    coordinator.reset();
    fakeTimer.reset();
  });

  describe("abortable coordination", () => {
    for (const kind of ["barrier", "criticalSection"] as const) {
      const start = (signal: AbortSignal, device = "A") => {
        coordinator.registerExpectedDevices("abort-lock", 2);
        return kind === "barrier"
          ? coordinator.awaitBarrier("abort-lock", device, 2, 120000, undefined, signal)
          : coordinator.enterCriticalSection("abort-lock", device, 120000, undefined, signal);
      };

      for (const reasonMode of ["visible loss", "hidden loss", "hidden cancellation"] as const) {
        for (const alreadyAborted of [false, true]) {
          test(`${kind} resolves ${reasonMode} (${alreadyAborted ? "before arrival" : "parked waiter"})`, async () => {
            const controller = new AbortController();
            const loss = new DeviceLostError("A", "disconnected");
            if (reasonMode !== "visible loss") {
              Object.defineProperty(controller.signal, "reason", { get: () => undefined });
            }
            if (reasonMode !== "hidden cancellation") {
              rememberDeviceLossAbort(controller.signal, loss);
            }
            if (alreadyAborted) {
              controller.abort(loss);
            }
            const pending = start(controller.signal).then(
              () => "unexpected success",
              (error: unknown) => error,
            );
            if (!alreadyAborted) {
              controller.abort(loss);
            }
            const error = await pending;
            expect(error).toBeInstanceOf(Error);
            if (reasonMode === "hidden cancellation") {
              expect(error).toEqual(new Error("Operation cancelled"));
            } else {
              expect(error).toBe(loss);
            }
            expect(fakeTimer.getPendingTimeouts()).toEqual([]);
          });
        }
      }

      test(`${kind} abort removes only its waiter, arrival, timer and listener`, async () => {
        const controller = new AbortController();
        const reason = new Error("cancel coordination");
        const removed = spyOn(controller.signal, "removeEventListener");
        let error: unknown;
        let entered = false;
        const pending = start(controller.signal).then(
          () => {
            entered = true;
          },
          (rejection: unknown) => {
            error = rejection;
          },
        );
        controller.abort(reason);
        await drainMicrotasks(40);
        try {
          expect(error).toBe(reason);
          expect(entered).toBe(false);
          const state = coordinator as unknown as {
            barrierCounts: Map<string, Set<string>>;
            barrierResolvers: Map<string, unknown[]>;
          };
          expect(state.barrierCounts.get("abort-lock")?.has("A")).toBe(false);
          expect(state.barrierResolvers.get("abort-lock")).toHaveLength(0);
          expect(fakeTimer.getPendingTimeouts()).toEqual([]);
          expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
        } finally {
          coordinator.forceCleanup("abort-lock");
          await pending;
          removed.mockRestore();
        }
      });

      test(`${kind} rejects an already-aborted signal before arrival`, async () => {
        const controller = new AbortController();
        const reason = new Error("already cancelled");
        controller.abort(reason);
        let error: unknown;
        const pending = start(controller.signal).then(undefined, (rejection: unknown) => {
          error = rejection;
        });
        await drainMicrotasks(40);
        try {
          expect(error).toBe(reason);
          expect(fakeTimer.getPendingTimeouts()).toEqual([]);
        } finally {
          coordinator.forceCleanup("abort-lock");
          await pending;
        }
      });
    }

    test("an aborted arrival cannot satisfy peers; a replacement arrival can", async () => {
      const controller = new AbortController();
      const reason = new Error("A left");
      const a = coordinator
        .awaitBarrier("peers", "A", 3, 120000, undefined, controller.signal)
        .then(undefined, (error: unknown) => error);
      let entered = false;
      const b = coordinator.awaitBarrier("peers", "B", 3, 120000).then(() => {
        entered = true;
      });
      controller.abort(reason);
      await drainMicrotasks(40);
      expect(entered).toBe(false);
      expect(fakeTimer.getPendingTimeouts()).toEqual([120000]);
      const c = coordinator.awaitBarrier("peers", "C", 3, 120000);
      await drainMicrotasks(40);
      try {
        expect(entered).toBe(false);
        expect(await a).toBe(reason);
        await coordinator.awaitBarrier("peers", "D", 3, 120000);
        await Promise.all([b, c]);
        expect(entered).toBe(true);
      } finally {
        coordinator.forceCleanup("peers");
      }
    });

    test("abort after all arrivals but before continuation does not enter", async () => {
      const controller = new AbortController();
      const reason = new Error("release raced cancellation");
      coordinator.registerExpectedDevices("race", 2);
      const a = coordinator
        .enterCriticalSection("race", "A", 120000, undefined, controller.signal)
        .then(
          (release) => {
            release();
            return "entered";
          },
          (error: unknown) => error,
        );
      const b = coordinator.enterCriticalSection("race", "B", 120000);
      controller.abort(reason);
      const release = await b;
      release();
      expect(await a).toBe(reason);
    });

    test("hidden device loss while acquiring a mutex preserves the typed error", async () => {
      coordinator.registerExpectedDevices("hidden-mutex", 1);
      const releaseOwner = await coordinator.enterCriticalSection("hidden-mutex", "owner");
      const controller = new AbortController();
      const loss = new DeviceLostError("A", "disconnected");
      Object.defineProperty(controller.signal, "reason", { get: () => undefined });
      rememberDeviceLossAbort(controller.signal, loss);
      const pending = coordinator
        .enterCriticalSection("hidden-mutex", "A", 120000, undefined, controller.signal)
        .then(
          () => "unexpected success",
          (error: unknown) => error,
        );
      await drainMicrotasks(40);
      controller.abort(loss);
      const error = await pending;
      releaseOwner();
      expect(error).toBe(loss);
      const releaseNext = await coordinator.enterCriticalSection("hidden-mutex", "next");
      releaseNext();
    });

    test("abort while acquiring a mutex settles promptly and releases late acquisition", async () => {
      coordinator.registerExpectedDevices("mutex", 1);
      const ownerRelease = await coordinator.enterCriticalSection("mutex", "owner");
      const controller = new AbortController();
      const reason = new Error("mutex cancelled");
      let error: unknown;
      const pending = coordinator
        .enterCriticalSection("mutex", "A", 120000, undefined, controller.signal)
        .then(
          (release) => {
            release();
          },
          (rejection: unknown) => {
            error = rejection;
          },
        );
      await drainMicrotasks(40);
      controller.abort(reason);
      await drainMicrotasks(40);
      try {
        expect(error).toBe(reason);
        expect(fakeTimer.getPendingTimeouts()).toEqual([]);
      } finally {
        ownerRelease();
        await pending;
      }
      const next = await coordinator.enterCriticalSection("mutex", "next");
      next();
    });

    test("force cleanup rejects every peer after one waiter aborts", async () => {
      const controller = new AbortController();
      const reason = new Error("A cancelled");
      const a = coordinator
        .awaitBarrier("all-peers", "A", 4, 120000, undefined, controller.signal)
        .then(
          () => "entered",
          (error: unknown) => error,
        );
      const peers = ["B", "C"].map((device) =>
        coordinator.awaitBarrier("all-peers", device, 4, 120000).then(
          () => "entered",
          (error: unknown) => error,
        ),
      );
      controller.abort(reason);
      coordinator.forceCleanup("all-peers");
      expect(await a).toBe(reason);
      for (const peer of peers) {
        expect(await peer).toBeInstanceOf(ActionableError);
      }
      expect(fakeTimer.getPendingTimeouts()).toEqual([]);
    });

    for (const outcome of ["release", "timeout", "forceCleanup"] as const) {
      test(`barrier ${outcome} removes its abort listener`, async () => {
        const controller = new AbortController();
        const removed = spyOn(controller.signal, "removeEventListener");
        const pending = coordinator
          .awaitBarrier("listener", "A", 2, 50, undefined, controller.signal)
          .then(
            () => "released",
            (error: unknown) => error,
          );
        if (outcome === "release") {
          await coordinator.awaitBarrier("listener", "B", 2, 50);
        }
        if (outcome === "timeout") {
          fakeTimer.advanceTime(50);
        }
        if (outcome === "forceCleanup") {
          coordinator.forceCleanup("listener");
        }
        const result = await pending;
        expect(result).toEqual(outcome === "release" ? "released" : expect.any(Error));
        expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
        controller.abort(new Error("late abort"));
        coordinator.forceCleanup("listener");
        expect(fakeTimer.getPendingTimeouts()).toEqual([]);
        removed.mockRestore();
      });
    }
  });

  // Coordination tests never need to control time explicitly: the barrier lifts
  // synchronously when the last device arrives, and work/staggering sleeps just
  // need to resolve so concurrent promises make progress. Auto-advance resolves
  // those sleeps asynchronously while preserving deadline order, so a
  // still-held mutex's blocked work does not deadlock the test.
  const wait = async (ms: number): Promise<void> => {
    await fakeTimer.sleep(ms);
  };

  test("allows single device to immediately enter critical section", async () => {
    fakeTimer.enableAutoAdvance();
    coordinator.registerExpectedDevices("lock-1", 1);

    const start = fakeTimer.now();
    const release = await coordinator.enterCriticalSection("lock-1", "device-1");
    const elapsed = fakeTimer.now() - start;

    expect(elapsed).toBeLessThan(100); // Should not wait
    release();
  });

  test("waits for all devices to arrive at barrier before releasing any", async () => {
    fakeTimer.enableAutoAdvance();
    const lockName = "lock-2";
    const deviceCount = 3;
    coordinator.registerExpectedDevices(lockName, deviceCount);

    const arrivals: Array<{ deviceId: string; arrivedAt: number }> = [];
    const releases: Array<{ deviceId: string; releasedAt: number }> = [];

    // Start all devices concurrently
    const promises = ["device-1", "device-2", "device-3"].map(async (deviceId, index) => {
      // Stagger arrivals slightly
      await wait(index * 10);
      arrivals.push({ deviceId, arrivedAt: fakeTimer.now() });

      const release = await coordinator.enterCriticalSection(lockName, deviceId);
      releases.push({ deviceId, releasedAt: fakeTimer.now() });

      release();
    });

    await Promise.all(promises);

    // Verify all devices arrived
    expect(arrivals.length).toBe(3);

    // Verify all devices were released (barrier lifted)
    expect(releases.length).toBe(3);

    // Verify releases happened after all arrivals
    const lastArrival = Math.max(...arrivals.map((a) => a.arrivedAt));
    const firstRelease = Math.min(...releases.map((r) => r.releasedAt));
    expect(firstRelease).toBeGreaterThanOrEqual(lastArrival);
  });

  test("executes steps serially within critical section", async () => {
    fakeTimer.enableAutoAdvance();
    const lockName = "lock-3";
    const deviceCount = 2;
    coordinator.registerExpectedDevices(lockName, deviceCount);

    const executionLog: Array<{ deviceId: string; event: string; time: number }> = [];

    const deviceWork = async (deviceId: string) => {
      const release = await coordinator.enterCriticalSection(lockName, deviceId);

      executionLog.push({ deviceId, event: "start", time: fakeTimer.now() });
      await wait(20);
      executionLog.push({ deviceId, event: "end", time: fakeTimer.now() });

      release();
    };

    await Promise.all([deviceWork("device-1"), deviceWork("device-2")]);

    // Verify we have 4 events (start/end for each device)
    expect(executionLog.length).toBe(4);

    // Find which device went first
    const firstDevice = executionLog[0].deviceId;
    const secondDevice = executionLog.find((e) => e.deviceId !== firstDevice)!.deviceId;

    // Verify serial execution: first device must complete before second starts
    const firstDeviceEnd = executionLog.find(
      (e) => e.deviceId === firstDevice && e.event === "end",
    )!;
    const secondDeviceStart = executionLog.find(
      (e) => e.deviceId === secondDevice && e.event === "start",
    )!;

    expect(secondDeviceStart.time).toBeGreaterThanOrEqual(firstDeviceEnd.time);
  });

  test("times out if not all devices arrive at barrier", async () => {
    const lockName = "lock-4";
    coordinator.registerExpectedDevices(lockName, 3);

    // Only 2 devices arrive, one is missing
    const promise1 = coordinator.enterCriticalSection(lockName, "device-1", 100); // 100ms timeout
    const promise2 = coordinator.enterCriticalSection(lockName, "device-2", 100);

    const allPromises = Promise.all([promise1, promise2]);
    fakeTimer.advanceTime(100);
    await expect(allPromises).rejects.toThrow(/Timeout waiting for critical section/);
  });

  test("barrier timeout removes the waiter and its arrival before a later round", async () => {
    const lockName = "lock-timeout-clean-state";
    const firstRound = coordinator.awaitBarrier(lockName, "device-1", 2, 100);
    fakeTimer.advanceTime(100);
    await expect(firstRound).rejects.toThrow(/Timeout waiting for critical section/);

    const state = coordinator as unknown as {
      barrierCounts: Map<string, Set<string>>;
      barrierResolvers: Map<string, unknown[]>;
    };
    expect(state.barrierCounts.get(lockName)?.has("device-1")).toBe(false);
    expect(state.barrierResolvers.get(lockName)).toHaveLength(0);

    const device2 = coordinator.awaitBarrier(lockName, "device-2", 2, 100);
    let device2Entered = false;
    void device2.then((release) => {
      device2Entered = true;
    });
    await coordinator.awaitBarrier(lockName, "device-3", 2, 100);
    await device2;
    expect(device2Entered).toBe(true);
  });

  test("timeout error reports arrived/expected count and the default 30000ms duration", async () => {
    const lockName = "lock-timeout-body";
    coordinator.registerExpectedDevices(lockName, 2);

    // Only one of two devices arrives; use the default 30000ms barrier timeout so
    // the documented message body (arrived count + duration + guidance) is pinned.
    const promise = coordinator.enterCriticalSection(lockName, "device-1");
    fakeTimer.advanceTime(30000);

    await expect(promise).rejects.toThrow(
      /Timeout waiting for critical section "lock-timeout-body"\. 1\/2 devices arrived after 30000ms\. Missing devices may have failed or not reached the critical section\./,
    );
  });

  test("throws error if same device tries to enter twice before barrier passes", async () => {
    const lockName = "lock-5";
    coordinator.registerExpectedDevices(lockName, 2);

    // First device arrives at barrier (waiting for second device)
    const promise1 = coordinator.enterCriticalSection(lockName, "device-1", 100);

    // Same device tries to arrive again before barrier passes
    await expect(coordinator.enterCriticalSection(lockName, "device-1", 100)).rejects.toThrow(
      /already arrived at barrier/,
    );

    // Clean up: advance time to trigger timeout for the waiting device
    fakeTimer.advanceTime(100);
    await promise1.catch(() => {}); // Swallow the timeout error
  });

  test("throws error if expected device count is not registered", async () => {
    await expect(coordinator.enterCriticalSection("unregistered-lock", "device-1")).rejects.toThrow(
      /No expected device count registered/,
    );
  });

  test("throws error if invalid device count is registered", () => {
    expect(() => {
      coordinator.registerExpectedDevices("lock-6", 0);
    }).toThrow(/Invalid device count/);

    expect(() => {
      coordinator.registerExpectedDevices("lock-7", -1);
    }).toThrow(/Invalid device count/);
  });

  test("schedules cleanup after devices finish", async () => {
    fakeTimer.enableAutoAdvance();
    const lockName = "lock-8";
    coordinator.registerExpectedDevices(lockName, 2);

    // Run devices in parallel so they can pass the barrier
    await Promise.all([
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-1");
        release();
      })(),
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-2");
        release();
      })(),
    ]);

    // Note: Cleanup happens after 5 seconds in production
    // We can't easily test the automatic cleanup without waiting
    // Instead, we test force cleanup in a separate test
  });

  test("supports multiple independent locks concurrently", async () => {
    fakeTimer.enableAutoAdvance();
    coordinator.registerExpectedDevices("lock-A", 2);
    coordinator.registerExpectedDevices("lock-B", 2);

    const executionLog: string[] = [];

    const deviceWork = async (lockName: string, deviceId: string) => {
      const release = await coordinator.enterCriticalSection(lockName, deviceId);
      executionLog.push(`${lockName}:${deviceId}:start`);
      await wait(10);
      executionLog.push(`${lockName}:${deviceId}:end`);
      release();
    };

    // Run both locks concurrently
    await Promise.all([
      deviceWork("lock-A", "device-1"),
      deviceWork("lock-A", "device-2"),
      deviceWork("lock-B", "device-3"),
      deviceWork("lock-B", "device-4"),
    ]);

    // Verify all devices executed
    expect(executionLog.length).toBe(8);

    // Verify devices from different locks could interleave
    const lockAEvents = executionLog.filter((e) => e.startsWith("lock-A"));
    const lockBEvents = executionLog.filter((e) => e.startsWith("lock-B"));

    expect(lockAEvents.length).toBe(4);
    expect(lockBEvents.length).toBe(4);
  });

  test("forceCleanup immediately removes all lock state", async () => {
    const lockName = "lock-9";
    coordinator.registerExpectedDevices(lockName, 3);

    // Start one device
    const promise = coordinator.enterCriticalSection(lockName, "device-1", 200);

    // Force cleanup (simulating error scenario) must reject parked devices
    // synchronously without waiting for their barrier timeout.
    const timeBeforeCleanup = fakeTimer.now();
    let rejection: unknown;
    const handledPromise = promise.catch((error: unknown) => {
      rejection = error;
    });
    coordinator.forceCleanup(lockName);
    expect(fakeTimer.now()).toBe(timeBeforeCleanup);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rejection).toBeInstanceOf(ActionableError);
    expect(rejection).toMatchObject({ message: expect.stringContaining(lockName) });
    fakeTimer.advanceTime(200);
    await handledPromise;

    // After force cleanup, lock state is gone
    await expect(coordinator.enterCriticalSection(lockName, "device-2")).rejects.toThrow(
      /No expected device count registered/,
    );
  });

  test("clears barrier timeout when all devices arrive", async () => {
    const lockName = "lock-timeout-clear";
    coordinator.registerExpectedDevices(lockName, 2);

    // Both devices enter concurrently and release immediately. The barrier lifts
    // synchronously when the second device arrives, so no time advance is needed.
    await Promise.all([
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-1", 30000);
        release();
      })(),
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-2", 30000);
        release();
      })(),
    ]);

    // After all devices arrive, barrier timeouts should be cleared
    // Only cleanup timers (5000ms) should remain, not barrier timeouts (30000ms)
    const pendingTimeouts = fakeTimer.getPendingTimeouts();
    for (const timeout of pendingTimeouts) {
      expect(timeout).not.toBe(30000);
    }
  });

  test("allows lock reuse after all devices complete", async () => {
    fakeTimer.enableAutoAdvance();
    const lockName = "lock-reuse";

    // First round
    coordinator.registerExpectedDevices(lockName, 2);

    await Promise.all([
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-1");
        release();
      })(),
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-2");
        release();
      })(),
    ]);

    // Re-register for second round (without waiting for cleanup timer)
    coordinator.registerExpectedDevices(lockName, 2);

    // Second round should work without "already arrived" errors
    await Promise.all([
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-1");
        release();
      })(),
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-2");
        release();
      })(),
    ]);
  });

  test("handles reregistration of same lock after cleanup", async () => {
    fakeTimer.enableAutoAdvance();
    const lockName = "lock-10";

    // First round
    coordinator.registerExpectedDevices(lockName, 1);
    const release1 = await coordinator.enterCriticalSection(lockName, "device-1");
    release1();

    // Force cleanup
    coordinator.forceCleanup(lockName);

    // Second round - reregister with different device count
    coordinator.registerExpectedDevices(lockName, 2);

    const executionLog: string[] = [];
    await Promise.all([
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-2");
        executionLog.push("device-2");
        release();
      })(),
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-3");
        executionLog.push("device-3");
        release();
      })(),
    ]);

    expect(executionLog.length).toBe(2);
  });

  test("stale cleanup leaves a newer live barrier round intact", async () => {
    const lockName = "lock-stale-cleanup";
    coordinator.registerExpectedDevices(lockName, 2);

    const firstRound = Promise.all([
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-1");
        release();
      })(),
      (async () => {
        const release = await coordinator.enterCriticalSection(lockName, "device-2");
        release();
      })(),
    ]);
    await firstRound;

    // Reuse the registered lock before the previous round's cleanup delay.
    const secondDevice = coordinator.enterCriticalSection(lockName, "device-3", 10000);
    let secondDeviceSettled = false;
    const secondSettled = secondDevice.then(
      (release) => {
        secondDeviceSettled = true;
        release();
      },
      () => {
        secondDeviceSettled = true;
      },
    );

    fakeTimer.advanceTime(5001);
    expect(secondDeviceSettled).toBe(false);

    const thirdDevice = coordinator.enterCriticalSection(lockName, "device-4", 10000);
    const release4 = await thirdDevice;
    release4();
    await secondSettled;
  });

  test("non-stale cleanup still clears state after five seconds", async () => {
    const lockName = "lock-cleanup-current-generation";
    await coordinator.awaitBarrier(lockName, "device-1", 1);

    fakeTimer.advanceTime(5000);
    let device2Settled = false;
    const device2 = coordinator.awaitBarrier(lockName, "device-2", 2).then(() => {
      device2Settled = true;
    });
    expect(device2Settled).toBe(false);
    await coordinator.awaitBarrier(lockName, "device-3", 2);
    await device2;
    expect(device2Settled).toBe(true);
  });

  // Regression: the coordinator is a process-wide singleton, and the plan
  // execution lock defaults to scope "session" — so two DIFFERENT plans (from
  // different sessions) can run concurrently in one daemon. Before namespacing,
  // both plans keyed barrier state by the bare lock name, so a device from plan
  // B could satisfy plan A's barrier and release plan A's devices before plan
  // A's own devices arrived. The namespace (the plan's base session UUID) scopes
  // each plan's barrier so this cannot happen.
  describe("cross-plan namespace isolation", () => {
    // Yield the microtask queue so any synchronous barrier resolutions settle.
    const flush = async (): Promise<void> => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    test("WITHOUT a namespace, two plans reusing a lock name collide (documents the bug)", async () => {
      // Both "plans" use the bare lock "sync" with deviceCount 2. A device from
      // each plan arrives; with no namespace they share one barrier and 2/2 lifts
      // it — releasing devices that belong to different plans.
      let aReleased = false;
      let bReleased = false;

      const a1 = coordinator.awaitBarrier("sync", "planA-device-1", 2, 30000).then(() => {
        aReleased = true;
      });
      const b1 = coordinator.awaitBarrier("sync", "planB-device-1", 2, 30000).then(() => {
        bReleased = true;
      });

      await flush();

      // The shared bare-lock barrier saw 2 arrivals and released both — even
      // though neither plan actually had both of ITS devices present.
      expect(aReleased).toBe(true);
      expect(bReleased).toBe(true);
      await Promise.all([a1, b1]);
    });

    test("WITH a per-plan namespace, one plan's devices cannot satisfy another plan's barrier", async () => {
      let aReleased = false;
      let bReleased = false;

      // One device from each plan arrives at the same lock name but different
      // namespaces. Neither barrier should lift: each still needs its own second
      // device.
      const a1 = coordinator
        .awaitBarrier("sync", "planA-device-1", 2, 30000, "session-A")
        .then(() => {
          aReleased = true;
        });
      const b1 = coordinator
        .awaitBarrier("sync", "planB-device-1", 2, 30000, "session-B")
        .then(() => {
          bReleased = true;
        });

      await flush();
      expect(aReleased).toBe(false);
      expect(bReleased).toBe(false);

      // Plan A's second device arrives -> only plan A's barrier lifts.
      const a2 = coordinator.awaitBarrier("sync", "planA-device-2", 2, 30000, "session-A");
      await flush();
      expect(aReleased).toBe(true);
      expect(bReleased).toBe(false);

      // Plan B's second device arrives -> plan B's barrier lifts.
      const b2 = coordinator.awaitBarrier("sync", "planB-device-2", 2, 30000, "session-B");
      await flush();
      expect(bReleased).toBe(true);

      await Promise.all([a1, a2, b1, b2]);
    });

    test("forceCleanup on one plan does not wipe another plan's live barrier state", async () => {
      let aReleased = false;

      // Plan A parks one device at the barrier.
      const a1 = coordinator
        .awaitBarrier("sync", "planA-device-1", 2, 30000, "session-A")
        .then(() => {
          aReleased = true;
        });
      await flush();

      // Plan B (same lock name, different namespace) hits an error and force-
      // cleans up ITS scope. This must not disturb plan A's waiting device.
      coordinator.forceCleanup("sync", "session-B");
      await flush();
      expect(aReleased).toBe(false);

      // Plan A's second device still completes the barrier normally.
      const a2 = coordinator.awaitBarrier("sync", "planA-device-2", 2, 30000, "session-A");
      await flush();
      expect(aReleased).toBe(true);

      await Promise.all([a1, a2]);
    });

    test("critical-section mutexes are isolated per namespace (concurrent, not serialized, across plans)", async () => {
      // Two plans each run a single-device critical section under the same lock
      // name. With per-plan namespaces they use different mutexes, so plan B does
      // not block on plan A's still-held lock.
      coordinator.registerExpectedDevices("edit", 1, "session-A");
      coordinator.registerExpectedDevices("edit", 1, "session-B");

      const releaseA = await coordinator.enterCriticalSection("edit", "A-d1", 30000, "session-A");
      // Plan B can still acquire its own namespaced lock while A holds A's.
      const releaseB = await coordinator.enterCriticalSection("edit", "B-d1", 30000, "session-B");

      // Both acquired independently.
      expect(typeof releaseA).toBe("function");
      expect(typeof releaseB).toBe("function");
      releaseA();
      releaseB();
    });
  });
});
