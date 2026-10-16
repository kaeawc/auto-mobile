import { describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { NoOpPerformanceTracker } from "../../src/utils/PerformanceTracker";
import {
  createFakeBuilder,
  createManagerWithFakeHealthClient,
  deferred,
  installIosManagerSuiteHooks,
} from "../helpers/iosCtrlProxyManagerHarness";

describe("IOSCtrlProxyManager service port and force restart", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  installIosManagerSuiteHooks((ctx) => {
    testDevice = ctx.testDevice;
    fakeTimer = ctx.fakeTimer;
  });

  describe("getServicePort", function () {
    test("should return default port 8765", function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      expect(manager.getServicePort()).toBe(8765);
    });
  });

  describe("forceRestart", function () {
    test("replaces a joined startup when the runner exits during WebSocket initialization", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        new FakeProcessExecutor(),
      );
      const internal = manager as unknown as {
        startInternal(start: { controller: AbortController }): Promise<void>;
        completeHealthStartup(
          start: { controller: AbortController },
          perf: NoOpPerformanceTracker,
        ): Promise<void>;
        cancelAndAwaitSharedStart(): Promise<void>;
        retireRunnerAfterFinalSharedStartCancellation(): Promise<void>;
        uninstallLegacyAppIfPresent(): Promise<void>;
        sharedStart: { externalWaitingCallers: number } | null;
        processSupervisor: { processExited(): void };
      };
      let launches = 0;
      spyOn(internal, "startInternal").mockImplementation(async (start) => {
        launches++;
        if (launches === 1) {
          await internal.completeHealthStartup(start, new NoOpPerformanceTracker());
        }
      });
      spyOn(internal, "retireRunnerAfterFinalSharedStartCancellation").mockResolvedValue();
      spyOn(internal, "uninstallLegacyAppIfPresent").mockResolvedValue();
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const stop = spyOn(manager, "stop").mockImplementation(() =>
        internal.cancelAndAwaitSharedStart(),
      );
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);

      const firstStart = manager.start();
      const firstFailure = firstStart.catch((error: Error) => error.message);
      for (let i = 0; i < 20 && fakeTimer.getSleepHistory().length === 0; i++) {
        await Promise.resolve();
      }
      expect(fakeTimer.getSleepHistory()).toContain(500);
      const autoSetup = manager.setup();
      for (let i = 0; i < 20 && internal.sharedStart?.externalWaitingCallers !== 2; i++) {
        await Promise.resolve();
      }
      expect(internal.sharedStart?.externalWaitingCallers).toBe(2);
      const recovery = manager.forceRestart({ joinInFlightStart: true });
      internal.processSupervisor.processExited();
      await fakeTimer.advanceTimeAsync(500);

      await recovery;
      expect(await firstFailure).toBe("iOS CtrlProxy runner exited during startup");
      expect(await autoSetup).toMatchObject({
        success: false,
        error: "iOS CtrlProxy runner exited during startup",
        recoveryInterrupted: true,
      });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(launches).toBe(2);
      expect(manager.getRunnerGeneration()).toBe(1);
    });

    test("reconnect restart joins auto-setup and supervisor startup after runner exit", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        new FakeProcessExecutor(),
      );
      const internal = manager as unknown as {
        startInternal(start: { controller: AbortController }): Promise<void>;
        cancelAndAwaitSharedStart(): Promise<void>;
        processSupervisor: { processExited(): void };
      };
      const startup = deferred();
      let launches = 0;
      let startupSignal: AbortSignal | undefined;
      spyOn(internal, "startInternal").mockImplementation(async (start) => {
        launches++;
        startupSignal = start.controller.signal;
        await startup.promise;
        if (start.controller.signal.aborted) {
          throw start.controller.signal.reason;
        }
      });
      spyOn(manager, "stop").mockImplementation(() => internal.cancelAndAwaitSharedStart());
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);

      internal.processSupervisor.processExited();
      await Promise.resolve();
      const autoSetup = manager.start();
      const autoSetupOutcome = autoSetup.then(
        () => "started",
        () => "cancelled",
      );
      for (let i = 0; i < 8 && launches === 0; i++) {
        await Promise.resolve();
      }
      expect(launches).toBe(1);
      const originalPort = manager.getServicePort();
      await fakeTimer.advanceTimeAsync(2_000);
      const reconnectRestart = manager.forceRestart({
        joinInFlightStart: true,
      });
      try {
        await Promise.resolve();
        expect(startupSignal?.aborted).toBe(false);
        expect(launches).toBe(1);
        startup.resolve();
        await Promise.all([autoSetup, reconnectRestart]);
        await expect(autoSetupOutcome).resolves.toBe("started");
        expect(launches).toBe(1);
        expect(manager.getServicePort()).toBe(originalPort);
      } finally {
        startup.resolve();
        await Promise.allSettled([autoSetup, reconnectRestart]);
      }
    });

    test("reconnect restart replaces a startup that remains wedged past its health deadline", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        new FakeProcessExecutor(),
      );
      const internal = manager as unknown as {
        startInternal(start: { controller: AbortController }): Promise<void>;
        cancelAndAwaitSharedStart(): Promise<void>;
      };
      let launches = 0;
      spyOn(internal, "startInternal").mockImplementation(async (start) => {
        launches++;
        if (launches === 1) {
          await new Promise<void>((_resolve, reject) => {
            start.controller.signal.addEventListener(
              "abort",
              () => reject(start.controller.signal.reason),
              { once: true },
            );
          });
        }
      });
      spyOn(manager, "stop").mockImplementation(() => internal.cancelAndAwaitSharedStart());
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);

      const firstStart = manager.start();
      const firstFailure = firstStart.catch((error: Error) => error.message);
      for (let i = 0; i < 8 && launches === 0; i++) {
        await Promise.resolve();
      }
      const retiredPort = manager.getServicePort();
      const recovery = manager.forceRestart({ joinInFlightStart: true });
      await fakeTimer.advanceTimeAsync(1_500);
      await recovery;
      expect(await firstFailure).toBe("iOS CtrlProxy startup was cancelled by stop()");
      expect(launches).toBe(2);
      expect(manager.getServicePort()).not.toBe(retiredPort);
    });

    test("allocates a distinct service port for a successful targeted restart", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const retiredPort = manager.getServicePort();
      spyOn(manager, "stop").mockResolvedValue();
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);
      spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await manager.forceRestart();

      expect(manager.getServicePort()).not.toBe(retiredPort);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(manager.getServicePort());
      expect(manager.getRunnerGeneration()).toBe(1);
    });

    test("reuses the retired port when the configured range has no spare capacity", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const retiredPort = manager.getServicePort();
      spyOn(manager, "stop").mockResolvedValue();
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);
      spyOn(
        manager as unknown as { allocateServicePort(additionalReservedPorts?: number[]): number },
        "allocateServicePort",
      ).mockImplementation(() => {
        throw new Error("no replacement port available");
      });
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await manager.forceRestart();

      expect(manager.getServicePort()).toBe(retiredPort);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(retiredPort);
      expect(start).toHaveBeenCalledTimes(1);
      expect(manager.getRunnerGeneration()).toBe(1);
    });

    test("keeps a failed replacement start assigned to its manager for a retry", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const retiredPort = manager.getServicePort();
      spyOn(manager, "stop").mockResolvedValue();
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);
      spyOn(manager, "startAfterForceRestart").mockRejectedValue(
        new Error("replacement start failed"),
      );

      await expect(manager.forceRestart()).rejects.toThrow("replacement start failed");

      expect(manager.getServicePort()).not.toBe(retiredPort);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(manager.getServicePort());
    });

    test("forwards caller startup options after stopping", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const controller = new AbortController();
      const options = { signal: controller.signal, minimumHealthPollDurationMs: 1_000 };
      spyOn(manager, "stop").mockResolvedValue();
      // This test checks option forwarding; health-drain timing belongs to its own tests.
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      expect(manager.getRunnerGeneration()).toBe(0);
      await manager.forceRestart(options);

      expect(start).toHaveBeenCalledWith(options);
      expect(manager.getRunnerGeneration()).toBe(1);
    });

    test("does not start a replacement after cancellation during stop", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const controller = new AbortController();
      spyOn(manager, "stop").mockImplementation(async () => {
        controller.abort(new Error("readiness deadline expired"));
      });
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await expect(manager.forceRestart({ signal: controller.signal })).rejects.toThrow(
        "readiness deadline expired",
      );
      expect(start).not.toHaveBeenCalled();
    });

    test("keeps a subsequent start behind a forced restart whose stop is still settling", async function () {
      const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer);
      const stopped = deferred();
      spyOn(manager, "stop").mockImplementation(async () => await stopped.promise);
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      const forcedRestart = manager.forceRestart();
      await Promise.resolve();
      const subsequentStart = manager.start();
      await Promise.resolve();

      expect(start).not.toHaveBeenCalled();
      stopped.resolve();
      await forcedRestart;
      await subsequentStart;
      expect(start).toHaveBeenCalledTimes(2);
    });

    test("lets a live caller retry after an earlier cancelled restart settles", async function () {
      const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer);
      const stopped = deferred();
      const controller = new AbortController();
      const stop = spyOn(manager, "stop")
        .mockImplementationOnce(async () => await stopped.promise)
        .mockResolvedValue();
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      const cancelledRestart = manager.forceRestart({ signal: controller.signal });
      await Promise.resolve();
      const liveRestart = manager.forceRestart();
      controller.abort(new Error("readiness deadline expired"));
      stopped.resolve();

      await expect(cancelledRestart).rejects.toThrow("readiness deadline expired");
      await liveRestart;
      expect(stop).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
    });

    test("extends a forced restart with a joining caller's health-poll budget", async function () {
      const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer);
      const stopped = deferred();
      spyOn(manager, "stop").mockImplementation(async () => await stopped.promise);
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      const ownerRestart = manager.forceRestart();
      await Promise.resolve();
      const joiningRestart = manager.forceRestart({ minimumHealthPollDurationMs: 1_000 });
      stopped.resolve();

      await ownerRestart;
      await joiningRestart;
      expect(start).toHaveBeenCalledWith({ minimumHealthPollDurationMs: 1_000 });
    });

    test("lets a live caller retry after the owner's startup-phase cancellation", async function () {
      const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer);
      const started = deferred();
      const controller = new AbortController();
      const stop = spyOn(manager, "stop").mockResolvedValue();
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const start = spyOn(manager, "startAfterForceRestart")
        .mockImplementationOnce(async () => {
          await started.promise;
          throw controller.signal.reason;
        })
        .mockResolvedValue();

      const cancelledRestart = manager.forceRestart({ signal: controller.signal });
      await Promise.resolve();
      const liveRestart = manager.forceRestart();
      const cancelledFailure = cancelledRestart.catch((error) => error);
      controller.abort(new Error("readiness deadline expired"));
      started.resolve();

      const cancelledError = await cancelledFailure;
      expect(cancelledError).toBeInstanceOf(Error);
      expect((cancelledError as Error).message).toContain("readiness deadline expired");
      await liveRestart;
      expect(stop).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(2);
    });

    test("keeps a start behind a successor forced restart after cancellation", async function () {
      const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer);
      const firstStop = deferred();
      const secondStop = deferred();
      const startGate = deferred();
      const controller = new AbortController();
      const stop = spyOn(manager, "stop")
        .mockImplementationOnce(async () => await firstStop.promise)
        .mockImplementationOnce(async () => await secondStop.promise);
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const start = spyOn(
        manager as unknown as { startInternal(sharedStart: unknown): Promise<void> },
        "startInternal",
      ).mockResolvedValue();
      spyOn(
        manager as unknown as {
          waitForNonJoinableStart(signal: AbortSignal | undefined): Promise<unknown>;
        },
        "waitForNonJoinableStart",
      ).mockImplementationOnce(async () => {
        await startGate.promise;
        return null;
      });

      const cancelledRestart = manager.forceRestart({ signal: controller.signal });
      await Promise.resolve();
      const ordinaryStart = manager.start();
      const successorRestart = manager.forceRestart();
      const cancelledFailure = cancelledRestart.catch((error) => error);
      controller.abort(new Error("readiness deadline expired"));
      firstStop.resolve();

      await cancelledFailure;
      await Promise.resolve();
      await Promise.resolve();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(start).not.toHaveBeenCalled();
      startGate.resolve();
      await Promise.resolve();
      expect(start).not.toHaveBeenCalled();
      secondStop.resolve();

      await ordinaryStart;
      await successorRestart;
      expect(start).toHaveBeenCalledTimes(2);
    });

    test("restarts once a draining runner stops answering its health endpoint (#6833)", async function () {
      // stop() kills the process tree, but the runner's HTTP listener can answer a
      // health probe for a moment while it drains; a single immediate probe raced it.
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      spyOn(manager, "stop").mockResolvedValue();
      let healthProbes = 0;
      spyOn(
        manager as unknown as {
          checkHealthEndpointOnPortForDevice(port: number, deviceId: string): Promise<boolean>;
        },
        "checkHealthEndpointOnPortForDevice",
      ).mockImplementation(async () => {
        healthProbes++;
        return healthProbes <= 2;
      });
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await manager.forceRestart();

      expect(healthProbes).toBe(3);
      expect(start).toHaveBeenCalledTimes(1);
    });

    test("fails rather than reusing a runner that remains after forced teardown", async function () {
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      spyOn(manager, "stop").mockResolvedValue();
      spyOn(
        manager as unknown as {
          checkHealthEndpointOnPortForDevice(port: number, deviceId: string): Promise<boolean>;
        },
        "checkHealthEndpointOnPortForDevice",
      ).mockResolvedValue(true);
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await expect(manager.forceRestart()).rejects.toThrow(
        "iOS CtrlProxy is still running after forced teardown",
      );
      expect(start).not.toHaveBeenCalled();
    });

    // #6415 follow-up: the forced-teardown gate must fail CLOSED on ownership —
    // a responder that omits deviceId must NOT be adopted as "still our
    // runner" (which would otherwise block a legitimate restart with the
    // "still running after forced teardown" error). Like the primary
    // liveness gate, a missing deviceId means "not proven to be ours", so
    // teardown proceeds and start is allowed. Exercised through the real
    // health client (curl mock), not a mocked private method, so the strict
    // wiring at the forceRestart call site is actually covered.
    test("does not mistake a forced-teardown responder that omits deviceId for our own runner", async function () {
      const fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandHandler("curl -s", () => createExecResult('{"status":"ok"}', ""));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      spyOn(manager, "stop").mockResolvedValue();
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await expect(manager.forceRestart()).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(1);
    });

    test("propagates forced teardown failures to a concurrent start", async function () {
      // The post-teardown drain grace polls on the injected timer; auto-advance
      // keeps the runner-still-alive path inside the unit-test time budget.
      fakeTimer.enableAutoAdvance();
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const stopped = deferred();
      spyOn(manager, "stop").mockImplementation(async () => await stopped.promise);
      spyOn(
        manager as unknown as {
          checkHealthEndpointOnPortForDevice(port: number, deviceId: string): Promise<boolean>;
        },
        "checkHealthEndpointOnPortForDevice",
      ).mockResolvedValue(true);
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      const forcedRestart = manager.forceRestart();
      await Promise.resolve();
      const concurrentStart = manager.start();
      const forcedFailure = forcedRestart.catch((error) => error);
      const concurrentFailure = concurrentStart.catch((error) => error);
      stopped.resolve();

      const [forcedError, concurrentError] = await Promise.all([forcedFailure, concurrentFailure]);
      expect(forcedError).toBeInstanceOf(Error);
      expect(concurrentError).toBeInstanceOf(Error);
      expect((forcedError as Error).message).toContain(
        "iOS CtrlProxy is still running after forced teardown",
      );
      expect((concurrentError as Error).message).toContain(
        "iOS CtrlProxy is still running after forced teardown",
      );
      expect(start).not.toHaveBeenCalled();
    });
  });
});
