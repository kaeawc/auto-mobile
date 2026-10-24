import { describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { PortManager } from "../../src/utils/PortManager";
import { SimulatorShutDownError } from "../../src/ctrlProxy/ios/SimulatorShutDownError";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { createExecResult } from "../../src/utils/execResult";
import { createStartableBuilder } from "../helpers/iosCtrlProxyBuilderFake";
import {
  createManagerWithOwnSteps,
  createSupervisorProbe,
  deferred,
  flushUntil,
  installIosManagerSuiteHooks,
} from "../helpers/iosCtrlProxyManagerHarness";

describe("external simulator shutdown", () => {
  let device: BootedDevice;
  let timer: FakeTimer;
  installIosManagerSuiteHooks((ctx) => {
    device = ctx.testDevice;
    timer = ctx.fakeTimer;
  });

  function fixture(initialState = "Shutdown") {
    const executor = new FakeProcessExecutor();
    const probe = createSupervisorProbe();
    let state = initialState;
    let launches = 0;
    executor.setCommandHandler("xcrun", () => {
      if (state === "error") {
        throw new Error("simctl failed");
      }
      return createExecResult(
        state === "unknown"
          ? "{}"
          : JSON.stringify({ devices: { runtime: [{ udid: device.deviceId, state }] } }),
        "",
      );
    });
    const { manager } = createManagerWithOwnSteps({
      device,
      timer,
      processExecutor: executor,
      processSupervisorFactory: probe.factory,
      steps: { uninstallLegacyAppIfPresent: async () => {} },
      builder: createStartableBuilder("/tmp/test.xctestrun", { needsRebuild: async () => false }),
      xcodebuild: {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          launches++;
          return new FakeChildProcess(timer);
        },
      },
    });
    // Only report healthy once the fake runner has actually launched.
    executor.setCommandHandler("curl -s", () =>
      createExecResult(
        launches ? JSON.stringify({ status: "ok", deviceId: device.deviceId }) : "",
        "",
      ),
    );
    return {
      manager,
      executor,
      probe,
      launches: () => launches,
      setState: (value: string) => {
        state = value;
      },
    };
  }

  test.each(["Shutdown", "Booting", "Booted", "unknown", "error"])(
    "confirms simulator state %s before retiring the runner",
    async (state) => {
      const f = fixture(state);
      const stop = spyOn(f.manager, "stop").mockResolvedValue();
      await f.manager.markSimulatorShutDownIfNotBooted();
      expect(stop).toHaveBeenCalledTimes(state === "Shutdown" || state === "Booting" ? 1 : 0);
    },
  );

  test("shutdown mark preserves an in-flight pool eviction and its port release", async () => {
    const f = fixture();
    f.manager.testHooks.register();
    const gate = deferred();
    const stop = spyOn(f.manager, "stop").mockImplementation(() => gate.promise);
    const eviction = IOSCtrlProxyManager.evictAfterDeviceRemoval(device.deviceId, timer);
    const generation = f.manager.removalGeneration;
    const mark = f.manager.markSimulatorShutDown();
    const unchanged = f.manager.removalGeneration === generation;
    const superseded = f.manager.supersededSinceRemoval(generation);
    gate.resolve();
    await Promise.all([eviction, mark]);
    expect(unchanged).toBe(true);
    expect(superseded).toBe(false);
    expect(stop).toHaveBeenCalled();
    expect(IOSCtrlProxyManager.getExistingInstance(device.deviceId)).toBeUndefined();
    expect(PortManager.getPort(device.deviceId)).toBeUndefined();
  });

  test.each(["start", "forceRestart", "setup"] as const)(
    "%s rearms only a confirmed Booted simulator",
    async (method) => {
      const f = fixture();
      await f.manager.markSimulatorShutDown();
      await expect(f.manager.start()).rejects.toThrow("shut down");
      expect(f.launches()).toBe(0);
      f.setState("Booted");
      timer.enableAutoAdvance();
      await f.manager[method]();
      expect(f.launches()).toBe(1);
      expect(f.manager.getForcedRestartBudget().snapshot().state).not.toBe("suspended");
      await f.manager.stop();
    },
  );

  test("start never rearms a pool removal even when Booted", async () => {
    const f = fixture("Booted");
    await f.manager.suspendForDeviceRemoval();
    await expect(f.manager.start()).rejects.toThrow("absent from discovery");
    expect(f.launches()).toBe(0);
  });

  test("start rejects external shutdown before xcodebuild launches", async () => {
    const f = fixture();
    timer.enableAutoAdvance();
    await expect(f.manager.start()).rejects.toBeInstanceOf(SimulatorShutDownError);
    expect(f.launches()).toBe(0);
    await flushUntil(
      () => f.manager.getForcedRestartBudget().snapshot().state === "suspended",
      "removal suspension",
    );
  });

  test("forceRestart rejects shutdown without waiting on its own teardown", async () => {
    const f = fixture();
    timer.enableAutoAdvance();
    await expect(f.manager.forceRestart()).rejects.toBeInstanceOf(SimulatorShutDownError);
    await f.manager.markSimulatorShutDown();
    expect(f.launches()).toBe(0);
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
  });

  test("Booted simulator launches normally", async () => {
    const f = fixture("Booted");
    timer.enableAutoAdvance();
    await f.manager.start();
    expect(f.launches()).toBe(1);
    await f.manager.stop();
  });

  test("supervisor exit cannot restart a shutdown simulator and reappearance rearms", async () => {
    const f = fixture();
    f.manager.trackStartedXcodebuild(new FakeChildProcess(timer));
    await f.probe.supervisor.start();
    f.probe.supervisor.processExited();
    await flushUntil(() => f.probe.supervisor.isRestartPending(), "restart backoff");
    await timer.advanceTimeAsync(10_000);
    await flushUntil(() => !f.probe.supervisor.isRestartPending(), "blocked restart cleanup");
    expect(f.launches()).toBe(0);
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
    await timer.advanceTimeAsync(60_000);
    expect(f.launches()).toBe(0);
    f.setState("Booted");
    await f.manager.rearmAfterDeviceReappearance();
    timer.enableAutoAdvance();
    await f.manager.start();
    expect(f.launches()).toBe(1);
    await f.manager.stop();
  });

  test.each(["Shutdown", "Booting"])("health miss stops the live runner in %s", async (state) => {
    const f = fixture(state);
    f.manager.trackStartedXcodebuild(new FakeChildProcess(timer));
    const stop = spyOn(f.manager, "stop");
    await f.probe.supervisor.start();
    expect(await f.probe.supervisor.isAlive()).toBe(false);
    await flushUntil(() => stop.mock.calls.length === 1, "runner stop");
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
    await f.manager.markSimulatorShutDown();
    expect(f.manager.getXcTestProcessId()).toBeNull();
  });

  test("health miss with a Booted simulator retains the live runner until the miss threshold", async () => {
    const f = fixture("Booted");
    f.manager.trackStartedXcodebuild(new FakeChildProcess(timer));
    const stop = spyOn(f.manager, "stop");
    await f.probe.supervisor.start();
    expect(await f.probe.supervisor.isAlive()).toBe(true);
    expect(await f.probe.supervisor.isAlive()).toBe(true);
    expect(await f.probe.supervisor.isAlive()).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("idle");
    f.probe.supervisor.stop();
    await f.manager.stop();
  });

  test("concurrent and repeated shutdown marks stop once and permit later episodes", async () => {
    const f = fixture();
    const gate = deferred();
    const stop = spyOn(f.manager, "stop").mockImplementation(() => gate.promise);
    const first = f.manager.markSimulatorShutDown();
    const second = f.manager.markSimulatorShutDown();
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
    await flushUntil(() => stop.mock.calls.length > 0, "first stop");
    expect(stop).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([first, second]);
    await f.manager.markSimulatorShutDown();
    expect(stop).toHaveBeenCalledTimes(1);
    await f.manager.rearmAfterDeviceReappearance();
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("idle");
    await f.manager.markSimulatorShutDown();
    expect(stop).toHaveBeenCalledTimes(2);
    await f.manager.rearmAfterDeviceReappearance();
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("idle");
  });
  test("physical device shutdown marks are a no-op", async () => {
    const manager = IOSCtrlProxyManager.createForTestingWithDeps({
      device: { ...device, deviceId: "00008120-001C2D3E1234567A" },
      timer,
      processExecutor: new FakeProcessExecutor(),
    });
    const stop = spyOn(manager, "stop");
    await manager.markSimulatorShutDown();
    expect(stop).not.toHaveBeenCalled();
    expect(manager.getForcedRestartBudget().snapshot().state).toBe("idle");
  });

  test("reappearance during shutdown cleanup waits and rearms", async () => {
    const f = fixture();
    const gate = deferred();
    spyOn(f.manager, "stop").mockImplementation(() => gate.promise);
    const removal = f.manager.markSimulatorShutDown();
    const rearm = f.manager.rearmAfterDeviceReappearance();
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
    gate.resolve();
    await Promise.all([removal, rearm]);
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("idle");
    await f.manager.markSimulatorShutDown();
    await f.manager.rearmAfterDeviceReappearance();
    expect(f.manager.getForcedRestartBudget().snapshot().state).toBe("idle");
  });
});
