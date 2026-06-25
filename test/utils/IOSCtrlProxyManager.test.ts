import { beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyManager, type HostPortAvailabilityChecker } from "../../src/utils/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import type { ExecResult } from "../../src/models";
import { PortManager } from "../../src/utils/PortManager";

class FakeHostPortAvailabilityChecker implements HostPortAvailabilityChecker {
  public readonly calls: { host: string; port: number }[] = [];

  public constructor(private readonly unavailablePorts: Set<number> = new Set()) {}

  public async isAvailable(host: string, port: number): Promise<boolean> {
    this.calls.push({ host, port });
    return !this.unavailablePorts.has(port);
  }
}

function createHostControlRunner(options: {
  runningCtrlProxyPids?: number[];
  runningCtrlProxyProcesses?: { pid: number; port: number; deviceId?: string }[];
} = {}) {
  const starts: { deviceId: string; port: number; xctestrunPath?: string }[] = [];
  const stops: { deviceId?: string; pid?: number }[] = [];
  const iproxyStarts: { deviceId: string; localPort: number; devicePort?: number }[] = [];
  const runningCtrlProxyProcesses = new Map<number, { pid: number; port: number; deviceId?: string }>();
  for (const pid of options.runningCtrlProxyPids ?? []) {
    runningCtrlProxyProcesses.set(pid, { pid, port: 8765 });
  }
  for (const process of options.runningCtrlProxyProcesses ?? []) {
    runningCtrlProxyProcesses.set(process.pid, process);
  }
  const runningIproxyPids = new Set<number>();
  let nextCtrlProxyPid = 1234;
  let nextIproxyPid = 4321;

  return {
    starts,
    stops,
    iproxyStarts,
    runner: {
      shouldUseHostControl: () => true,
      isRunningInDocker: () => true,
      isAvailable: async () => true,
      getHost: () => "host.test",
      runIdeviceId: async () => ({ success: true, data: { stdout: "" } }),
      runIdeviceInstaller: async () => ({ success: true, data: { stdout: "" } }),
      runSimctl: async () => ({ success: true, data: { stdout: "" } }),
      startIproxy: async (params: { deviceId: string; localPort: number; devicePort?: number }) => {
        iproxyStarts.push(params);
        const pid = nextIproxyPid++;
        runningIproxyPids.add(pid);
        return { success: true, data: { pid } };
      },
      stopIproxy: async (params: { pid?: number }) => {
        if (params.pid) {
          runningIproxyPids.delete(params.pid);
        }
        return { success: true };
      },
      getIproxyStatus: async (params: { pid?: number }) => ({
        success: true,
        data: { running: params.pid !== undefined && runningIproxyPids.has(params.pid), pid: params.pid },
      }),
      start: async (params: { deviceId: string; port: number; xctestrunPath?: string }) => {
        const existingProcess = Array.from(runningCtrlProxyProcesses.values())
          .find(process => process.deviceId === params.deviceId);
        if (existingProcess) {
          return {
            success: true,
            data: { pid: existingProcess.pid, message: "already running", port: existingProcess.port },
          };
        }
        starts.push(params);
        const pid = nextCtrlProxyPid++;
        runningCtrlProxyProcesses.set(pid, { pid, port: params.port, deviceId: params.deviceId });
        return { success: true, data: { pid, message: "started", port: params.port } };
      },
      stop: async (params: { deviceId?: string; pid?: number }) => {
        stops.push(params);
        if (params.pid) {
          runningCtrlProxyProcesses.delete(params.pid);
        }
        if (params.deviceId) {
          for (const [pid, process] of runningCtrlProxyProcesses) {
            if (process.deviceId === params.deviceId) {
              runningCtrlProxyProcesses.delete(pid);
            }
          }
        }
        return { success: true };
      },
      status: async (params: { deviceId?: string; pid?: number; port?: number }) => {
        const runningProcess = params.pid !== undefined
          ? runningCtrlProxyProcesses.get(params.pid)
          : Array.from(runningCtrlProxyProcesses.values()).find(process =>
            (params.deviceId !== undefined && process.deviceId === params.deviceId) ||
            (params.port !== undefined && process.port === params.port)
          );
        return {
          success: true,
          data: {
            running: runningProcess !== undefined,
            pid: runningProcess?.pid ?? params.pid,
            port: runningProcess?.port ?? params.port,
          },
        };
      },
    },
  };
}

