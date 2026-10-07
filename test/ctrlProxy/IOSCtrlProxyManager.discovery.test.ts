import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyHealthClient } from "../../src/ctrlProxy/ios/IosCtrlProxyHealthClient";
import { PortManager } from "../../src/utils/PortManager";
import { createExecResult } from "../../src/utils/execResult";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { platform: "ios" as const, deviceId: "SIM-1", name: "iPhone" };

describe("IOSCtrlProxyManager doctor discovery", () => {
  let timer: FakeTimer;
  let base: ReturnType<typeof spyOn<typeof PortManager, "getBasePort">>;
  let size: ReturnType<typeof spyOn<typeof PortManager, "getMaxDevices">>;
  beforeEach(() => {
    timer = new FakeTimer();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
    base = spyOn(PortManager, "getBasePort").mockReturnValue(8765);
    size = spyOn(PortManager, "getMaxDevices").mockReturnValue(8);
  });
  afterEach(() => {
    base.mockRestore();
    size.mockRestore();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  function managerWithRunner(port: number | null, deviceId = device.deviceId) {
    const executor = new FakeProcessExecutor();
    const ports: number[] = [];
    executor.setCommandHandler("curl", (command) => {
      const endpoint = command.split(" ").at(-1)!;
      const requestedPort = Number(new URL(endpoint).port);
      ports.push(requestedPort);
      return createExecResult(
        requestedPort === port ? JSON.stringify({ status: "ok", deviceId, port: 9100 }) : "",
        "",
      );
    });
    return {
      ports,
      executor,
      manager: IOSCtrlProxyManager.createForTestingWithDeps(device, timer, undefined, executor),
    };
  }

  test("returns the matching answering host port rather than the advertised port", async () => {
    const { manager, ports } = managerWithRunner(8768);
    expect(await manager.discoverRunnerPort()).toBe(8768);
    expect(ports).toContain(8768);
    expect(manager.getServicePort()).toBe(8765);
  });

  test("rejects a sibling runner and an anonymous or Android health response", async () => {
    const sibling = managerWithRunner(8768, "SIM-OTHER");
    expect(await sibling.manager.discoverRunnerPort()).toBeNull();
    for (const body of [JSON.stringify({ status: "ok" }), "OK"]) {
      const executor = new FakeProcessExecutor();
      executor.setCommandResponse("curl", createExecResult(body, ""));
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        device,
        timer,
        undefined,
        executor,
      );
      expect(await manager.discoverRunnerPort()).toBeNull();
    }
  });

  test("returns null when nothing answers", async () => {
    expect(await managerWithRunner(null).manager.discoverRunnerPort()).toBeNull();
  });

  test("honors the configured range count and skips scanning for a service-port answer", async () => {
    size.mockReturnValue(3);
    const outside = managerWithRunner(8768);
    expect(await outside.manager.discoverRunnerPort()).toBeNull();
    expect(outside.ports).toEqual([8765, 8766, 8767]);
    const service = managerWithRunner(8765);
    expect(await service.manager.discoverRunnerPort()).toBe(8765);
    expect(service.ports).toEqual([8765]);
  });

  test("uses the configured base and skips scanning for a default-port answer", async () => {
    base.mockReturnValue(9000);
    size.mockReturnValue(3);
    const configured = managerWithRunner(9002);
    expect(await configured.manager.discoverRunnerPort()).toBe(9002);
    expect(configured.ports).toEqual([8765, 9000, 9001, 9002]);
    PortManager.reserve(device.deviceId, 9000);
    const fallback = managerWithRunner(8765);
    expect(await fallback.manager.discoverRunnerPort()).toBe(8765);
    expect(fallback.ports).toEqual([9000, 8765]);
  });

  test("limits window concurrency to four and bounds each probe to 250ms", async () => {
    base.mockReturnValue(8766);
    const { manager } = managerWithRunner(null);
    const started = Promise.withResolvers<void>();
    const pending: { signal?: AbortSignal; resolve: (healthy: boolean) => void }[] = [];
    let active = 0;
    let maxActive = 0;
    const probe = spyOn(
      IosCtrlProxyHealthClient.prototype,
      "checkHealthEndpointOnPortForDevice",
    ).mockImplementation(async (port, deviceId, timeoutMs, options) => {
      expect(deviceId).toBe(device.deviceId);
      expect(timeoutMs).toBe(250);
      if (port === 8765) {
        return false;
      }
      active++;
      maxActive = Math.max(maxActive, active);
      const result = await new Promise<boolean>((resolve) => {
        pending.push({ signal: options?.signal, resolve });
        if (pending.length === 4) {
          started.resolve();
        }
      });
      active--;
      return result;
    });
    const discovery = manager.discoverRunnerPort();
    try {
      await started.promise;
      expect(maxActive).toBe(4);
      timer.advanceTime(250);
      expect(pending.every((p) => p.signal?.aborted)).toBe(true);
      // Resolve timed-out transport fakes before the next batch begins.
      pending.forEach((p) => p.resolve(false));
      probe.mockImplementation(async () => false);
      expect(await discovery).toBeNull();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      probe.mockRestore();
    }
  });

  test("honors total timeout and abort without starting more probes", async () => {
    for (const abort of [false, true]) {
      const { manager } = managerWithRunner(null);
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      let observedSignal: AbortSignal | undefined;
      const probe = spyOn(
        IosCtrlProxyHealthClient.prototype,
        "checkHealthEndpointOnPortForDevice",
      ).mockImplementation(async (_port, _deviceId, timeoutMs, options) => {
        expect(timeoutMs).toBe(50);
        observedSignal = options?.signal;
        started.resolve();
        return new Promise<boolean>(() => {});
      });
      const discovery = manager.discoverRunnerPort({ timeoutMs: 50, signal: controller.signal });
      try {
        await started.promise;
        if (abort) {
          controller.abort(new Error("cancelled"));
        } else {
          timer.advanceTime(50);
        }
        await expect(discovery).rejects.toThrow(
          abort ? "cancelled" : "Doctor diagnostic deadline elapsed",
        );
        expect(observedSignal?.aborted).toBe(true);
        expect(probe).toHaveBeenCalledTimes(1);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        probe.mockRestore();
      }
    }
  });
});

describe("custom simulator device set argv", () => {
  for (const configured of [false, true]) {
    test(
      configured
        ? "injects --set immediately after simctl"
        : "preserves the original argv when unset",
      async () => {
        const previous = process.env.CORESIMULATOR_DEVICE_SET_PATH;
        try {
          if (configured) {
            process.env.CORESIMULATOR_DEVICE_SET_PATH = "/tmp/custom device set";
          } else {
            delete process.env.CORESIMULATOR_DEVICE_SET_PATH;
          }
          const prefix = configured ? ["simctl", "--set", "/tmp/custom device set"] : ["simctl"];
          const exec = new FakeProcessExecutor();
          const capture = spyOn(exec, "executeCommand");
          exec.setDefaultResponse(createExecResult(device.deviceId, ""));
          const timer = new FakeTimer();
          const manager = IOSCtrlProxyManager.createForTestingWithDeps(
            device,
            timer,
            undefined,
            exec,
          );
          expect(await manager["isSimulatorDetected"]()).toBe(true);
          expect(capture.mock.calls).toEqual([["xcrun", [...prefix, "list", "devices"]]]);
          expect(timer.getSleepHistory()).toEqual([]);
        } finally {
          PortManager.reset();
          if (previous === undefined) {
            delete process.env.CORESIMULATOR_DEVICE_SET_PATH;
          } else {
            process.env.CORESIMULATOR_DEVICE_SET_PATH = previous;
          }
        }
      },
    );
  }
});
