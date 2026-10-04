import { DeviceIdentityQuarantinedError } from "../../src/models/DeviceIdentityQuarantinedError";
import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type { PooledDevice } from "../../src/daemon/devicePool";
import {
  DeviceRuntimeIdentity,
  type DeviceRuntimeIdentityPoolPort,
} from "../../src/daemon/deviceRuntimeIdentity";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";

const id = "emulator-5554";
const observed = (name: string, observedAt: number): BootedDevice => ({
  deviceId: id,
  name,
  platform: "android",
  observedAt,
});

function pooled(): PooledDevice {
  return {
    id,
    name: "Pixel",
    avdName: "Pixel",
    platform: "android",
    status: "idle",
    sessionId: "session-1",
    lastUsedAt: 0,
    assignmentCount: 1,
    errorCount: 0,
    incarnation: 1,
  };
}

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition did not settle within 100 microtasks");
}

function harness() {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const devices = new Map<string, PooledDevice>();
  const manager = new FakeDeviceManager();
  const calls: string[] = [];
  const deviceCalls: string[] = [];
  let generation = 1;
  const port: DeviceRuntimeIdentityPoolPort = {
    getDevices: () => devices,
    getDeviceManager: () => manager,
    getRetryExecutor: () => new DefaultRetryExecutor(timer),
    getTimer: () => timer,
    getRefreshGeneration: () => generation,
    hasReusableSerial: (device) => device.id.startsWith("emulator-"),
    isReservedForShutdown: () => false,
    cancelDeviceExecutions: async (deviceId, _reason, options) => {
      deviceCalls.push(`${deviceId}:${options.excludeExecutionId ?? "all"}`);
      return 1;
    },
    cancelDeviceSessionExecutions: async (sessionId, _reason, options) => {
      calls.push(`${sessionId}:${options.excludeExecutionId ?? "all"}`);
      return 1;
    },
  };
  return {
    identity: new DeviceRuntimeIdentity(port),
    devices,
    manager,
    calls,
    deviceCalls,
    timer,
    nextGeneration: () => {
      generation += 1;
    },
  };
}

describe("DeviceRuntimeIdentity", () => {
  test("admission refusal has a quarantine type and preserves the existing message", () => {
    const h = harness();
    const device = pooled();
    device.identityUnresolved = true;
    h.devices.set(device.id, device);
    expect(() =>
      h.identity.assertDeviceActionable(device.id, "to verify Android device readiness"),
    ).toThrow(DeviceIdentityQuarantinedError);
    expect(() =>
      h.identity.assertDeviceActionable(device.id, "to verify Android device readiness"),
    ).toThrow(
      h.identity.describeUnresolvedPooledIdentity(
        device,
        "Refusing to verify Android device readiness on device",
      ),
    );
  });

  test("quarantine cancels by device even when the pool has no session", async () => {
    const h = harness();
    const device = pooled();
    device.sessionId = undefined;
    h.devices.set(id, device);
    await h.identity.reconcileDiscoveryObservation([observed("Other", 20)], "test", {
      excludeExecutionId: "own-execution",
    });
    expect(device.identityUnresolved).toBe(true);
    expect(h.deviceCalls).toEqual([`${id}:own-execution`]);
    expect(h.calls).toEqual([]);
  });

  test("a matching AVD advances evidence and stale disagreement cannot quarantine", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(id, device);
    await h.identity.reconcileDiscoveryObservation([observed("Pixel", 20)], "test");
    expect(device.identityObservedAt).toBe(20);
    await h.identity.reconcileDiscoveryObservation([observed("Other", 10)], "test");
    expect(device.identityUnresolved).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  test("disagreement quarantines once, cancels other work, and a resolved name lifts it", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(id, device);
    await h.identity.reconcileDiscoveryObservation([observed("Other", 20)], "test", {
      excludeExecutionId: "own-execution",
    });
    expect(device.identityUnresolved).toBe(true);
    expect(h.calls).toEqual(["session-1:own-execution"]);
    expect(() => h.identity.assertDeviceActionable(id, "tap")).toThrow("identity is unresolved");
    await h.identity.reconcileDiscoveryObservation([observed("Pixel", 21)], "test");
    expect(device.identityUnresolved).toBeUndefined();
    expect(h.identity.describesPooledRuntime(observed("Pixel", 21))).toBe(true);
  });

  test("confirmed AVD mapping survives a transient unreadable name", async () => {
    const h = harness();
    const device = pooled();
    h.devices.set(id, device);
    h.manager.bootedDevices = [observed("Pixel", 22)];
    const pending = h.identity.reconcileDiscoveryObservation(
      [observed(`Unknown (${id})`, 20)],
      "test",
    );
    await flushUntil(() => device.identityReconcileAttempts !== undefined);
    expect(device.identityUnresolved).toBeUndefined();
    await pending;
    expect(device.identityReconcileAttempts).toBeUndefined();
    expect(device.identityObservedAt).toBe(22);
    expect(h.calls).toEqual([]);
  });

  test("pending replacement retains newer evidence in its single owner", async () => {
    const h = harness();
    h.identity.beginPendingReplacement(observed("Other", 10));
    await h.identity.reconcileDiscoveryObservation([observed("New", 12)], "test");
    expect(h.identity.getPendingReplacement(id)?.name).toBe("New");
    await h.identity.reconcileDiscoveryObservation([observed(`Unknown (${id})`, 13)], "test");
    expect(h.identity.getPendingUnresolvedEvidence(id)?.observedAt).toBe(13);
    h.identity.clearPendingReplacement(id);
    expect(h.identity.getPendingReplacement(id)).toBeUndefined();
    expect(h.identity.getPendingUnresolvedEvidence(id)).toBeUndefined();
  });
});