describe("IOSCtrlProxyManager", function() {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  beforeEach(function() {
    fakeTimer = new FakeTimer();

    // Create test device (iOS simulator format - UUID)
    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator"
    };

    // Reset singleton instances
    IOSCtrlProxyManager.resetInstances();
    PortManager.reset();
  });

  describe("getInstance", function() {
    test("should return same instance for same device", function() {
      const instance1 = IOSCtrlProxyManager.getInstance(testDevice);
      const instance2 = IOSCtrlProxyManager.getInstance(testDevice);

      expect(instance1).toBe(instance2);
    });

    test("should return different instances for different devices", function() {
      const device2: BootedDevice = {
        deviceId: "B2C3D4E5-F6A7-8901-BCDE-F12345678901",
        platform: "ios",
        name: "iPad Simulator"
      };

      const instance1 = IOSCtrlProxyManager.getInstance(testDevice);
      const instance2 = IOSCtrlProxyManager.getInstance(device2);

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("getServicePort", function() {
    test("should return default port 8765", function() {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);
      expect(manager.getServicePort()).toBe(8765);
    });
  });

  describe("getCapabilities", function() {
    test("should identify simulator device type for UUID format deviceId", async function() {
      const manager = IOSCtrlProxyManager.createForTesting(testDevice, fakeTimer);
      const capabilities = await manager.getCapabilities();

      expect(capabilities.deviceType).toBe("simulator");
      expect(capabilities.supportsXCTest).toBe(true);
    });

    test("should identify physical device type for non-UUID format deviceId", async function() {
      const physicalDevice: BootedDevice = {
        deviceId: "00008030001E28C11E", // Physical device serial number format
        platform: "ios",
        name: "iPhone"
      };

      const manager = IOSCtrlProxyManager.createForTesting(physicalDevice, fakeTimer);
      const capabilities = await manager.getCapabilities();

      expect(capabilities.deviceType).toBe("physical");
      expect(capabilities.supportsXCTest).toBe(true);
    });
  });

  describe("clearCaches", function() {
    test("should clear all cached state", function() {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);

      // This should not throw
      manager.clearCaches();
    });
  });

  describe("resetSetupState", function() {
    test("should reset setup state and clear caches", function() {
      const manager = IOSCtrlProxyManager.getInstance(testDevice);

      // This should not throw
      manager.resetSetupState();
    });
  });

  describe("iproxy tunnel", function() {
    let physicalDevice: BootedDevice;
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      physicalDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone"
      };
      fakeExecutor = new FakeProcessExecutor();
      fakeExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
    });

    test("starts iproxy for physical devices with device-specific port", async function() {
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      const spawns = fakeExecutor.getSpawnedProcesses();
      expect(spawns.length).toBe(1);
      expect(spawns[0].command).toBe("iproxy");
      expect(spawns[0].args).toEqual([
        String(manager.getServicePort()),
        String(manager.getServicePort()),
        physicalDevice.deviceId
      ]);
    });

    test("restarts iproxy after unexpected exit", async function() {
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      fakeProcess.emit("exit", 1, null);
      fakeTimer.advanceTime(1000);
      await Promise.resolve();

      expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
    });

    test("host-control iproxy skips ports that are busy on the host", async function() {
      const { runner, iproxyStarts } = createHostControlRunner();
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      expect(checker.calls).toEqual([
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8767 },
      ]);
      expect(manager.getServicePort()).toBe(8767);
      expect(iproxyStarts[0]).toMatchObject({ localPort: 8767, devicePort: 8767 });
    });

    test("host-control iproxy only skips busy host ports for the current allocation attempt", async function() {
      const unavailablePorts = new Set([8765]);
      const { runner, iproxyStarts } = createHostControlRunner();
      const checker = new FakeHostPortAvailabilityChecker(unavailablePorts);
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      (manager as unknown as { iproxyProcessId: null }).iproxyProcessId = null;
      unavailablePorts.clear();
      unavailablePorts.add(8767);

      await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

      expect(checker.calls).toEqual([
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8767 },
        { host: "host.test", port: 8767 },
        { host: "host.test", port: 8765 },
      ]);
      expect(manager.getServicePort()).toBe(8765);
      expect(iproxyStarts.map(start => ({
        localPort: start.localPort,
        devicePort: start.devicePort,
      }))).toEqual([
        { localPort: 8767, devicePort: 8767 },
        { localPort: 8765, devicePort: 8765 },
      ]);
    });

    test("host-control iproxy keeps the service port when reallocation is disabled", async function() {
      const { runner, iproxyStarts } = createHostControlRunner();
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );

      await expect(
        (manager as unknown as {
          startIproxyTunnel: (options: { allowServicePortReallocation: boolean }) => Promise<void>;
        }).startIproxyTunnel({ allowServicePortReallocation: false })
      ).rejects.toThrow("Host control port 8765 is already in use on host.test");

      expect(checker.calls).toEqual([{ host: "host.test", port: 8765 }]);
      expect(manager.getServicePort()).toBe(8765);
      expect(iproxyStarts).toEqual([]);
    });

    test("host-control device startup preserves the device port for daemon-owned live processes", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an existing host-control process is reused");
        },
        getRunnerBinaryPath: async () => null,
        getExpectedAppHash: () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const { runner, starts, iproxyStarts } = createHostControlRunner({
        runningCtrlProxyProcesses: [{
          pid: 1234,
          port: 8765,
          deviceId: physicalDevice.deviceId,
        }],
      });
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );

      await (manager as unknown as { startOnDevice: () => Promise<void> }).startOnDevice();

      expect(starts).toEqual([]);
      expect(manager.getServicePort()).toBe(8767);
      expect(iproxyStarts).toEqual([
        { deviceId: physicalDevice.deviceId, localPort: 8767, devicePort: 8765 },
      ]);
      expect((manager as unknown as { xcTestProcessId: number }).xcTestProcessId).toBe(1234);
    });
  });

  describe("restart prevention", function() {
    let physicalDevice: BootedDevice;
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      physicalDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone"
      };
      fakeExecutor = new FakeProcessExecutor();
    });

    test("start() skips spawning when tracked CtrlProxy PID is alive (simulator)", async function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, // simulator UUID
        fakeTimer,
        undefined,
        fakeExecutor
      );

      // Simulate an already-tracked process (as if startOnSimulator ran previously)
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;

      // Health endpoint responds → confirms this PID really is CtrlProxy (not a PID-reused process)
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));
      // kill -0 succeeds by default (FakeProcessExecutor never throws) → process alive

      fakeTimer.enableAutoAdvance();
      await manager.start();

      // Process is alive → no simctl spawn or exec for starting the binary
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
    });

    test("start() re-establishes iproxy tunnel when CtrlProxy is alive but tunnel is gone (physical device)", async function() {
      fakeExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
      // Health endpoint responds → confirms the tracked PID really is CtrlProxy
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));

      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      // Simulate: CtrlProxy process is alive but iproxy tunnel was stopped
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 12345;
      // iproxyProcessId is null → tunnel is gone

      fakeTimer.enableAutoAdvance();
      await manager.start();

      // iproxy should have been (re-)spawned even though CtrlProxy was alive
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].command).toBe("iproxy");
    });

    test("start() restarts live host-control device process before reallocating its busy service port", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => "/tmp/test.xctestrun",
        getRunnerBinaryPath: async () => null,
        getExpectedAppHash: () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const { runner, starts, stops, iproxyStarts } = createHostControlRunner({
        runningCtrlProxyPids: [1234],
      });
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 1234;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response("ok");
      try {
        fakeTimer.enableAutoAdvance();
        await manager.start();
      } finally {
        globalThis.fetch = originalFetch;
      }

      expect(stops).toEqual([{ deviceId: physicalDevice.deviceId, pid: 1234 }]);
      expect(checker.calls).toEqual([
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8767 },
      ]);
      expect(manager.getServicePort()).toBe(8767);
      expect(iproxyStarts).toEqual([
        { deviceId: physicalDevice.deviceId, localPort: 8767, devicePort: 8767 },
      ]);
      expect(starts).toEqual([
        { deviceId: physicalDevice.deviceId, port: 8767, xctestrunPath: "/tmp/test.xctestrun" },
      ]);
    });

    test("scheduled host-control iproxy restart restarts live device process before reallocating busy service port", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => "/tmp/test.xctestrun",
        getRunnerBinaryPath: async () => null,
        getExpectedAppHash: () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const { runner, starts, stops, iproxyStarts } = createHostControlRunner({
        runningCtrlProxyPids: [1234],
      });
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );
      (manager as unknown as { xcTestProcessId: number }).xcTestProcessId = 1234;

      fakeTimer.enableAutoAdvance();
      (manager as unknown as { scheduleIproxyRestart: () => void }).scheduleIproxyRestart();
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }

      expect(stops).toEqual([{ deviceId: physicalDevice.deviceId, pid: 1234 }]);
      expect(checker.calls).toEqual([
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8767 },
      ]);
      expect(manager.getServicePort()).toBe(8767);
      expect(iproxyStarts).toEqual([
        { deviceId: physicalDevice.deviceId, localPort: 8767, devicePort: 8767 },
      ]);
      expect(starts).toEqual([
        { deviceId: physicalDevice.deviceId, port: 8767, xctestrunPath: "/tmp/test.xctestrun" },
      ]);
    });

    test("startProcessMonitoring uses the injected timer so tests can control it", function() {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor
      );

      expect(fakeTimer.getPendingIntervals().length).toBe(0);

      (manager as unknown as { startProcessMonitoring: () => void }).startProcessMonitoring();

      expect(fakeTimer.getPendingIntervals().length).toBe(1);
      expect(fakeTimer.getPendingIntervals()[0]).toBe(30000);
    });

    describe("iproxy monitor uses process liveness not health endpoint", function() {
      beforeEach(function() {
        fakeExecutor.setCommandResponse("idevice_id -l", createExecResult(`${physicalDevice.deviceId}\n`, ""));
      });

      test("does not restart iproxy when process is alive even if health check fails", async function() {
        const fakeProcess = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();
        expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);

        // Health endpoint fails (would have triggered restart in old code)
        fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
        // kill -0 succeeds by default → iproxy process alive

        (manager as unknown as { startIproxyMonitoring: () => void }).startIproxyMonitoring();

        // Fire one monitor interval
        fakeTimer.advanceTime(5000);
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        // iproxy is alive → no restart scheduled
        expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);
      });

      test("restarts iproxy when iproxyProcessId is null (process gone)", async function() {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

        // Simulate iproxy process dying between monitor ticks (clears tracking state)
        (manager as unknown as { iproxyProcessId: null }).iproxyProcessId = null;
        (manager as unknown as { iproxyProcess: null }).iproxyProcess = null;

        fakeExecutor.setNextSpawnProcess(fakeProcess2);

        (manager as unknown as { startIproxyMonitoring: () => void }).startIproxyMonitoring();

        // Fire monitor — sees no tracked process → schedules restart
        fakeTimer.advanceTime(5000);
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        // Fire restart timer (first attempt = 1000 ms base delay)
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
      });

      test("resumes iproxy monitoring after scheduled restart completes", async function() {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice, fakeTimer, undefined, fakeExecutor
        );

        await (manager as unknown as { startIproxyTunnel: () => Promise<void> }).startIproxyTunnel();

        // Process exit triggers scheduleIproxyRestart
        fakeProcess1.emit("exit", 1, null);

        fakeExecutor.setNextSpawnProcess(fakeProcess2);

        // Fire restart timer (1000 ms base delay for first attempt)
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {await Promise.resolve();}

        // After restart, startIproxyMonitoring() should have been called → new interval pending
        expect(fakeTimer.getPendingIntervals().length).toBe(1);
      });
    });
  });

  describe("simulator start uses xcodebuild test-without-building", function() {
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function() {
      fakeExecutor = new FakeProcessExecutor();
    });

    test("start() throws when simulator xctestrun path is missing", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => null,
        getRunnerBinaryPath: async () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      // Health check fails → not already running → tries to start
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      fakeTimer.enableAutoAdvance();

      await expect(manager.start()).rejects.toThrow(
        "CtrlProxy xctestrun not found for simulator"
      );
    });

    test("start() does not use simctl spawn for simulator", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => "/tmp/test.xctestrun",
        getRunnerBinaryPath: async () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      // Health check succeeds on first poll (simulating xcodebuild starting the service)
      fakeExecutor.setCommandResponse("curl -s", createExecResult("ok", ""));
      fakeTimer.enableAutoAdvance();

      await manager.start();

      // simctl spawn should never be invoked via processExecutor
      expect(fakeExecutor.wasCommandExecuted("simctl spawn")).toBe(false);
    });

    test("start() adopts the default hot-reload CtrlProxy port before health polling", async function() {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => {
            throw new Error("should not build when an external CtrlProxy process is reused");
          },
          getRunnerBinaryPath: async () => null,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );
        expect(manager.getServicePort()).toBe(8767);

        fakeExecutor.setCommandResponse("http://localhost:8767/health", createExecResult("", ""));
        fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2468\n", ""));
        fakeExecutor.setCommandResponse(
          "ps -p 2468",
          createExecResult("xcodebuild test CtrlProxyUITests/CtrlProxyUITests/testRunService", "")
        );
        fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("ok", ""));
        fakeTimer.enableAutoAdvance();

        await manager.start();

        expect(manager.getServicePort()).toBe(8765);
        expect(PortManager.getPort(testDevice.deviceId)).toBe(8765);
        expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("start() adopts a custom hot-reload CtrlProxy port from process args", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an external CtrlProxy process is reused");
        },
        getRunnerBinaryPath: async () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor
      );

      fakeExecutor.setCommandResponse("http://localhost:8765/health", createExecResult("", ""));
      fakeExecutor.setCommandResponse("pgrep -x xcodebuild", createExecResult("2469\n", ""));
      fakeExecutor.setCommandResponse(
        "ps -p 2469",
        createExecResult("xcodebuild test CtrlProxyUITests CTRL_PROXY_IOS_PORT=8790", "")
      );
      fakeExecutor.setCommandResponse("http://localhost:8790/health", createExecResult("ok", ""));
      fakeTimer.enableAutoAdvance();

      await manager.start();

      expect(manager.getServicePort()).toBe(8790);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8790);
      expect(fakeExecutor.getSpawnedProcesses()).toEqual([]);
    });

    test("startOnSimulator() keeps the reallocated simulator port when spawning", async function() {
      PortManager.setPortAvailabilityCheckerForTesting({
        isPortAvailable: (port: number) => port !== 8765,
      });
      try {
        const fakeBuilder = {
          getXctestrunPath: async () => "/tmp/test.xctestrun",
          getRunnerBinaryPath: async () => null,
        } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          fakeBuilder,
          fakeExecutor
        );

        await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

        const spawn = fakeExecutor.getSpawnedProcesses()[0];
        expect(manager.getServicePort()).toBe(8767);
        expect(spawn.options?.env).toMatchObject({
          CTRL_PROXY_IOS_PORT: "8767",
          SIMCTL_CHILD_CTRL_PROXY_IOS_PORT: "8767",
        });
      } finally {
        PortManager.setPortAvailabilityCheckerForTesting(null);
      }
    });

    test("host-control simulator start skips ports that are busy on the host", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => "/tmp/test.xctestrun",
        getRunnerBinaryPath: async () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const { runner, starts } = createHostControlRunner();
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );

      await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

      expect(checker.calls).toEqual([
        { host: "host.test", port: 8765 },
        { host: "host.test", port: 8767 },
      ]);
      expect(manager.getServicePort()).toBe(8767);
      expect(starts[0]).toMatchObject({ port: 8767, xctestrunPath: "/tmp/test.xctestrun" });
    });

    test("host-control simulator start reuses daemon-owned live process ports", async function() {
      const fakeBuilder = {
        getXctestrunPath: async () => {
          throw new Error("should not build when an existing host-control process is reused");
        },
        getRunnerBinaryPath: async () => null,
      } as unknown as import("../../src/utils/IOSCtrlProxyBuilder").IOSCtrlProxyBuilder;
      const { runner, starts } = createHostControlRunner({
        runningCtrlProxyProcesses: [{
          pid: 2233,
          port: 8767,
          deviceId: testDevice.deviceId,
        }],
      });
      const checker = new FakeHostPortAvailabilityChecker(new Set([8765]));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        fakeBuilder,
        fakeExecutor,
        undefined,
        undefined,
        runner,
        checker
      );

      await (manager as unknown as { startOnSimulator: () => Promise<void> }).startOnSimulator();

      expect(checker.calls).toEqual([]);
      expect(starts).toEqual([]);
      expect(manager.getServicePort()).toBe(8767);
      expect(PortManager.getPort(testDevice.deviceId)).toBe(8767);
      expect((manager as unknown as { xcTestProcessId: number }).xcTestProcessId).toBe(2233);
    });
  });
});

