import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import {
  DevicePoolRefresh,
  type DevicePoolRefreshResult,
} from "../../src/daemon/devicePoolRefresh";
import { MissingDeviceLiveness } from "../../src/daemon/missingDeviceLiveness";
import { ActionableError } from "../../src/models/ActionableError";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, SomePlatform } from "../../src/models";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
} from "../../src/devices/deviceUtils";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Each gate holds exactly one discovery, with the observation captured before
// parking. Later calls proceed independently, including a fresh retry snapshot.
class ParkingDiscovery extends FakeDeviceUtils {
  readonly calls: SomePlatform[] = [];
  private readonly gates: Array<{
    platform: SomePlatform;
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  afterSnapshot?: () => Promise<void>;

  park(platform: SomePlatform) {
    const gate = {
      platform,
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.gates.push(gate);
    return gate;
  }

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options: BootedDeviceDiscoveryOptions = {},
  ): Promise<BootedDeviceDiscovery> {
    this.calls.push(platform);
    const index = this.gates.findIndex((gate) => gate.platform === platform);
    const gate = index < 0 ? undefined : this.gates.splice(index, 1)[0];
    const snapshot = await super.getBootedDevicesDetailed(platform, options);
    if (gate) {
      gate.entered.resolve();
      await gate.release.promise;
    }
    await this.afterSnapshot?.();
    return snapshot;
  }
}

async function flushMicrotasks(rounds = 150): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

const android: BootedDevice[] = ["R58A", "R58B", "R58C", "R58D"].map((deviceId) => ({
  deviceId,
  name: deviceId,
  platform: "android",
}));
const ios: BootedDevice[] = ["SIM-A", "SIM-B", "SIM-C", "SIM-D"].map((deviceId) => ({
  deviceId,
  name: deviceId,
  platform: "ios",
}));

let pool: DevicePool;
let timer: FakeTimer;
let manager: ParkingDiscovery;
let sessions: SessionManager;
async function setup(
  devices: BootedDevice[],
  overrides: Pick<
    DevicePoolDependencies,
    "missingDeviceLivenessFactory" | "recoveryPolicy" | "devicePoolRefreshFactory"
  > = {},
): Promise<void> {
  timer = new FakeTimer();
  sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager = new ParkingDiscovery();
  manager.setBootedDevices(
    "android",
    devices.filter((d) => d.platform === "android"),
  );
  manager.setBootedDevices(
    "ios",
    devices.filter((d) => d.platform === "ios"),
  );
  pool = new DevicePool(
    createDevicePoolDependencies(sessions, "allocation-discovery", {
      timer,
      deviceManager: manager,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      retryExecutor: new DefaultRetryExecutor(timer),
      ...overrides,
    }),
  );
  await pool.initializeWithDevices(devices);
}
afterEach(() => {
  sessions?.stopCleanupTimer();
  timer?.reset();
});

// Capture rejection immediately so intentionally pending/aborted acquisitions
// never produce an unhandled rejection while another interleaving is exercised.
function acquire(
  sessionId: string,
  platform: "android" | "ios",
  controller = new AbortController(),
) {
  let settled = false;
  const result = runWithAbortSignal(controller.signal, () =>
    pool.assignDeviceToSession(sessionId, platform),
  ).then(
    (id) => {
      settled = true;
      return id;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  return { result, controller, isSettled: () => settled };
}

async function settleAcquisition(acquisition: ReturnType<typeof acquire>): Promise<unknown> {
  // Bound broken-fence retries with fake time, never the runner's real timeout.
  for (let step = 0; step < 65 && !acquisition.isSettled(); step++) {
    await flushMicrotasks(500);
    if (!acquisition.isSettled()) {
      timer.advanceTime(1000);
    }
  }
  await flushMicrotasks(500);
  if (!acquisition.isSettled()) {
    acquisition.controller.abort(timeoutReason());
    timer.resolveAll();
    await flushMicrotasks(500);
  }
  expect(acquisition.isSettled()).toBe(true);
  return await acquisition.result;
}

function timeoutReason(): McpTimeoutError {
  return new McpTimeoutError({ toolName: "getAndroid", timeoutMs: 1000, origin: "acquisition" });
}

describe("allocation discovery outside assignmentMutex", () => {
  test("concurrent empty-pool allocations await one authoritative refresh", async () => {
    await setup([]);
    manager.setBootedDevices("android", android.slice(0, 2));
    const first = manager.park("either");
    const a = acquire("a", "android");
    await first.entered.promise;
    const second = manager.park("either");
    const b = acquire("b", "android");
    await flushMicrotasks(500);
    first.release.resolve();
    try {
      await flushMicrotasks(500);
      // On the broken tree A's refresh is superseded while B is still parked.
      if (manager.calls.filter((p) => p === "either").length > 1) {
        expect(a.isSettled()).toBe(false);
      }
    } finally {
      second.release.resolve();
      first.release.resolve();
      await settleAcquisition(a);
      await settleAcquisition(b);
    }
    const ids = [await a.result, await b.result];
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(2);
    expect(manager.calls.filter((p) => p === "either")).toHaveLength(1);
  });

  for (const recovery of [false, true]) {
    test(`superseded refresh keeps ${recovery ? "exact recovery" : "ordinary allocation"} retryable`, async () => {
      await setup([]);
      manager.setBootedDevices("android", android.slice(0, 1));
      const first = manager.park("either");
      const controller = new AbortController();
      let settled = false;
      const result = runWithAbortSignal(controller.signal, () =>
        pool.assignDeviceToSession(
          "waiting",
          "android",
          recovery
            ? {
                platform: "android",
                deviceId: android[0].deviceId,
                stableDeviceId: android[0].deviceId,
                androidEmulator: false,
              }
            : undefined,
        ),
      ).then(
        (id) => {
          settled = true;
          return id;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const acquisition = { result, controller, isSettled: () => settled };
      await first.entered.promise;
      const second = manager.park("either");
      const refresh = pool.refreshDevices();
      await second.entered.promise;
      first.release.resolve();
      try {
        await flushMicrotasks(500);
        expect(acquisition.isSettled()).toBe(false);
        expect(pool.getDevice(android[0].deviceId)).toBeNull();
      } finally {
        second.release.resolve();
        await refresh;
        await settleAcquisition(acquisition);
      }
      expect(await acquisition.result).toBe(android[0].deviceId);
    });
  }

  test("refresh superseded during a pool update cannot report authoritative completeness", async () => {
    const update = Promise.withResolvers<void>();
    const releaseUpdate = Promise.withResolvers<void>();
    const results: DevicePoolRefreshResult[] = [];
    class RecordingRefresh extends DevicePoolRefresh {
      override async refreshDevicesInternal(held: boolean): Promise<DevicePoolRefreshResult> {
        const result = await super.refreshDevicesInternal(held);
        results.push(result);
        return result;
      }
    }
    await setup([], {
      devicePoolRefreshFactory: (port) =>
        new RecordingRefresh({
          ...port,
          setDeviceSessionTracking: async (id, now) => {
            await port.setDeviceSessionTracking(id, now);
            update.resolve();
            await releaseUpdate.promise;
          },
        }),
    });
    manager.setBootedDevices("android", android.slice(0, 1));
    const first = pool.refreshDevices();
    await update.promise;
    const snapshot = manager.park("either");
    const second = pool.refreshDevices();
    await snapshot.entered.promise;
    try {
      releaseUpdate.resolve();
      await first;
      expect(results[0].completeness).toBeUndefined();
    } finally {
      releaseUpdate.resolve();
      snapshot.release.resolve();
      await Promise.all([first, second]);
    }
    expect(results[1].completeness?.succeededPlatforms.has("android")).toBe(true);
  });

  test("aborting one refresh waiter preserves discovery for the other waiter", async () => {
    await setup([]);
    manager.setBootedDevices("android", android.slice(0, 1));
    const gate = manager.park("either");
    const a = acquire("aborted", "android");
    await gate.entered.promise;
    const b = acquire("survivor", "android");
    await flushMicrotasks(500);
    const reason = timeoutReason();
    a.controller.abort(reason);
    await flushMicrotasks(500);
    try {
      expect(a.isSettled()).toBe(true);
      expect(await a.result).toBe(reason);
      expect(b.isSettled()).toBe(false);
      expect(manager.calls).toEqual(["either"]);
    } finally {
      gate.release.resolve();
      await settleAcquisition(b);
    }
    expect(await b.result).toBe(android[0].deviceId);
    expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe("survivor");
  });

  for (const kind of ["android", "ios", "recoverable emulator"] as const) {
    test(`pre-lock absence preserves the same reconnected ${kind} entry`, async () => {
      const device: BootedDevice =
        kind === "ios"
          ? ios[0]
          : kind === "android"
            ? android[0]
            : {
                deviceId: "emulator-5554",
                name: "Pixel",
                platform: "android",
              };
      await setup([device], { recoveryPolicy: { onLoss: true, maxAttempts: 1 } });
      if (kind === "recoverable emulator") {
        await pool.addDevice(device, {
          name: device.name,
          platform: "android",
          isRunning: true,
          source: "local",
        });
        expect(pool.getRecoveryEligibility(device.deviceId).eligible).toBe(true);
      }
      const original = pool.getDevice(device.deviceId);
      const internals = pool as unknown as {
        assignmentMutex: { runExclusive<T>(operation: () => Promise<T>): Promise<T> };
      };
      const releaseLock = Promise.withResolvers<void>();
      const holder = internals.assignmentMutex.runExclusive(() => releaseLock.promise);
      manager.setBootedDevices(device.platform, []);
      const snapshot = manager.park(device.platform);
      const a = acquire("reconnected", device.platform);
      await snapshot.entered.promise;
      snapshot.release.resolve();
      await flushMicrotasks(500);
      manager.setBootedDevices(device.platform, [device]);
      releaseLock.resolve();
      await holder;
      expect(await settleAcquisition(a)).toBe(device.deviceId);
      expect(pool.getDevice(device.deviceId)).toBe(original);
      expect(manager.getCallCount("startDevice")).toBe(0);
      expect(manager.getCallCount("killDevice")).toBe(0);
    });
  }

  for (const [platform, devices] of [
    ["android", android],
    ["ios", ios],
  ] as const) {
    test(`parked ${platform} discovery permits release, readiness and another acquisition`, async () => {
      await setup([...devices]);
      await pool.assignDeviceToSession("busy", platform);
      const gate = manager.park(platform);
      const a = acquire("a", platform);
      await gate.entered.promise;
      let reserved = false;
      const readiness = pool
        .reserveDeviceForReadiness(devices[1].deviceId, devices[1])
        .then((reservation) => {
          reserved = true;
          return reservation;
        });
      const b = acquire("b", platform);
      try {
        await pool.releaseDevice(devices[0].deviceId, "busy");
        await flushMicrotasks();
        expect(pool.getDevice(devices[0].deviceId)?.sessionId).toBeNull();
        expect(reserved).toBe(true);
        expect(b.isSettled()).toBe(true);
        expect(a.isSettled()).toBe(false);
      } finally {
        gate.release.resolve();
        await (
          await readiness
        )();
        await Promise.all([a.result, b.result]);
      }
      expect(typeof (await a.result)).toBe("string");
      expect(await a.result).not.toBe(await b.result);
    });
  }

  test("parked allocation refresh permits release and readiness reservation", async () => {
    await setup(android.slice(0, 2));
    await pool.assignDeviceToSession("busy", "android");
    const gate = manager.park("either");
    const a = acquire("empty-ios", "ios");
    await gate.entered.promise;
    let reserved = false;
    const readiness = pool
      .reserveDeviceForReadiness(android[1].deviceId, android[1])
      .then((reservation) => {
        reserved = true;
        return reservation;
      });
    try {
      await pool.releaseDevice(android[0].deviceId, "busy");
      await flushMicrotasks();
      expect(reserved).toBe(true);
      expect(pool.getDevice(android[0].deviceId)?.sessionId).toBeNull();
    } finally {
      gate.release.resolve();
      await (
        await readiness
      )();
      await a.result;
    }
    expect(await a.result).toBeInstanceOf(Error);
    expect(manager.calls.filter((p) => p === "either")).toHaveLength(1);
  });

  for (const mutation of ["remove", "replace", "claim"] as const) {
    test(`retries a snapshot invalidated by ${mutation}`, async () => {
      await setup(android.slice(0, 1));
      const old = pool.getDevice(android[0].deviceId)!;
      // Remove case: discovery already sees B before B enters the pool. A positive
      // old snapshot must not claim that uncaptured entry without a fresh pass.
      if (mutation !== "replace") {
        manager.setBootedDevices("android", android.slice(0, 2));
      }
      const gate = manager.park("android");
      const a = acquire("a", "android");
      await gate.entered.promise;
      if (mutation === "claim") {
        const b = acquire("b", "android");
        try {
          await flushMicrotasks();
          expect(b.isSettled()).toBe(true);
          expect(await b.result).toBe(android[0].deviceId);
        } finally {
          if (!b.isSettled()) {
            gate.release.resolve();
            b.controller.abort(timeoutReason());
            timer.enableAutoAdvance();
            timer.resolveAll();
          }
          await b.result;
        }
      } else {
        await pool.removeDevice(android[0].deviceId);
        if (mutation === "replace") {
          await pool.addDevice(android[0]);
          expect(pool.getDevice(android[0].deviceId)).not.toBe(old);
          expect(pool.getDevice(android[0].deviceId)!.incarnation).not.toBe(old.incarnation);
        }
      }
      await pool.addDevice(android[1]);
      manager.setBootedDevices(
        "android",
        mutation === "remove" ? [android[1]] : android.slice(0, 2),
      );
      const nextSnapshot = mutation !== "replace" ? manager.park("android") : undefined;
      gate.release.resolve();
      try {
        if (nextSnapshot) {
          await flushMicrotasks(500);
          expect(a.isSettled()).toBe(false);
          expect(manager.calls.filter((p) => p === "android")).toHaveLength(
            mutation === "claim" ? 3 : 2,
          );
        }
      } finally {
        nextSnapshot?.release.resolve();
      }
      expect(typeof (await settleAcquisition(a))).toBe("string");
      expect(manager.calls.filter((p) => p === "android").length).toBeGreaterThanOrEqual(
        mutation === "claim" ? 3 : 2,
      );
      expect(pool.getDevice(android[1].deviceId)).not.toBeNull();
      expect(old.sessionId).toBe(mutation === "claim" ? "b" : null);
    });
  }

  test("revalidates after local presence work and selects the next candidate without discovery", async () => {
    class ClaimDuringPresence extends MissingDeviceLiveness {
      override async ensurePooledDevicePresent(
        ...args: Parameters<MissingDeviceLiveness["ensurePooledDevicePresent"]>
      ): Promise<boolean> {
        const present = await super.ensurePooledDevicePresent(...args);
        if (args[0].id === android[0].deviceId) {
          args[0].status = "busy";
          args[0].sessionId = "concurrent-owner";
        }
        return present;
      }
    }
    await setup(android.slice(0, 2), {
      missingDeviceLivenessFactory: (port) => new ClaimDuringPresence(port),
    });
    expect(await pool.assignDeviceToSession("validated", "android")).toBe(android[1].deviceId);
    expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe("concurrent-owner");
    expect(manager.calls).toEqual(["android"]);
  });

  test("retries an incarnation replaced by reconciliation after the one allowed refresh", async () => {
    const emulator: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel old",
      platform: "android",
    };
    await setup([emulator]);
    manager.setBootedDevices("android", [{ ...emulator, name: "Pixel first" }]);
    manager.afterSnapshot = async () => {
      manager.setBootedDevices("android", [
        {
          ...emulator,
          name: manager.calls.includes("either") ? "Pixel final" : "Pixel refreshed",
        },
      ]);
    };
    expect(await pool.assignDeviceToSession("reconciled", "android")).toBe(emulator.deviceId);
    expect(manager.calls).toEqual(["android", "either", "android", "android"]);
    expect(pool.getDevice(emulator.deviceId)?.name).toBe("Pixel final");
    expect(pool.getDevice(emulator.deviceId)?.sessionId).toBe("reconciled");
  });

  test("bounded snapshot churn yields the public retry timeout", async () => {
    await setup(android.slice(0, 1));
    manager.afterSnapshot = async () => {
      await pool.removeDevice(android[0].deviceId);
      await pool.addDevice(android[0]);
    };
    const a = acquire("churn", "android");
    await flushMicrotasks(500);
    expect(a.isSettled()).toBe(false);
    const firstAttemptCalls = manager.calls.length;
    expect(firstAttemptCalls).toBe(6);
    for (let attempt = 1; attempt < 60; attempt++) {
      timer.advanceTime(1000);
      await flushMicrotasks(500);
    }
    const error = await a.result;
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("Timed out waiting for device after 60s (60 attempts)");
    expect(pool.getDevice(android[0].deviceId)?.sessionId).toBeNull();
  });

  for (const count of [1, 2]) {
    for (const first of ["a", "b"] as const) {
      test(`${count} idle devices: ${first} snapshot resolves first without duplicate ownership`, async () => {
        await setup(android.slice(0, count));
        const gates = { a: manager.park("android"), b: manager.park("android") };
        const acquisitions = { a: acquire("a", "android"), b: acquire("b", "android") };
        await flushMicrotasks();
        try {
          // Both calls must reach discovery before either snapshot is released.
          expect(manager.calls).toEqual(["android", "android"]);
          gates[first].release.resolve();
          await flushMicrotasks();
          const second = first === "a" ? "b" : "a";
          gates[second].release.resolve();
          await flushMicrotasks();
          expect(typeof (await acquisitions[first].result)).toBe("string");
          if (count === 2) {
            expect(typeof (await acquisitions[second].result)).toBe("string");
            expect(await acquisitions[first].result).not.toBe(await acquisitions[second].result);
          } else {
            expect(acquisitions[second].isSettled()).toBe(false);
            expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe(first);
          }
        } finally {
          gates.a.release.resolve();
          gates.b.release.resolve();
          acquisitions.a.controller.abort(timeoutReason());
          acquisitions.b.controller.abort(timeoutReason());
          // The unchanged outer busy retry uses FakeTimer sleeps.
          timer.enableAutoAdvance();
          timer.resolveAll();
          await Promise.all([acquisitions.a.result, acquisitions.b.result]);
        }
      });
    }
  }

  for (const platform of ["android", "ios", "either"] as const) {
    test(`ambient deadline stops waiting for hung ${platform} discovery with original reason`, async () => {
      await setup(
        platform === "either" ? [] : platform === "ios" ? ios.slice(0, 1) : android.slice(0, 1),
      );
      const gate = manager.park(platform);
      const a = acquire("aborted", platform === "ios" ? "ios" : "android");
      await gate.entered.promise;
      const reason = timeoutReason();
      a.controller.abort(reason);
      try {
        await flushMicrotasks();
        expect(a.isSettled()).toBe(true);
        expect(await a.result).toBe(reason);
        if (platform === "either") {
          await pool.addDevice(android[0]);
          manager.setBootedDevices("android", android.slice(0, 1));
        }
        const b = acquire("following", platform === "ios" ? "ios" : "android");
        await flushMicrotasks();
        expect(b.isSettled()).toBe(true);
        expect(typeof (await b.result)).toBe("string");
      } finally {
        gate.release.resolve();
        await a.result;
      }
    });
  }

  test("all-busy allocation retains its ActionableError timeout", async () => {
    await setup(android.slice(0, 1));
    await pool.assignDeviceToSession("owner", "android");
    timer.enableAutoAdvance();
    const a = acquire("waiting", "android");
    expect(await a.result).toBeInstanceOf(ActionableError);
    expect(String(await a.result)).toContain(
      "Timed out waiting for device after 60s (60 attempts)",
    );
    expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe("owner");
  });

  for (const platform of ["android", "ios"] as const) {
    test(`healthy ${platform} allocation uses exactly one platform snapshot`, async () => {
      await setup(platform === "android" ? android : ios);
      await pool.assignDeviceToSession("healthy", platform);
      expect(manager.calls).toEqual([platform]);
    });
  }
});
