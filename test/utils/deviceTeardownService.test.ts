import { describe, expect, test } from "bun:test";
import {
  DeviceTeardownService,
  type DeviceTeardownPhase,
} from "../../src/utils/deviceTeardownService";
import type { DeviceTeardownOperationStore } from "../../src/db/deviceTeardownOperationRepository";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";
import { FakeDeviceTeardownOperationStore } from "../fakes/FakeDeviceTeardownOperationStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

interface TestResponse {
  status: "destroyed" | "failed";
  phase?: DeviceTeardownPhase;
}

const identity = { platform: "ios", stableId: "IOS-DEVICE-1" } as const;

function createService(
  timer: FakeTimer,
  operationStore?: DeviceTeardownOperationStore,
  idGenerator?: CountingIdGenerator,
) {
  const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  return {
    coordinator,
    service: new DeviceTeardownService({
      lifecycleCoordinator: coordinator,
      operationStore,
      timer,
      resultTtlMs: 1_000,
      idGenerator,
    }),
  };
}

describe("DeviceTeardownService", () => {
  test("replays a terminal result after the service restarts", async () => {
    const timer = new FakeTimer();
    const operationStore = new FakeDeviceTeardownOperationStore();
    let destroyCalls = 0;
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async (
        _target: string,
        _signal: AbortSignal,
        _retainLeaseUntil: (settlement: Promise<unknown>) => void,
        markDestructionStarted: () => void,
      ) => {
        destroyCalls++;
        markDestructionStarted();
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      conflict: () => ({ status: "failed", phase: "precondition" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
      isFailure: (response: TestResponse) => response.status === "failed",
    };
    const request = {
      operationId: "operation-restart",
      fingerprint: "fingerprint",
      identity,
      deadlineMs: 1_000,
    };
    const first = createService(timer, operationStore).service;

    await expect(first.teardown(request, workflow)).resolves.toEqual({ status: "destroyed" });
    first.dispose();
    const restarted = createService(timer, operationStore).service;
    await expect(restarted.teardown(request, workflow)).resolves.toEqual({
      status: "destroyed",
    });

    expect(destroyCalls).toBe(1);
  });

  test("caller cancellation stops waiting without cancelling accepted teardown", async () => {
    const timer = new FakeTimer();
    const { service } = createService(timer);
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
      conflict: () => ({ status: "failed", phase: "precondition" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
      isFailure: (response: TestResponse) => response.status === "failed",
    };
    const request = {
      operationId: "operation-1",
      fingerprint: "fingerprint",
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
    const replay = await service.teardown({ ...request, callerSignal: undefined }, workflow);
    expect(replay).toEqual({ status: "destroyed" });
    expect(destroyCalls).toBe(1);
  });

  test("renews a running durable operation until its long teardown settles", async () => {
    const timer = new FakeTimer();
    const operationStore = new FakeDeviceTeardownOperationStore();
    const idGenerator = new CountingIdGenerator("owner");
    const first = createService(timer, operationStore, idGenerator).service;
    let finishDestroy!: () => void;
    const destroyGate = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async () => {
        await destroyGate;
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      conflict: () => ({ status: "failed", phase: "precondition" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
      isFailure: (response: TestResponse) => response.status === "failed",
    };
    const request = {
      operationId: "long-operation",
      fingerprint: "fingerprint",
      identity,
      deadlineMs: 1_000,
    };
    const pending = first.teardown(request, workflow);
    await Promise.resolve();
    await Promise.resolve();
    await timer.advanceTimeAsync(2_500);

    const restarted = createService(
      timer,
      operationStore,
      new CountingIdGenerator("replacement"),
    ).service;
    await expect(restarted.teardown(request, workflow)).resolves.toEqual({
      status: "failed",
      phase: "precondition",
    });

    finishDestroy();
    await expect(pending).resolves.toEqual({ status: "destroyed" });
  });

  test("retries a rejected renewal before the running record expires", async () => {
    class RejectFirstRenewalStore extends FakeDeviceTeardownOperationStore {
      renewCalls = 0;

      override async renew(
        ...args: Parameters<DeviceTeardownOperationStore["renew"]>
      ): Promise<boolean> {
        this.renewCalls++;
        if (this.renewCalls === 1) {
          throw new Error("temporary database error");
        }
        return await super.renew(...args);
      }
    }

    const timer = new FakeTimer();
    const operationStore = new RejectFirstRenewalStore();
    const first = createService(timer, operationStore, new CountingIdGenerator("owner")).service;
    const destroyGate = Promise.withResolvers<void>();
    let destroyCalls = 0;
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async () => {
        destroyCalls++;
        await destroyGate.promise;
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      conflict: () => ({ status: "failed", phase: "precondition" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
      isFailure: (response: TestResponse) => response.status === "failed",
    };
    const request = {
      operationId: "renewal-retry",
      fingerprint: "fingerprint",
      identity,
      deadlineMs: 1_000,
    };
    const pending = first.teardown(request, workflow);
    await Promise.resolve();
    await Promise.resolve();

    await timer.advanceTimeAsync(500);
    await timer.advanceTimeAsync(124);
    expect(operationStore.renewCalls).toBe(2);
    await timer.advanceTimeAsync(400);

    const restarted = createService(
      timer,
      operationStore,
      new CountingIdGenerator("replacement"),
    ).service;
    await expect(restarted.teardown(request, workflow)).resolves.toEqual({
      status: "failed",
      phase: "precondition",
    });
    expect(destroyCalls).toBe(1);

    destroyGate.resolve();
    await expect(pending).resolves.toEqual({ status: "destroyed" });
  });

  test("retries a stalled renewal without accepting a duplicate teardown", async () => {
    const firstRenewal = Promise.withResolvers<boolean>();
    class StalledRenewalStore extends FakeDeviceTeardownOperationStore {
      renewCalls = 0;

      override async renew(
        ...args: Parameters<DeviceTeardownOperationStore["renew"]>
      ): Promise<boolean> {
        this.renewCalls++;
        if (this.renewCalls === 1) {
          return await firstRenewal.promise;
        }
        return await super.renew(...args);
      }
    }

    const timer = new FakeTimer();
    const operationStore = new StalledRenewalStore();
    const first = createService(timer, operationStore, new CountingIdGenerator("owner")).service;
    const destroyGate = Promise.withResolvers<void>();
    let destroyCalls = 0;
    const workflow = {
      resolve: async () => ({ target: "target" }) as const,
      stop: async () => "accepted" as const,
      destroy: async () => {
        destroyCalls++;
        await destroyGate.promise;
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      conflict: () => ({ status: "failed", phase: "precondition" }) as TestResponse,
      failure: (phase: DeviceTeardownPhase) => ({ status: "failed", phase }) as TestResponse,
      isFailure: (response: TestResponse) => response.status === "failed",
    };
    const request = {
      operationId: "stalled-renewal",
      fingerprint: "fingerprint",
      identity,
      deadlineMs: 1_000,
    };
    const pending = first.teardown(request, workflow);
    await Promise.resolve();
    await Promise.resolve();

    await timer.advanceTimeAsync(500);
    await timer.advanceTimeAsync(62);
    await timer.advanceTimeAsync(124);
    expect(operationStore.renewCalls).toBe(2);
    await timer.advanceTimeAsync(400);

    const restarted = createService(
      timer,
      operationStore,
      new CountingIdGenerator("replacement"),
    ).service;
    await expect(restarted.teardown(request, workflow)).resolves.toEqual({
      status: "failed",
      phase: "precondition",
    });
    expect(destroyCalls).toBe(1);

    firstRenewal.resolve(true);
    await Promise.resolve();
    destroyGate.resolve();
    await expect(pending).resolves.toEqual({ status: "destroyed" });
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
        operationId: "operation-1",
        fingerprint: "fingerprint",
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
        conflict: () => ({ status: "failed" }) as TestResponse,
        failure: (phase) => ({ status: "failed", phase }) as TestResponse,
        isFailure: (response) => response.status === "failed",
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
      operationId: "operation-1",
      fingerprint: "fingerprint",
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
        markDestructionStarted: () => void,
      ) => {
        destroyCalls++;
        markDestructionStarted();
        retainLeaseUntil(lateDelete);
        throw new Error("delete deadline elapsed");
      },
      verify: async () => ({ status: "destroyed" }) as TestResponse,
      conflict: () => ({ status: "failed" }) as TestResponse,
      failure: (phase) => ({ status: "failed", phase }) as TestResponse,
      isFailure: (response) => response.status === "failed",
    };
    const teardown = service.teardown(request, workflow);
    await expect(teardown).resolves.toEqual({ status: "failed", phase: "destroy" });
    await expect(service.teardown(request, workflow)).resolves.toEqual({
      status: "failed",
      phase: "destroy",
    });
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
        operationId: "operation-late-shutdown",
        fingerprint: "fingerprint",
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
        conflict: () => ({ status: "failed" }) as TestResponse,
        failure: (phase) => ({ status: "failed", phase }) as TestResponse,
        isFailure: (response) => response.status === "failed",
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
