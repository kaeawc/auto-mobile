import { describe, expect, spyOn, test } from "bun:test";
import { SessionManager, PLAN_AUTO_RELEASE_REASON } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { ActionableError } from "../../src/models/ActionableError";
import {
  LocationRouteRegistry,
  registerLocationRouteSessionCleanup,
} from "../../src/features/utility/LocationRoutePlayer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { DeviceState } from "../../src/features/utility/DeviceState";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeEmulatorConsoleClient } from "../fakes/FakeEmulatorConsoleClient";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import {
  createSessionLocationAppliedCallback,
  createSessionLocationWriteAdmission,
} from "../../src/server/sessionLocation";
import { MockLocationClearRegistry } from "../../src/features/utility/MockLocationClear";

const deviceId = "emulator-5554";
const points = [
  { latitude: 0, longitude: 0 },
  { latitude: 0, longitude: 0.001 },
];
const flush = async () => {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
};
const harness = () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  const registry = new LocationRouteRegistry(timer);
  registerLocationRouteSessionCleanup(manager, { registry });
  return { timer, manager, registry };
};

describe("session location admission", () => {
  test("write admission evaluates the captured session lazily", async () => {
    const { manager } = harness();
    let admitted = false;
    const admission = spyOn(manager, "isAdmittedForAutomation").mockImplementation(
      (session) => admitted && manager.isCurrentSession(session),
    );
    try {
      await manager.createSession("session", deviceId, "android");
      const canWrite = createSessionLocationWriteAdmission({
        sessionManager: manager,
        sessionUuid: "session",
        deviceId,
      });
      expect(canWrite()).toBe(false);
      admitted = true;
      expect(canWrite()).toBe(true);
    } finally {
      admission.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  for (const phase of ["released", "rebound", "replaced", "other device"] as const) {
    test(`captured write admission remains false when ${phase}`, async () => {
      const { manager } = harness();
      try {
        await manager.createSession("session", deviceId, "android");
        const canWrite = createSessionLocationWriteAdmission({
          sessionManager: manager,
          sessionUuid: "session",
          deviceId: phase === "other device" ? "emulator-5556" : deviceId,
        });
        if (phase === "rebound") {
          await manager.rebindSession("session", "emulator-5556", "android");
        } else if (phase !== "other device") {
          await manager.releaseSession(
            "session",
            phase === "replaced" ? PLAN_AUTO_RELEASE_REASON : undefined,
          );
          if (phase === "replaced") {
            await manager.createSession("session", deviceId, "android");
          }
        }
        expect(canWrite()).toBe(false);
      } finally {
        manager.stopCleanupTimer();
      }
    });
  }

  for (const admittedAtApply of [true, false]) {
    test(`apply-time attribution records a marker only when admitted: ${admittedAtApply}`, async () => {
      const { timer, manager, registry } = harness();
      const device = {
        deviceId: "12345678-1234-1234-1234-123456789ABC",
        platform: "ios" as const,
        name: "iPhone",
      };
      const simctl = new FakeSimCtlClient();
      const clears = new MockLocationClearRegistry({ timer, simctlFactory: () => simctl });
      registerLocationRouteSessionCleanup(manager, { registry, mockLocationClears: clears });
      let admitted = false;
      const admission = spyOn(manager, "isAdmittedForAutomation").mockImplementation(
        (session) => admitted && manager.isCurrentSession(session),
      );
      const markSet = spyOn(clears, "markSet");
      try {
        await manager.createSession("session", device.deviceId, "ios");
        const applied = createSessionLocationAppliedCallback({
          sessionManager: manager,
          sessionUuid: "session",
          device,
          mockLocationClears: clears,
        });
        expect(applied).toBeDefined();
        admitted = admittedAtApply;
        applied!();
        expect(markSet).toHaveBeenCalledTimes(admittedAtApply ? 1 : 0);
        await manager.releaseSession("session");
        await manager.getPendingDeviceCleanup(device.deviceId);
        expect(simctl.getMethodCalls("executeCommandArgs")).toEqual(
          admittedAtApply
            ? [{ args: ["location", device.deviceId, "clear"], timeoutMs: 5000 }]
            : [],
        );
      } finally {
        markSet.mockRestore();
        admission.mockRestore();
        manager.stopCleanupTimer();
      }
    });
  }

  test("handler attribution marks only admitted session-bound writes on the assigned device", async () => {
    const { timer, manager } = harness();
    const device = {
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      platform: "ios" as const,
      name: "iPhone",
    };
    const simctl = new FakeSimCtlClient();
    const clears = new MockLocationClearRegistry({ timer, simctlFactory: () => simctl });
    try {
      await manager.createSession("session", device.deviceId, "ios");
      expect(
        createSessionLocationAppliedCallback({ device, mockLocationClears: clears }),
      ).toBeUndefined();
      expect(
        createSessionLocationAppliedCallback({
          sessionUuid: "session",
          device,
          mockLocationClears: clears,
        }),
      ).toBeUndefined();
      expect(
        createSessionLocationAppliedCallback({
          sessionManager: manager,
          device,
          mockLocationClears: clears,
        }),
      ).toBeUndefined();
      expect(
        createSessionLocationAppliedCallback({
          sessionManager: manager,
          sessionUuid: "missing",
          device,
          mockLocationClears: clears,
        }),
      ).toBeUndefined();
      const otherDeviceApplied = createSessionLocationAppliedCallback({
        sessionManager: manager,
        sessionUuid: "session",
        device: { ...device, deviceId: "other" },
        mockLocationClears: clears,
      });
      expect(otherDeviceApplied).toBeDefined();
      otherDeviceApplied!();
      expect(clears.clearAfter("session", "other", Promise.resolve())).toBeNull();
      const callback = createSessionLocationAppliedCallback({
        sessionManager: manager,
        sessionUuid: "session",
        device,
        mockLocationClears: clears,
      });
      expect(callback).toBeDefined();
      callback!();
      await clears.clearAfter("session", device.deviceId, Promise.resolve());
      expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
      await manager.releaseSession("session");
      expect(
        createSessionLocationAppliedCallback({
          sessionManager: manager,
          sessionUuid: "session",
          device,
          mockLocationClears: clears,
        }),
      ).toBeUndefined();
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("direct-mode static fix is not cleared by a later session release", async () => {
    const { timer, manager, registry } = harness();
    const device = {
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      platform: "ios" as const,
      name: "iPhone",
    };
    const simctl = new FakeSimCtlClient();
    const clears = new MockLocationClearRegistry({ timer, simctlFactory: () => simctl });
    const markSet = spyOn(clears, "markSet");
    registerLocationRouteSessionCleanup(manager, { registry, mockLocationClears: clears });
    try {
      const state = new DeviceState(device, {
        timer,
        routeRegistry: registry,
        simctl,
        onLocationApplied: createSessionLocationAppliedCallback({
          device,
          mockLocationClears: clears,
        }),
      });
      await state.setState({ location: { mode: "static", latitude: 1, longitude: 2 } });
      expect(markSet).not.toHaveBeenCalled();
      await manager.createSession("session", device.deviceId, "ios");
      await manager.releaseSession("session");
      expect(manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(simctl.getMethodCalls("executeCommandArgs")).toHaveLength(1);
      expect(simctl.getMethodCalls("executeCommandArgs")[0].args[2]).toBe("set");
    } finally {
      markSet.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  for (const phase of ["releasing", "rebinding", "rebound", "released", "missing"] as const) {
    test(`refuses a route for the old device when ${phase}`, async () => {
      const { manager, registry, timer } = harness();
      const finished = Promise.withResolvers<void>();
      let transition: Promise<unknown> | undefined;
      let setup: Promise<void> | undefined;
      let writes = 0;
      let mutations = 0;
      try {
        if (phase !== "missing") {
          await manager.createSession("session", deviceId, "android");
        }
        if (phase === "releasing" || phase === "rebinding") {
          setup = manager.trackSessionSetup(manager.getSession("session")!, () => finished.promise);
          transition =
            phase === "releasing"
              ? manager.releaseSession("session")
              : manager.rebindSession("session", "emulator-5556", "android");
        } else if (phase === "rebound") {
          await manager.rebindSession("session", "emulator-5556", "android");
        } else if (phase === "released") {
          await manager.releaseSession("session");
        }
        const { runSessionLocationMutation } = await import("../../src/server/sessionLocation");
        await expect(
          runSessionLocationMutation({
            sessionManager: manager,
            sessionUuid: "session",
            deviceId,
            mutation: async () => {
              mutations++;
              registry.start(deviceId, points, 1000, 500, true, async () => {
                writes++;
              });
            },
          }),
        ).rejects.toBeInstanceOf(ActionableError);
        timer.advanceTime(0);
        await flush();
        expect(mutations).toBe(0);
        expect(writes).toBe(0);
        expect(registry.isActive(deviceId)).toBe(false);
      } finally {
        finished.resolve();
        await setup;
        await transition;
        registry.stopAll();
        manager.stopCleanupTimer();
      }
    });
  }

  test("tracks admitted work so release drains it; sessionless work remains direct", async () => {
    const { manager } = harness();
    const finished = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      const { runSessionLocationMutation } = await import("../../src/server/sessionLocation");
      await manager.createSession("session", deviceId, "android");
      const mutation = runSessionLocationMutation({
        sessionManager: manager,
        sessionUuid: "session",
        deviceId,
        mutation: async () => {
          entered.resolve();
          await finished.promise;
          return "changed";
        },
      });
      await entered.promise;
      let released = false;
      const release = manager.releaseSession("session").then(() => {
        released = true;
      });
      await flush();
      expect(released).toBe(false);
      finished.resolve();
      expect(await mutation).toBe("changed");
      await release;
      expect(await runSessionLocationMutation({ deviceId, mutation: async () => "direct" })).toBe(
        "direct",
      );
    } finally {
      finished.resolve();
      manager.stopCleanupTimer();
    }
  });
});

describe("session route cleanup", () => {
  test("a successful static set after bounded release drain still clears and quarantines", async () => {
    const { timer, manager, registry } = harness();
    const device = {
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      platform: "ios" as const,
      name: "iPhone",
    };
    const finished = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    class DelayedSet extends FakeSimCtlClient {
      override async executeCommandArgs(args: string[], timeoutMs?: number) {
        if (args[2] === "set") {
          entered.resolve();
          await finished.promise;
        }
        return super.executeCommandArgs(args, timeoutMs);
      }
    }
    const simctl = new DelayedSet();
    const clears = new MockLocationClearRegistry({ timer, simctlFactory: () => simctl });
    const markSet = spyOn(clears, "markSet");
    registerLocationRouteSessionCleanup(manager, { registry, mockLocationClears: clears });
    let mutation: Promise<unknown> | undefined;
    try {
      const { runSessionLocationMutation, createSessionLocationWriteAdmission } =
        await import("../../src/server/sessionLocation");
      await manager.createSession("session", device.deviceId, "ios");
      const scope = { sessionManager: manager, sessionUuid: "session", deviceId: device.deviceId };
      const state = new DeviceState(device, {
        timer,
        routeRegistry: registry,
        simctl,
        canWriteLocation: createSessionLocationWriteAdmission(scope),
        onLocationApplied: createSessionLocationAppliedCallback({
          ...scope,
          device,
          mockLocationClears: clears,
        }),
      });
      mutation = runSessionLocationMutation({
        ...scope,
        mutation: () => state.setState({ location: { mode: "static", latitude: 1, longitude: 2 } }),
      });
      await entered.promise;
      const release = manager.releaseSession("session");
      await flush();
      timer.advanceTime(1000);
      await release;
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
      simctl.setCommandArgsResultSequence(
        ["location", device.deviceId, "clear"],
        [new Error("busy"), { stdout: "" }],
      );
      finished.resolve();
      await mutation;
      await flush();
      expect(markSet).not.toHaveBeenCalled();
      expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args[2])).toEqual([
        "set",
        "clear",
      ]);
      const pending = manager.getPendingDeviceCleanup(device.deviceId);
      expect(pending).not.toBeNull();
      timer.advanceTime(250);
      await pending;
      expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args[2])).toEqual([
        "set",
        "clear",
        "clear",
      ]);
    } finally {
      markSet.mockRestore();
      finished.resolve();
      await mutation;
      clears.retireDevice(device.deviceId);
      await manager.getPendingDeviceCleanup(device.deviceId);
      manager.stopCleanupTimer();
    }
  });

  test("failed simulator clear quarantines the pool until its retry succeeds", async () => {
    const { timer, manager, registry } = harness();
    const device = {
      deviceId: "12345678-1234-1234-1234-123456789ABC",
      platform: "ios" as const,
      name: "iPhone",
    };
    const simctl = new FakeSimCtlClient();
    const clears = new MockLocationClearRegistry({ timer, simctlFactory: () => simctl });
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", {
        timer,
        deviceManager: new FakeDeviceManager([], [device]),
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    registerLocationRouteSessionCleanup(manager, { registry, mockLocationClears: clears });
    try {
      await pool.initializeWithDevices([device]);
      await pool.bindOrReuseDeviceSession("session", device.deviceId, "ios");
      const state = new DeviceState(device, {
        timer,
        routeRegistry: registry,
        simctl,
        onLocationApplied: createSessionLocationAppliedCallback({
          sessionManager: manager,
          sessionUuid: "session",
          device,
          mockLocationClears: clears,
        }),
      });
      await state.setState({ location: { mode: "static", latitude: 1, longitude: 2 } });
      simctl.setCommandArgsResultSequence(
        ["location", device.deviceId, "clear"],
        [new Error("busy"), { stdout: "" }],
      );
      await manager.releaseSession("session");
      await flush();
      const pending = manager.getPendingDeviceCleanup(device.deviceId);
      expect(pending).not.toBeNull();
      await pool.releaseDevice(device.deviceId, "session");
      expect(pool.getDevice(device.deviceId)?.status).toBe("busy");
      await expect(pool.bindOrReuseDeviceSession("new", device.deviceId, "ios")).rejects.toThrow(
        "cleanup",
      );
      timer.advanceTime(250);
      await pending;
      await flush();
      expect(manager.getPendingDeviceCleanup(device.deviceId)).toBeNull();
      expect(pool.getDevice(device.deviceId)?.status).toBe("idle");
      expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.args[2])).toEqual([
        "set",
        "clear",
        "clear",
      ]);
    } finally {
      clears.retireDevice(device.deviceId);
      await manager.getPendingDeviceCleanup(device.deviceId);
      manager.stopCleanupTimer();
    }
  });

  for (const platform of ["android", "ios"] as const) {
    test(`a ${platform} static fix outliving setup drain refuses to write after completed release`, async () => {
      const { timer, manager, registry } = harness();
      const targetId = platform === "android" ? deviceId : "12345678-1234-1234-1234-123456789ABC";
      const finished = Promise.withResolvers<void>();
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell getprop ro.kernel.qemu", "1\n");
      const consoleClient = new FakeEmulatorConsoleClient();
      const simctl = new FakeSimCtlClient();
      let outcome: Promise<unknown> | undefined;
      try {
        const { runSessionLocationMutation, createSessionLocationWriteAdmission } =
          await import("../../src/server/sessionLocation");
        await manager.createSession("session", targetId, platform);
        registry.start(targetId, points, 10_000, 3000, true, () => finished.promise);
        timer.advanceTime(0);
        await flush();
        const state = new DeviceState(
          { deviceId: targetId, name: "Test device", platform },
          {
            timer,
            routeRegistry: registry,
            adbFactory: new FakeAdbClientFactory(adb),
            consoleFactory: () => consoleClient,
            simctl,
            canWriteLocation: createSessionLocationWriteAdmission({
              sessionManager: manager,
              sessionUuid: "session",
              deviceId: targetId,
            }),
          },
        );
        const mutation = runSessionLocationMutation({
          sessionManager: manager,
          sessionUuid: "session",
          deviceId: targetId,
          mutation: () =>
            state.setState({ location: { mode: "static", latitude: 1, longitude: 2 } }),
        });
        outcome = mutation.then(
          (result) => result,
          (error: unknown) => error,
        );
        await flush();
        expect(registry.isActive(targetId)).toBe(false);
        timer.advanceTime(100);
        const release = manager.releaseSession("session");
        await flush();
        timer.advanceTime(1000);
        await release;
        expect(manager.getSession("session")).toBeNull();
        expect(consoleClient.calls).toEqual([]);
        expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
        finished.resolve();
        expect(await outcome).toBeInstanceOf(ActionableError);
        expect(consoleClient.calls).toEqual([]);
        expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
      } finally {
        finished.resolve();
        await outcome;
        registry.stopAll();
        manager.stopCleanupTimer();
      }
    });
  }

  test("a start outliving setup drain cannot register after release or a replacement session", async () => {
    const { timer, manager, registry } = harness();
    const probeFinished = Promise.withResolvers<void>();
    const probeStarted = Promise.withResolvers<void>();
    class DelayedAdb extends FakeAdbClient {
      override async executeCommand(command: string) {
        probeStarted.resolve();
        await probeFinished.promise;
        return super.executeCommand(command);
      }
    }
    const adb = new DelayedAdb();
    adb.setCommandResult("shell getprop ro.kernel.qemu", "1\n");
    const consoleClient = new FakeEmulatorConsoleClient();
    let mutation: Promise<unknown> | undefined;
    try {
      const { runSessionLocationMutation, createSessionLocationWriteAdmission } =
        await import("../../src/server/sessionLocation");
      await manager.createSession("session", deviceId, "android");
      const state = new DeviceState(
        { deviceId, name: "Pixel", platform: "android" },
        {
          timer,
          routeRegistry: registry,
          adbFactory: new FakeAdbClientFactory(adb),
          consoleFactory: () => consoleClient,
          canWriteLocation: createSessionLocationWriteAdmission({
            sessionManager: manager,
            sessionUuid: "session",
            deviceId,
          }),
        },
      );
      mutation = runSessionLocationMutation({
        sessionManager: manager,
        sessionUuid: "session",
        deviceId,
        mutation: () =>
          state.setState({
            location: { mode: "route", waypoints: points, durationMs: 1000, loop: true },
          }),
      });
      await probeStarted.promise;
      const outcome = mutation.then(
        () => undefined,
        (error: unknown) => error,
      );
      const release = manager.releaseSession("session", PLAN_AUTO_RELEASE_REASON);
      await flush();
      timer.advanceTime(1000);
      await release;
      expect(manager.getSession("session")).toBeNull();
      const cleanup = manager.getPendingDeviceCleanup(deviceId);
      expect(cleanup).not.toBeNull();
      // A UUID/device match is insufficient: the callback must retain the old identity.
      await manager.createSession("session", deviceId, "android");
      probeFinished.resolve();
      expect(await outcome).toBeInstanceOf(ActionableError);
      await cleanup;
      expect(registry.isActive(deviceId)).toBe(false);
      timer.advanceTime(10_000);
      await flush();
      expect(consoleClient.calls).toEqual([]);
    } finally {
      probeFinished.resolve();
      await mutation?.catch(() => undefined);
      registry.stopAll();
      manager.stopCleanupTimer();
    }
  });

  for (const phase of ["release", "rebind"] as const) {
    test(`${phase} aborts an in-flight fix and quarantines the old device until settlement`, async () => {
      const { timer, manager, registry } = harness();
      const device = { deviceId, platform: "android" as const, name: "Pixel" };
      const pool = new DevicePool(
        createDevicePoolDependencies(manager, "test-daemon", {
          timer,
          deviceManager: new FakeDeviceManager([], [device]),
          installedAppsRepository: new FakeInstalledAppsRepository(),
        }),
      );
      const finished = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      let attempts = 0;
      let writes = 0;
      try {
        await pool.initializeWithDevices([device]);
        await pool.bindOrReuseDeviceSession("session", deviceId, "android");
        registry.start(deviceId, points, 1000, 500, true, async (_point, options) => {
          signal = options.signal;
          attempts++;
          await finished.promise;
          if (!options.signal.aborted) {
            writes++;
          }
        });
        timer.advanceTime(0);
        await flush();
        expect(attempts).toBe(1);
        if (phase === "release") {
          await manager.releaseSession("session");
        } else {
          await manager.rebindSession("session", "emulator-5556", "android");
        }
        expect(signal?.aborted).toBe(true);
        expect(registry.isActive(deviceId)).toBe(false);
        const cleanup = manager.getPendingDeviceCleanup(deviceId);
        expect(cleanup).not.toBeNull();
        await pool.releaseDevice(deviceId, "session");
        expect(pool.getDevice(deviceId)?.status).toBe("busy");
        expect(pool.getStats().idle).toBe(0);
        await expect(
          pool.bindOrReuseDeviceSession("new-owner", deviceId, "android"),
        ).rejects.toThrow("cleanup");
        let settled = false;
        void cleanup?.then(() => {
          settled = true;
        });
        await flush();
        expect(settled).toBe(false);
        finished.resolve();
        await cleanup;
        await flush();
        expect(pool.getDevice(deviceId)?.status).toBe("idle");
        expect(manager.getPendingDeviceCleanup(deviceId)).toBeNull();
        timer.advanceTime(10_000);
        await flush();
        expect(attempts).toBe(1);
        expect(writes).toBe(0);
      } finally {
        finished.resolve();
        registry.stopAll();
        await manager.getPendingDeviceCleanup(deviceId);
        manager.stopCleanupTimer();
      }
    });
  }

  test("release without playback creates no device quarantine", async () => {
    const { manager } = harness();
    try {
      await manager.createSession("session", deviceId, "android");
      await manager.releaseSession("session");
      expect(manager.getPendingDeviceCleanup(deviceId)).toBeNull();
    } finally {
      manager.stopCleanupTimer();
    }
  });
});