function createExecResult(stdout: string, stderr: string): ExecResult {
  return {
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (searchString: string) => stdout.includes(searchString)
  };
}

describe("FakeIOSCtrlProxyManager", function() {
  let fakeManager: FakeIOSCtrlProxyManager;

  beforeEach(function() {
    fakeManager = new FakeIOSCtrlProxyManager();
  });

  describe("state configuration", function() {
    test("should configure installed state", async function() {
      expect(await fakeManager.isInstalled()).toBe(false);

      fakeManager.setInstalled(true);
      expect(await fakeManager.isInstalled()).toBe(true);
    });

    test("should configure running state", async function() {
      expect(await fakeManager.isRunning()).toBe(false);

      fakeManager.setRunning(true);
      expect(await fakeManager.isRunning()).toBe(true);
    });

    test("should configure available state", async function() {
      expect(await fakeManager.isAvailable()).toBe(false);

      fakeManager.setAvailable(true);
      expect(await fakeManager.isAvailable()).toBe(true);
    });
  });

  describe("operation tracking", function() {
    test("should track isInstalled calls", async function() {
      await fakeManager.isInstalled();
      await fakeManager.isInstalled();

      expect(fakeManager.wasMethodCalled("isInstalled")).toBe(true);
      expect(fakeManager.getCallCount("isInstalled")).toBe(2);
    });

    test("should track isRunning calls", async function() {
      await fakeManager.isRunning();

      expect(fakeManager.wasMethodCalled("isRunning")).toBe(true);
      expect(fakeManager.getCallCount("isRunning")).toBe(1);
    });

    test("should track setup calls with force parameter", async function() {
      await fakeManager.setup(false);
      await fakeManager.setup(true);

      const operations = fakeManager.getExecutedOperations();
      expect(operations).toContain("setup:force=false");
      expect(operations).toContain("setup:force=true");
    });

    test("should clear history", async function() {
      await fakeManager.isInstalled();
      await fakeManager.isRunning();

      expect(fakeManager.getExecutedOperations().length).toBe(2);

      fakeManager.clearHistory();
      expect(fakeManager.getExecutedOperations().length).toBe(0);
    });
  });

  describe("start and stop", function() {
    test("should set running state on start", async function() {
      expect(await fakeManager.isRunning()).toBe(false);

      await fakeManager.start();
      expect(await fakeManager.isRunning()).toBe(true);
      expect(fakeManager.wasMethodCalled("start")).toBe(true);
    });

    test("should clear running state on stop", async function() {
      fakeManager.setRunning(true);
      expect(await fakeManager.isRunning()).toBe(true);

      await fakeManager.stop();
      expect(await fakeManager.isRunning()).toBe(false);
      expect(fakeManager.wasMethodCalled("stop")).toBe(true);
    });

    test("should fail start when configured to fail", async function() {
      fakeManager.setStartShouldFail(true);

      await expect(fakeManager.start()).rejects.toThrow("Failed to start IOSCtrlProxy");
    });

    test("should fail stop when configured to fail", async function() {
      fakeManager.setStopShouldFail(true);

      await expect(fakeManager.stop()).rejects.toThrow("Failed to stop IOSCtrlProxy");
    });
  });

  describe("setup", function() {
    test("should return success when service starts", async function() {
      const result = await fakeManager.setup();

      expect(result.success).toBe(true);
      expect(result.message).toBe("IOSCtrlProxy started successfully");
    });

    test("should return already running message when service is running", async function() {
      fakeManager.setRunning(true);

      const result = await fakeManager.setup(false);

      expect(result.success).toBe(true);
      expect(result.message).toBe("IOSCtrlProxy was already running");
    });

    test("should force restart even when running", async function() {
      fakeManager.setRunning(true);

      const result = await fakeManager.setup(true);

      expect(result.success).toBe(true);
      expect(result.message).toBe("IOSCtrlProxy started successfully");
    });

    test("should return failure when setup fails", async function() {
      fakeManager.setSetupShouldFail(true);

      const result = await fakeManager.setup();

      expect(result.success).toBe(false);
      expect(result.message).toBe("Failed to setup IOSCtrlProxy");
      expect(result.error).toBe("Mock setup failure");
    });
  });

  describe("getServicePort", function() {
    test("should return default port", function() {
      expect(fakeManager.getServicePort()).toBe(8765);
    });

    test("should return configured port", function() {
      fakeManager.setServicePort(9999);
      expect(fakeManager.getServicePort()).toBe(9999);
    });
  });
});
