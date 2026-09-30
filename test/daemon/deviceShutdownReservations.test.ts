import { describe, expect, test } from "bun:test";
import { Mutex } from "async-mutex";
import {
  DeviceShutdownReservations,
  type DeviceShutdownReservationsPoolPort,
} from "../../src/daemon/deviceShutdownReservations";
import type { PooledDevice, ShutdownIdentityReservation } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";

const deviceId = "emulator-5554";

function pooled(id = deviceId, incarnation = 1): PooledDevice {
  return {
    id,
    name: "Pixel",
    avdName: "Pixel",
    platform: "android",
    status: "idle",
    sessionId: null,
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation,
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
  const mutex = new Mutex();
  const devices = new Map<string, PooledDevice>();
  const intentional = new Map<string, number>();
  const calls: string[] = [];
  const port: DeviceShutdownReservationsPoolPort = {
    getDevices: () => devices,
    getAssignmentMutex: () => mutex,
    getIntentionalShutdowns: () => intentional,
    assertReadinessReservationOwner: () => calls.push("owner"),
    assertRuntimeIdentity: () => calls.push("identity"),
    assertAndroidRecoveryExclusionForReadinessReservation: () => calls.push("recovery exclusion"),
    reserveShutdownSessionIdentity: (id): ShutdownIdentityReservation => {
      calls.push("capture");
      return {
        device: devices.get(id),
        assignmentCount: devices.get(id)?.assignmentCount,
        session: undefined,
        releaseSession: () => {
          calls.push("release session");
        },
      };
    },
    completeShutdownSessionIdentity: () => {
      calls.push("complete");
    },
    reserveMcpSessionRecoveryLease: () => {
      calls.push("lease");
    },
    releaseMcpSessionRecoveryLease: () => {
      calls.push("release lease");
    },
    getOwnedAutolockSession: () => {
      calls.push("autolock");
    },
  };
  return {
    reservations: new DeviceShutdownReservations(port),
    devices,
    intentional,
    calls,
    mutex,
    timer,
  };
}

const identity = { deviceId, name: "Pixel", platform: "android" as const, observedAt: 1 };

describe("DeviceShutdownReservations", () => {
  test("readiness reserves an incarnation and releases its name once", async () => {
    const h = harness();
    const first = pooled();
    h.devices.set(deviceId, first);
    const release = await h.reservations.reserveDeviceForReadiness(deviceId, identity);
    expect(h.calls).toEqual(["owner", "identity", "recovery exclusion"]);
    expect(h.reservations.isReservedForReadiness(deviceId)).toBe(true);
    expect(h.reservations.hasReadinessNameReservation(first)).toBe(false);
    expect(h.reservations.hasReadinessNameReservation(pooled("emulator-5556", 2))).toBe(true);
    expect(release.owner).toBeDefined();
    await release();
    await release();
    expect(h.reservations.isReservedForReadiness(deviceId)).toBe(false);
    expect(h.reservations.hasReadinessNameReservation(pooled("emulator-5556", 2))).toBe(false);
  });

  test("shutdown captures under the mutex and release keeps a replacement", async () => {
    const h = harness();
    const first = pooled();
    h.devices.set(deviceId, first);
    const reservation = await h.reservations.reserveDeviceForShutdown(deviceId);
    expect(reservation?.device).toBe(first);
    expect(h.calls).toEqual(["capture", "autolock", "complete", "lease"]);
    expect(h.reservations.isReservedForShutdown(first)).toBe(true);
    expect(await h.reservations.isShutdownReserved(deviceId)).toBe(true);
    h.devices.set(deviceId, pooled(deviceId, 2));
    expect(h.reservations.isDeviceUnderShutdown(deviceId)).toBe(false);
    await reservation?.release();
    await reservation?.release();
    reservation?.releaseRecoveryRouteLease();
    expect(h.calls).toEqual([
      "capture",
      "autolock",
      "complete",
      "lease",
      "release session",
      "release lease",
    ]);
  });

  test("abort while waiting for the mutex releases the captured session", async () => {
    const h = harness();
    h.devices.set(deviceId, pooled());
    const unlock = await h.mutex.acquire();
    const controller = new AbortController();
    const pending = h.reservations.reserveDeviceForShutdown(deviceId, controller.signal);
    await flushUntil(() => h.calls.includes("capture"));
    const delayedAbort = h.timer.sleep(5).then(() => controller.abort(new Error("cancelled")));
    h.timer.advanceTime(5);
    await delayedAbort;
    unlock();
    await expect(pending).rejects.toThrow("cancelled");
    expect(h.reservations.isReservedForShutdown(h.devices.get(deviceId)!)).toBe(false);
    expect(h.calls).toEqual(["capture", "release session", "release lease", "release session"]);
  });
});
