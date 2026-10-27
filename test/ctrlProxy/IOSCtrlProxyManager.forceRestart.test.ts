import { describe, expect, mock, spyOn, test } from "bun:test";
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
  createSupervisorProbe,
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
    // A manager whose health endpoint answers, for this device, whenever `answers()` is true.
    function managerWithRunnerHealth(answers: () => boolean): IOSCtrlProxyManager {
      const executor = new FakeProcessExecutor();
      executor.setCommandHandler("curl -s", () =>
        createExecResult(
          answers() ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        ),
      );
      return IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: executor,
      });
    }

    test("replaces a joined startup when the runner exits during startup completion", async function () {
      const supervisor = createSupervisorProbe();
      const completing = deferred();
      const startup = deferred();
      let launches = 0;
      const manager: IOSCtrlProxyManager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: testDevice,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: new FakeProcessExecutor(),
        processSupervisorFactory: supervisor.factory,
        steps: (defaults) => ({
          startInternal: async (start) => {
            launches++;
            if (launches === 1) {
              await defaults.completeHealthStartup(start, new NoOpPerformanceTracker());
              completing.resolve();
              await startup.promise;
              start.controller.signal.throwIfAborted();
            }
          },
          retireRunnerAfterFinalSharedStartCancellation: async () => {},
          uninstallLegacyAppIfPresent: async () => {},
        }),
      });
      spyOn(manager, "isRunning").mockResolvedValue(false);
      const stop = spyOn(manager, "stop");
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);

      const firstStart = manager.start();
      const firstFailure = firstStart.catch((error: Error) => error.message);
      await completing.promise;
      const autoSetup = manager.setup();
      const externalWaiters = () => manager.runnerSnapshot().sharedStartExternalWaitingCallers;
      for (let i = 0; i < 20 && externalWaiters() !== 2; i++) {
        await Promise.resolve();
      }
      expect(externalWaiters()).toBe(2);
      const recovery = manager.forceRestart({ joinInFlightStart: true });
      supervisor.supervisor.processExited();
      startup.resolve();

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
      const supervisor = createSupervisorProbe();
      const startup = deferred();
      let launches = 0;
      let startupSignal: AbortSignal | undefined;
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: testDevice,
        timer: fakeTimer,
        processExecutor: new FakeProcessExecutor(),
        processSupervisorFactory: supervisor.factory,
        steps: {
          startInternal: async (start) => {
            launches++;
            startupSignal = start.controller.signal;
            await startup.promise;
            if (start.controller.signal.aborted) {
              throw start.controller.signal.reason;
            }
          },
        },
      });
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);

      supervisor.supervisor.processExited();
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
      let launches = 0;
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: testDevice,
        timer: fakeTimer,
        processExecutor: new FakeProcessExecutor(),
        steps: {
          startInternal: async (start) => {
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
          },
        },
      });
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
      expect(PortManager.allocate("another-device")).not.toBe(retiredPort);
    });

    test("reuses the retired port when the configured range has no spare capacity", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const retiredPort = manager.getServicePort();
      spyOn(manager, "stop").mockResolvedValue();
      spyOn(manager, "isRunnerStillHealthyAfterForcedTeardown").mockResolvedValue(false);
      // Only the retired port remains bindable, so no distinct replacement can be allocated.
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port) => port === retiredPort,
      });
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await manager.forceRestart();

      expect(manager.getServicePort()).toBe(retiredPort);
      expect(PortManager.isPortAvailable(retiredPort)).toBe(true);
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
      const firstStop = deferred();
      const secondStop = deferred();
      const startGate = deferred();
      const controller = new AbortController();
      const start = mock(async () => {});
      let gatedOnce = false;
      const manager = createManagerWithFakeHealthClient(testDevice, fakeTimer, (defaults) => ({
        startInternal: start,
        waitForNonJoinableStart: async (signal) => {
          if (gatedOnce) {
            return defaults.waitForNonJoinableStart(signal);
          }
          gatedOnce = true;
          await startGate.promise;
          return null;
        },
      }));
      const stop = spyOn(manager, "stop")
        .mockImplementationOnce(async () => await firstStop.promise)
        .mockImplementationOnce(async () => await secondStop.promise);
      spyOn(manager, "isRunning").mockResolvedValue(false);

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
      let healthProbes = 0;
      const manager = managerWithRunnerHealth(() => {
        healthProbes++;
        return healthProbes <= 2;
      });
      spyOn(manager, "stop").mockResolvedValue();
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await manager.forceRestart();

      expect(healthProbes).toBe(3);
      expect(start).toHaveBeenCalledTimes(1);
    });

    test("fails rather than reusing a runner that remains after forced teardown", async function () {
      fakeTimer.enableAutoAdvance();
      const manager = managerWithRunnerHealth(() => true);
      spyOn(manager, "stop").mockResolvedValue();
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
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: testDevice,
        timer: fakeTimer,
        builder: undefined,
        processExecutor: fakeExecutor,
      });
      spyOn(manager, "stop").mockResolvedValue();
      const start = spyOn(manager, "startAfterForceRestart").mockResolvedValue();

      await expect(manager.forceRestart()).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(1);
    });

    test("propagates forced teardown failures to a concurrent start", async function () {
      // The post-teardown drain grace polls on the injected timer; auto-advance
      // keeps the runner-still-alive path inside the unit-test time budget.
      fakeTimer.enableAutoAdvance();
      const manager = managerWithRunnerHealth(() => true);
      const stopped = deferred();
      spyOn(manager, "stop").mockImplementation(async () => await stopped.promise);
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
