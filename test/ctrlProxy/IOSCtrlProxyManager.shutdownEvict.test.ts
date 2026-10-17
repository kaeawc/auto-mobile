import { describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { PortManager } from "../../src/utils/PortManager";
import {
  FakeListeningProcess,
  createFakeBuilder,
  deferred,
  installIosManagerSuiteHooks,
  installListeningProcessFakes,
} from "../helpers/iosCtrlProxyManagerHarness";

describe("IOSCtrlProxyManager shutdown and eviction", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  installIosManagerSuiteHooks((ctx) => {
    testDevice = ctx.testDevice;
    fakeTimer = ctx.fakeTimer;
  });

  describe("shutdownAll", function () {
    test("returns the original timeout error after forced stop and clears its deadline", async () => {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const stop = deferred();
      const force = deferred();
      const forceCalled = Promise.withResolvers<void>();
      spyOn(manager, "stop").mockReturnValue(stop.promise);
      spyOn(manager, "forceStopForShutdown").mockImplementation(() => {
        forceCalled.resolve();
        return force.promise;
      });
      const boundary = IOSCtrlProxyManager as unknown as {
        stopWithinShutdownDeadline(
          instance: IOSCtrlProxyManager,
          timer: FakeTimer,
        ): Promise<unknown>;
      };
      const stopped = boundary.stopWithinShutdownDeadline(manager, fakeTimer);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
      fakeTimer.advanceTime(1_200);
      await forceCalled.promise;
      force.resolve();

      const result = await stopped;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe("timed out after 1200ms");
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      stop.resolve();
    });

    test("awaits in-flight force termination when the original stop settles", async () => {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      const stop = deferred();
      const force = deferred();
      spyOn(manager, "stop").mockReturnValue(stop.promise);
      spyOn(manager as any, "forceStopForShutdown").mockReturnValue(force.promise);
      let settled = false;
      const shutdown = IOSCtrlProxyManager.shutdownAll(fakeTimer).then(() => {
        settled = true;
      });
      fakeTimer.advanceTime(1_200);
      stop.resolve();
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      expect(settled).toBe(false);
      force.resolve();
      await shutdown;
      expect(settled).toBe(true);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    for (const ignoreTerm of [true, false]) {
      test(`signals a shutdown runner tree within budget (ignoreTerm=${ignoreTerm})`, async () => {
        const executor = new FakeProcessExecutor();
        const processes: FakeListeningProcess[] = [42, 43].map((pid) => ({
          pid,
          // The tracked runner (42) is parented by this daemon so the #6579
          // ownership re-verification in forceStopForShutdown recognizes it as
          // ours; 43 is its child.
          ppid: pid === 42 ? process.pid : 42,
          port: 8765,
          command: `xcodebuild CtrlProxy -destination id=${testDevice.deviceId}`,
          alive: true,
          ignoreTerm,
        }));
        installListeningProcessFakes(executor, processes);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          createFakeBuilder(),
          executor,
        );
        manager.setXcTestProcessIdForTesting(42);
        (IOSCtrlProxyManager as any).instances.set(testDevice.deviceId, manager);
        let settled = false;
        const shutdown = IOSCtrlProxyManager.shutdownAll(fakeTimer).then(() => {
          settled = true;
        });
        // Flush process discovery and signaling without advancing the grace sleeps.
        for (let i = 0; i < 100; i++) {
          await Promise.resolve();
        }
        if (ignoreTerm) {
          expect(settled).toBe(false);
          fakeTimer.advanceTime(1_200);
          for (let i = 0; i < 100; i++) {
            await Promise.resolve();
          }
          fakeTimer.advanceTime(250);
          for (let i = 0; i < 100; i++) {
            await Promise.resolve();
          }
        }
        expect(settled).toBe(true);
        expect(processes.every((process) => !process.alive)).toBe(true);
        const kills = executor
          .getExecutedCommands()
          .filter((command) => command.includes("kill -KILL"));
        expect(kills.length > 0).toBe(ignoreTerm);
        expect(fakeTimer.now()).toBeLessThanOrEqual(1_500);
        await shutdown;
      });
    }

    test("stops every instance and clears them when one stop fails", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      const otherDevice = {
        deviceId: "22222222-2222-2222-2222-222222222222",
        platform: "ios",
        name: "Other iPhone",
      } as const;
      const second = IOSCtrlProxyManager.getInstance(otherDevice);
      const firstStop = spyOn(first, "stop").mockRejectedValue(new Error("iproxy stop failed"));
      const forceStop = spyOn(first as any, "forceStopForShutdown").mockResolvedValue();
      const secondStop = spyOn(second, "stop").mockResolvedValue();

      await expect(IOSCtrlProxyManager.shutdownAll()).resolves.toBeUndefined();

      expect(firstStop).toHaveBeenCalledTimes(1);
      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(secondStop).toHaveBeenCalledTimes(1);
      expect(IOSCtrlProxyManager.getInstance(testDevice)).not.toBe(first);
      expect(IOSCtrlProxyManager.getInstance(otherDevice)).not.toBe(second);
    });

    test("clears all instances when one stop never settles", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      const second = IOSCtrlProxyManager.getInstance({
        deviceId: "33333333-3333-3333-3333-333333333333",
        platform: "ios",
        name: "Hung iPhone",
      });
      const timer = new FakeTimer();
      const firstStop = spyOn(first, "stop").mockImplementation(async () => {
        await new Promise<void>(() => {});
      });
      const forceStop = spyOn(first as any, "forceStopForShutdown").mockImplementation(() => {});
      const secondStop = spyOn(second, "stop").mockResolvedValue();
      const shutdown = IOSCtrlProxyManager.shutdownAll(timer);

      await Promise.resolve();
      timer.advanceTime(1_500);
      await shutdown;

      expect(firstStop).toHaveBeenCalledTimes(1);
      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(secondStop).toHaveBeenCalledTimes(1);
      expect(IOSCtrlProxyManager.getInstance(testDevice)).not.toBe(first);
    });

    for (const deviceKind of ["simulator", "physical device"] as const) {
      for (const firstStopFailure of ["rejects", "reports failure"] as const) {
        test(`retries ${deviceKind} late remote start cleanup when the first stop ${firstStopFailure} (#7093, #7108)`, async function () {
          const remoteStart = Promise.withResolvers<{
            success: boolean;
            error?: string;
            data?: { pid: number; message: string; port?: number };
          }>();
          const startCalled = Promise.withResolvers<void>();
          const stoppedPids: number[] = [];
          const iproxyDevicePorts: Array<number | undefined> = [];
          const remoteRunner = {
            isEnabled: () => true,
            isRunningInDocker: () => true,
            isAvailable: async () => true,
            getHost: () => "remote-host",
            runIdeviceId: async () => ({ success: true, data: { stdout: "" } }),
            runIdeviceInstaller: async () => ({ success: true, data: { stdout: "" } }),
            runSimctl: async () => ({ success: true, data: { stdout: "" } }),
            startIproxy: async ({ devicePort }: { devicePort?: number }) => {
              iproxyDevicePorts.push(devicePort);
              return { success: true, data: { pid: 99 } };
            },
            stopIproxy: async () => ({ success: true }),
            getIproxyStatus: async () => ({ success: true, data: { running: true } }),
            start: () => {
              startCalled.resolve();
              return remoteStart.promise;
            },
            stop: async ({ pid }: { pid: number }) => {
              stoppedPids.push(pid);
              if (stoppedPids.length === 1) {
                if (firstStopFailure === "rejects") {
                  throw new Error("remote stop unavailable");
                }
                return { success: false, error: "remote stop unavailable" };
              }
              return { success: true };
            },
            status: async () => ({ success: true, data: { running: false } }),
          };
          const device =
            deviceKind === "physical device"
              ? { ...testDevice, deviceId: "00008030-001E28C11E" }
              : testDevice;
          const manager = IOSCtrlProxyManager.createForTestingWithDeps(
            device,
            fakeTimer,
            createFakeBuilder(),
            new FakeProcessExecutor(),
            undefined,
            undefined,
            remoteRunner,
            { isAvailable: async () => true },
          );
          spyOn(manager, "isRunning").mockResolvedValue(false);
          spyOn(
            manager as unknown as { isCtrlProxyProcessAlive: () => Promise<boolean> },
            "isCtrlProxyProcessAlive",
          ).mockResolvedValue(false);
          (
            IOSCtrlProxyManager as unknown as { instances: Map<string, IOSCtrlProxyManager> }
          ).instances.set(device.deviceId, manager);

          const startup = manager.start();
          await startCalled.promise;
          const shutdown = IOSCtrlProxyManager.shutdownAll(fakeTimer);

          remoteStart.resolve({
            success: true,
            data: {
              pid: 42,
              message: "started",
              port: deviceKind === "physical device" ? 8100 : undefined,
            },
          });

          await expect(startup).rejects.toThrow("cancelled by stop()");
          await expect(shutdown).resolves.toBeUndefined();
          expect(stoppedPids).toEqual([42, 42]);
          expect(iproxyDevicePorts).toEqual(deviceKind === "physical device" ? [8765] : []);
          expect(manager.getXcTestProcessId()).toBeNull();
        });
      }
    }

    test("force-stops a late remote runner when admission cleanup never settles (#7108)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        { ...testDevice, deviceId: "00008030-001E28C11E" },
        fakeTimer,
        undefined,
        new FakeProcessExecutor(),
      );
      const controller = new AbortController();
      const stoppedPids: number[] = [];
      const internal = manager as unknown as {
        sharedStart: { controller: AbortController } | null;
        xcTestProcessId: number | null;
        remoteRunner: {
          stop: (options: { deviceId: string; pid: number }) => Promise<{ success: boolean }>;
        };
        useRemoteRunner: () => boolean;
        fenceLateRemoteStartAfterShutdown: (runnerPid: number) => Promise<void>;
        forceStopForShutdown: (deadline: number) => Promise<void>;
      };
      const firstStop = new Promise<{ success: boolean }>(() => {});
      internal.remoteRunner.stop = async ({ pid }) => {
        stoppedPids.push(pid);
        return stoppedPids.length === 1 ? firstStop : { success: true };
      };
      spyOn(internal, "useRemoteRunner").mockReturnValue(true);
      internal.sharedStart = {
        controller,
      };
      controller.abort(new Error("iOS CtrlProxy startup was cancelled by stop()"));

      const fence = internal.fenceLateRemoteStartAfterShutdown(42);
      void fence.catch(() => {});
      await Promise.resolve();

      expect(internal.xcTestProcessId).toBe(42);
      await internal.forceStopForShutdown(fakeTimer.now() + 250);

      expect(stoppedPids).toEqual([42, 42]);
      expect(internal.xcTestProcessId).toBeNull();
    });

    test("publishes a physical remote runner before yielding to its late-start fence (#7108)", async function () {
      const fenceEntered = Promise.withResolvers<void>();
      const releaseFence = Promise.withResolvers<void>();
      const remoteRunner = {
        isEnabled: () => true,
        isRunningInDocker: () => true,
        isAvailable: async () => true,
        getHost: () => "remote-host",
        runIdeviceId: async () => ({ success: true, data: { stdout: "" } }),
        runIdeviceInstaller: async () => ({ success: true, data: { stdout: "" } }),
        runSimctl: async () => ({ success: true, data: { stdout: "" } }),
        startIproxy: async () => ({ success: true, data: { pid: 99 } }),
        stopIproxy: async () => ({ success: true }),
        getIproxyStatus: async () => ({ success: true, data: { running: true } }),
        start: async () => ({ success: true, data: { pid: 42, message: "started" } }),
        stop: async () => ({ success: true }),
        status: async () => ({ success: true, data: { running: false } }),
      };
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        { ...testDevice, deviceId: "00008030-001E28C11E" },
        fakeTimer,
        createFakeBuilder(),
        new FakeProcessExecutor(),
        undefined,
        undefined,
        remoteRunner,
        { isAvailable: async () => true },
      );
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        startOnDevice: () => Promise<void>;
        fenceLateRemoteStartAfterShutdown: () => Promise<void>;
      };
      spyOn(internal, "fenceLateRemoteStartAfterShutdown").mockImplementation(async () => {
        fenceEntered.resolve();
        await releaseFence.promise;
      });

      const startup = internal.startOnDevice();
      await fenceEntered.promise;
      expect(internal.xcTestProcessId).toBe(42);

      releaseFence.resolve();
      await startup;
    });
  });

  describe("evict", function () {
    test("device removal evicts a simulator manager and frees its port, but keeps a physical one (#11122)", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      spyOn(manager, "stop").mockResolvedValue();
      const physical = { ...testDevice, deviceId: "00008120-001C2D3E1234567A" };
      const physicalManager = IOSCtrlProxyManager.getInstance(physical, fakeTimer);
      spyOn(physicalManager, "stop").mockResolvedValue();
      expect(PortManager.getPort(testDevice.deviceId)).toBeDefined();

      await IOSCtrlProxyManager.evictAfterDeviceRemoval(testDevice.deviceId, fakeTimer);
      await IOSCtrlProxyManager.evictAfterDeviceRemoval(physical.deviceId, fakeTimer);

      expect(IOSCtrlProxyManager.getExistingInstance(testDevice.deviceId)).toBeUndefined();
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
      expect(IOSCtrlProxyManager.getExistingInstance(physical.deviceId)).toBe(physicalManager);
    });

    test("removal eviction skips a manager re-armed for a reappeared simulator (#11141)", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const stop = deferred();
      const stopEntered = deferred();
      const stopSpy = spyOn(manager, "stop").mockImplementation(() => {
        stopEntered.resolve();
        return stop.promise;
      });
      const port = PortManager.getPort(testDevice.deviceId);
      expect(port).toBeDefined();

      const eviction = IOSCtrlProxyManager.evictAfterDeviceRemoval(testDevice.deviceId, fakeTimer);
      await stopEntered.promise;
      // The simulator reappears under the same UDID and a new acquisition starts its runner.
      IOSCtrlProxyManager.resumeDevice(testDevice.deviceId);
      stop.resolve();
      await eviction;

      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(IOSCtrlProxyManager.getExistingInstance(testDevice.deviceId)).toBe(manager);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(port);
    });

    test("explicit device start consumes the removal before a routine ready signal", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const budget = manager.getForcedRestartBudget();
      const stop = deferred();
      const stopEntered = deferred();
      spyOn(manager, "stop").mockImplementation(() => {
        stopEntered.resolve();
        return stop.promise;
      });

      const removal = manager.suspendForDeviceRemoval();
      await stopEntered.promise;
      expect(budget.snapshot().state).toBe("suspended");
      IOSCtrlProxyManager.resumeDevice(testDevice.deviceId);
      expect(budget.snapshot().state).toBe("idle");
      stop.resolve();
      await removal;

      for (const delay of [30_000, 60_000, 0]) {
        const token = budget.tryBeginAttempt();
        expect(token).toBeDefined();
        budget.recordFailure("startup timeout", token!);
        fakeTimer.advanceTime(delay);
      }
      expect(budget.snapshot().state).toBe("exhausted");

      await manager.rearmAfterDeviceReappearance();

      expect(budget.snapshot().state).toBe("exhausted");
      expect(budget.tryBeginAttempt()).toBeUndefined();
    });

    test("failed removal cleanup after an explicit start permits a later reappearance", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const budget = manager.getForcedRestartBudget();
      const stop = deferred();
      const stopEntered = deferred();
      spyOn(manager, "stop").mockImplementation(() => {
        stopEntered.resolve();
        return stop.promise;
      });

      const removal = manager.suspendForDeviceRemoval();
      await stopEntered.promise;
      IOSCtrlProxyManager.resumeDevice(testDevice.deviceId);
      expect(budget.snapshot().state).toBe("idle");

      stop.reject(new Error("stop failed"));
      await expect(removal).rejects.toThrow("stop failed");
      expect(budget.snapshot().state).toBe("suspended");

      await manager.rearmAfterDeviceReappearance();
      expect(budget.snapshot().state).toBe("idle");
      expect(budget.tryBeginAttempt()).toBeDefined();
    });

    test("failed removal cleanup without an explicit start awaits reappearance", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const budget = manager.getForcedRestartBudget();
      const stop = deferred();
      const stopEntered = deferred();
      spyOn(manager, "stop").mockImplementation(() => {
        stopEntered.resolve();
        return stop.promise;
      });

      const removal = manager.suspendForDeviceRemoval();
      await stopEntered.promise;
      expect(budget.snapshot().state).toBe("suspended");

      stop.reject(new Error("stop failed"));
      await expect(removal).rejects.toThrow("stop failed");
      expect(budget.snapshot().state).toBe("suspended");

      await manager.rearmAfterDeviceReappearance();
      expect(budget.snapshot().state).toBe("idle");
    });

    test("does not rearm an exhausted budget on a ready signal without removal", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const budget = manager.getForcedRestartBudget();
      const start = spyOn(manager, "start").mockResolvedValue();

      for (const delay of [30_000, 60_000, 0]) {
        const token = budget.tryBeginAttempt();
        expect(token).toBeDefined();
        budget.recordFailure("startup timeout", token!);
        fakeTimer.advanceTime(delay);
      }
      expect(budget.snapshot().state).toBe("exhausted");

      await manager.rearmAfterDeviceReappearance();

      expect(budget.snapshot().state).toBe("exhausted");
      expect(budget.tryBeginAttempt()).toBeUndefined();
      expect(start).not.toHaveBeenCalled();
    });

    test("stale reappearance cannot rearm a newer device removal", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const firstStop = deferred();
      const secondStop = deferred();
      const firstEntered = deferred();
      const secondEntered = deferred();
      spyOn(manager, "stop")
        .mockImplementationOnce(async () => {
          firstEntered.resolve();
          await firstStop.promise;
        })
        .mockImplementationOnce(async () => {
          secondEntered.resolve();
          await secondStop.promise;
        });

      const firstRemoval = manager.suspendForDeviceRemoval();
      await firstEntered.promise;
      const staleRearm = manager.rearmAfterDeviceReappearance();
      const secondRemoval = manager.suspendForDeviceRemoval();
      await secondEntered.promise;
      firstStop.resolve();
      await firstRemoval;
      await staleRearm;
      expect(manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
      secondStop.resolve();
      await secondRemoval;
    });

    test("device disappearance suspends recovery and releases the runner port", async function () {
      const manager = IOSCtrlProxyManager.getInstance(testDevice, fakeTimer);
      const budget = manager.getForcedRestartBudget();
      expect(PortManager.getPort(testDevice.deviceId)).toBeDefined();

      await manager.suspendForDeviceRemoval();
      expect(budget.snapshot()).toMatchObject({ state: "suspended", attempts: 0 });
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();

      await manager.rearmAfterDeviceReappearance();
      expect(budget.snapshot()).toEqual({ state: "idle", attempts: 0 });
    });

    test("stops the instance, deletes the map entry, and releases the port", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      expect(PortManager.getPort(testDevice.deviceId)).toBeDefined();
      const forceStop = spyOn(first as any, "forceStopForShutdown").mockResolvedValue();

      await IOSCtrlProxyManager.evict(testDevice.deviceId);

      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
      const second = IOSCtrlProxyManager.getInstance(testDevice);
      expect(second).not.toBe(first);
    });

    test("preserves a replacement port while retiring old cleanup", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      let finish!: () => void;
      spyOn(
        first as unknown as { forceStopForShutdown: () => Promise<void> },
        "forceStopForShutdown",
      ).mockImplementation(() => {
        PortManager.release(testDevice.deviceId);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const pending = IOSCtrlProxyManager.evict(testDevice.deviceId, fakeTimer);
      const replacement = IOSCtrlProxyManager.getInstance(testDevice);
      const port = replacement.getServicePort();
      finish();
      await pending;
      expect(IOSCtrlProxyManager.getInstance(testDevice)).toBe(replacement);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(port);
    });
    test("leaves other devices' instances and port reservations untouched", async function () {
      const otherDevice: BootedDevice = {
        deviceId: "22222222-2222-2222-2222-222222222222",
        platform: "ios",
        name: "Other iPhone",
      };
      const evicted = IOSCtrlProxyManager.getInstance(testDevice);
      const other = IOSCtrlProxyManager.getInstance(otherDevice);
      spyOn(evicted as any, "forceStopForShutdown").mockResolvedValue();

      await IOSCtrlProxyManager.evict(testDevice.deviceId);

      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
      expect(PortManager.getPort(otherDevice.deviceId)).toBeDefined();
      expect(IOSCtrlProxyManager.getInstance(otherDevice)).toBe(other);
    });

    test("is a no-op when no instance was ever constructed for the device id", async function () {
      // No instance exists for this device after resetInstances() in beforeEach.
      await expect(IOSCtrlProxyManager.evict(testDevice.deviceId)).resolves.toBeUndefined();
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
    });

    test("does not wait when the eviction deadline has already expired", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      const timer = new FakeTimer();
      const forceStop = spyOn(first as any, "forceStopForShutdown").mockImplementation(
        () => new Promise<void>(() => {}),
      );
      let settled = false;

      void IOSCtrlProxyManager.evict(testDevice.deviceId, timer, -1).then(() => {
        settled = true;
      });
      for (let attempt = 0; attempt < 5; attempt++) {
        await Promise.resolve();
      }

      expect(settled).toBe(true);
      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(timer.now()).toBe(0);
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
    });

    test("caps force-stop waiting at the remaining eviction deadline", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      const timer = new FakeTimer();
      const forceStop = spyOn(first as any, "forceStopForShutdown").mockImplementation(
        () => new Promise<void>(() => {}),
      );
      let settled = false;

      void IOSCtrlProxyManager.evict(testDevice.deviceId, timer, 10).then(() => {
        settled = true;
      });
      for (let attempt = 0; attempt < 5; attempt++) {
        await Promise.resolve();
      }
      expect(forceStop).toHaveBeenCalledTimes(1);

      timer.advanceTime(10);
      for (let attempt = 0; attempt < 5; attempt++) {
        await Promise.resolve();
      }

      expect(settled).toBe(true);
      expect(timer.now()).toBe(10);
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
    });

    test("still releases the port and clears the map entry when stopping fails", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      spyOn(first as any, "forceStopForShutdown").mockRejectedValue(new Error("stop failed"));

      await IOSCtrlProxyManager.evict(testDevice.deviceId);

      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
      expect(IOSCtrlProxyManager.getInstance(testDevice)).not.toBe(first);
    });

    test("releases the port and clears the map entry within the deadline when forceStopForShutdown never resolves", async function () {
      const first = IOSCtrlProxyManager.getInstance(testDevice);
      const timer = new FakeTimer();
      const forceStop = spyOn(first as any, "forceStopForShutdown").mockImplementation(() => {
        return new Promise<void>(() => {});
      });

      const evicted = IOSCtrlProxyManager.evict(testDevice.deviceId, timer);

      await Promise.resolve();
      timer.advanceTime(1_000);
      await evicted;

      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(PortManager.getPort(testDevice.deviceId)).toBeUndefined();
      expect(IOSCtrlProxyManager.getInstance(testDevice)).not.toBe(first);
    });
  });
});
