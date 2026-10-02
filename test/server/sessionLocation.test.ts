import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
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
  registerLocationRouteSessionCleanup(manager, registry);
  return { timer, manager, registry };
};

describe("session location admission", () => {
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
      const release = manager.releaseSession("session");
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
