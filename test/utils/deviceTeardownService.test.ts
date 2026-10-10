import { describe, expect, test } from "bun:test";
import {
  DeviceTeardownService,
  type DeviceTeardownPhase,
} from "../../src/devices/deviceTeardownService";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { ActionableError } from "../../src/models";

interface TestResponse {
  status: "destroyed" | "failed";
  phase?: DeviceTeardownPhase;
  error?: unknown;
}

const identity = { platform: "ios", stableId: "IOS-DEVICE-1" } as const;

function createService(timer: FakeTimer) {
  const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  return {
    coordinator,
    service: new DeviceTeardownService({
      lifecycleCoordinator: coordinator,
      timer,
    }),
  };
}

describe("DeviceTeardownService", () => {
  test("returns a typed timeout failure when destroy never settles", async () => {
    const timer = new FakeTimer();
    const { service } = createService(timer);
    const enteredDestroy = Promise.withResolvers<AbortSignal>();
    const stalledDestroy = Promise.withResolvers<void>();
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "stopped" as const,
      destroy: async (
        _target: string,
        signal: AbortSignal,
        retainLeaseUntil: (settlement: Promise<unknown>) => void,
      ) => {
        retainLeaseUntil(stalledDestroy.promise);
        enteredDestroy.resolve(signal);
        await stalledDestroy.promise;
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase, error: unknown) =>
        ({ status: "failed", phase, error }) as TestResponse,
    };

    const pending = service.teardown({ identity, deadlineMs: 100 }, workflow);
    const signal = await enteredDestroy.promise;
    timer.advanceTime(100);
    const result = await pending;
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(ActionableError);
    expect(result).toMatchObject({ status: "failed", phase: "destroy" });
    expect(result.error).toBe(signal.reason);
    stalledDestroy.resolve();
  });

  test("counts reservation wait against the teardown deadline", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    const heldLease = await coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "teardown", deadlineMs: 100 },
    );
    const enteredStop = Promise.withResolvers<AbortSignal>();
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async (_target: string, signal: AbortSignal) => {
        enteredStop.resolve(signal);
        return await new Promise<string>(() => {});
      },
      destroy: async () => {},
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase, error: unknown) =>
        ({ status: "failed", phase, error }) as TestResponse,
    };
    const pending = service.teardown(
      {
        identity,
        deadlineMs: 100,
      },
      workflow,
    );
    timer.advanceTime(60);
    heldLease.release();
    const signal = await enteredStop.promise;
    timer.advanceTime(39);
    expect(signal.aborted).toBe(false);
    timer.advanceTime(1);
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", phase: "stop" });
    expect(result.error).toBeInstanceOf(ActionableError);
  });

  test("clears the deadline timer after a successful teardown", async () => {
    const timer = new FakeTimer();
    const { service } = createService(timer);
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "stopped" as const,
      destroy: async () => {},
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
    };

    await expect(service.teardown({ identity, deadlineMs: 100 }, workflow)).resolves.toEqual({
      status: "destroyed",
    });
    expect(timer.getPendingTimeouts()).toEqual([]);
  });

  test("uses a transferred provision lease without preempting a queued provision", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    const provisionLease = await coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "provision", deadlineMs: 1_000 },
    );
    const queuedProvision = coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "provision", deadlineMs: 1_000 },
    );
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async () => {},
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
    };

    await expect(
      service.teardown(
        {
          identity,
          deadlineMs: 1_000,
          lifecycleLease: provisionLease,
        },
        workflow,
      ),
    ).resolves.toEqual({ status: "destroyed" });

    const nextProvision = await queuedProvision;
    expect(nextProvision.signal.aborted).toBe(false);
    nextProvision.release();
  });

  test("uses a live teardown signal after another teardown preempts provisioning", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    const provisionLease = await coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "provision", deadlineMs: 1_000 },
    );
    const competingTeardown = coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    expect(provisionLease.signal.aborted).toBe(true);
    let resolveLease: VirtualDeviceLifecycleLease | undefined;
    const workflow = {
      resolve: async (_signal: AbortSignal, lease: VirtualDeviceLifecycleLease) => {
        resolveLease = lease;
        return { target: "target" } as const;
      },
      stop: async () => "accepted" as const,
      destroy: async () => {},
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
    };

    await expect(
      service.teardown(
        {
          identity,
          deadlineMs: 1_000,
          lifecycleLease: provisionLease,
        },
        workflow,
      ),
    ).resolves.toEqual({ status: "destroyed" });

    expect(resolveLease?.signal.aborted).toBe(false);
    (await competingTeardown).release();
  });

  test("caller cancellation stops waiting without cancelling accepted teardown", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    let finishDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    let destroyCalls = 0;
    const controller = new AbortController();
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async () => {
        destroyCalls++;
        await destroyGate;
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
    };
    const request = {
      identity,
      deadlineMs: 1_000,
      callerSignal: controller.signal,
    };

    const firstCaller = service.teardown(request, workflow);
    await Promise.resolve();
    controller.abort(new Error("caller disconnected"));
    await expect(firstCaller).rejects.toThrow("caller disconnected");

    finishDestroy();
    await Promise.resolve();
    await Promise.resolve();
    // The accepted workflow finished on its own and released the lifecycle lease.
    const lease = await coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    lease.release();
    expect(destroyCalls).toBe(1);
  });

  test("cancel-on-caller-abort prevents a cooperative destroy from mutating", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    const controller = new AbortController();
    const destroyWaitingForAbort = Promise.withResolvers<void>();
    let mutations = 0;
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async (
        _target: string,
        signal: AbortSignal,
        _retainLeaseUntil: (settlement: Promise<unknown>) => void,
      ) => {
        await new Promise<void>((resolve, reject) => {
          const timeout = timer.setTimeout(() => {
            mutations++;
            resolve();
          }, 100);
          const abort = () => {
            timer.clearTimeout(timeout);
            reject(signal.reason);
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          destroyWaitingForAbort.resolve();
        });
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
    };
    const request = {
      identity,
      deadlineMs: 1_000,
      callerSignal: controller.signal,
      cancellationPolicy: "cancel-on-caller-abort" as const,
    };

    const caller = service.teardown(request, workflow);
    await destroyWaitingForAbort.promise;
    controller.abort(new Error("acceptance deadline elapsed"));
    await expect(caller).rejects.toThrow("acceptance deadline elapsed");

    const replacement = await coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "provision", deadlineMs: 1_000 },
    );
    replacement.release();
    await timer.advanceTimeAsync(200);

    expect(mutations).toBe(0);
  });

  test("cancel-on-caller-abort retains identity through non-cooperative destruction", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    const controller = new AbortController();
    const destroyWaitingForAbort = Promise.withResolvers<void>();
    let mutations = 0;
    let destroyCalls = 0;
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async (
        _target: string,
        signal: AbortSignal,
        retainLeaseUntil: (settlement: Promise<unknown>) => void,
      ) => {
        destroyCalls++;
        const platformMutation = new Promise<void>((resolve) => {
          timer.setTimeout(() => {
            mutations++;
            resolve();
          }, 100);
        });
        retainLeaseUntil(platformMutation);
        destroyWaitingForAbort.resolve();
        await platformMutation;
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
    };
    const request = {
      identity,
      deadlineMs: 1_000,
      callerSignal: controller.signal,
      cancellationPolicy: "cancel-on-caller-abort" as const,
    };

    const caller = service.teardown(request, workflow);
    await destroyWaitingForAbort.promise;
    controller.abort(new Error("acceptance deadline elapsed"));
    await expect(caller).rejects.toThrow("acceptance deadline elapsed");
    const replacement = coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "provision", deadlineMs: 1_000 },
    );
    let replacementAcquired = false;
    void replacement.then(() => {
      replacementAcquired = true;
    });
    await Promise.resolve();
    expect(replacementAcquired).toBe(false);

    await timer.advanceTimeAsync(100);
    const replacementLease = await replacement;
    replacementLease.release();

    expect(mutations).toBe(1);
    expect(destroyCalls).toBe(1);
  });

  test("teardown preempts recovery and waits for its platform command to settle", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    const recovery = await coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "recovery", deadlineMs: 1_000 },
    );
    let resolveStarted = false;
    const teardown = service.teardown(
      {
        identity,
        deadlineMs: 1_000,
      },
      {
        resolve: async () => {
          resolveStarted = true;
          return { target: "target" } as const;
        },
        stop: async () => "not_required" as const,
        destroy: async () => {},
        verify: async () => ({ status: "destroyed" }) as TestResponse,
        failure: (phase) => ({ status: "failed", phase }) as TestResponse,
      },
    );

    expect(recovery.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(resolveStarted).toBe(false);
    recovery.release();
    await expect(teardown).resolves.toEqual({ status: "destroyed" });
  });

  test("late deletion retains exclusion and reports destroy evidence", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    let finishLateDelete!: () => void;
    const lateDelete = new Promise<void>((resolve) => {
      finishLateDelete = resolve;
    });
    const request = {
      identity,
      deadlineMs: 1_000,
    };
    let destroyCalls = 0;
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async (
        _target: string,
        _signal: AbortSignal,
        retainLeaseUntil: (settlement: Promise<unknown>) => void,
      ) => {
        destroyCalls++;
        retainLeaseUntil(lateDelete);
        throw new Error("delete deadline elapsed");
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      failure: (phase) => ({ status: "failed", phase }) as TestResponse,
    };
    const teardown = service.teardown(request, workflow);
    await expect(teardown).resolves.toEqual({ status: "failed", phase: "destroy" });
    expect(destroyCalls).toBe(1);

    const start = coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "start", deadlineMs: 1_000 },
    );
    let startAcquired = false;
    void start.then(() => {
      startAcquired = true;
    });
    await Promise.resolve();
    expect(startAcquired).toBe(false);

    finishLateDelete();
    await Promise.resolve();
    const startLease = await start;
    startLease.release();
  });

  test("late shutdown retains exclusion until the platform command settles", async () => {
    const timer = new FakeTimer();
    const { coordinator, service } = createService(timer);
    let finishLateShutdown!: () => void;
    const lateShutdown = new Promise<void>((resolve) => {
      finishLateShutdown = resolve;
    });
    const teardown = service.teardown(
      {
        identity,
        deadlineMs: 1_000,
      },
      {
        resolve: async () => ({ target: "target" }) as const,
        stop: async (_target, _signal, retainLeaseUntil) => {
          retainLeaseUntil(lateShutdown);
          throw new Error("shutdown deadline elapsed");
        },
        destroy: async () => {},
        verify: async () => ({ status: "destroyed" }) as TestResponse,
        failure: (phase) => ({ status: "failed", phase }) as TestResponse,
      },
    );
    await expect(teardown).resolves.toEqual({ status: "failed", phase: "stop" });

    const start = coordinator.reserve(
      { kind: "stable", ...identity },
      { operation: "start", deadlineMs: 1_000 },
    );
    let startAcquired = false;
    void start.then(() => {
      startAcquired = true;
    });
    await Promise.resolve();
    expect(startAcquired).toBe(false);

    finishLateShutdown();
    await Promise.resolve();
    const startLease = await start;
    startLease.release();
  });
});
