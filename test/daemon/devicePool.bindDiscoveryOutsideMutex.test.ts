import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { MissingDeviceLiveness } from "../../src/daemon/missingDeviceLiveness";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError } from "../../src/models/ActionableError";
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
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Capture each observation before parking, so later discovery can proceed independently.
class ParkingDiscovery extends FakeDeviceUtils {
  readonly calls: SomePlatform[] = [];
  private readonly gates: Array<{
    platform: SomePlatform;
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }> = [];
  private detailed = false;
  afterSnapshot?: () => Promise<void>;
  retainedIosDevices: BootedDevice[] = [];
  park(platform: SomePlatform) {
    const gate = {
      platform,
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    this.gates.push(gate);
    return gate;
  }
  private async parkSnapshot(platform: SomePlatform) {
    this.calls.push(platform);
    const index = this.gates.findIndex((gate) => gate.platform === platform);
    const gate = index < 0 ? undefined : this.gates.splice(index, 1)[0];
    gate?.entered.resolve();
    if (gate) {
      await gate.release.promise;
    }
    await this.afterSnapshot?.();
  }
  override async getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]> {
    const snapshot = await super.getBootedDevices(platform);
    if (!this.detailed) {
      await this.parkSnapshot(platform);
    }
    return snapshot;
  }
  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options: BootedDeviceDiscoveryOptions = {},
  ): Promise<BootedDeviceDiscovery> {
    this.detailed = true;
    const snapshot = await super.getBootedDevicesDetailed(platform, options);
    this.detailed = false;
    snapshot.devices.push(...this.retainedIosDevices);
    await this.parkSnapshot(platform);
    return snapshot;
  }
}

// Recording the public eviction seam also detects a detached recovery kickoff.
class RecordingLiveness extends MissingDeviceLiveness {
  evictions = 0;
  override async evictMissingPooledDevice(
    ...args: Parameters<MissingDeviceLiveness["evictMissingPooledDevice"]>
  ): Promise<void> {
    this.evictions++;
    await super.evictMissingPooledDevice(...args);
  }
}

async function flush(rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}
const android: BootedDevice[] = ["R58A", "R58B", "R58C", "R58D"].map((deviceId) => ({
  deviceId,
  name: deviceId,
  platform: "android",
}));
const ios: BootedDevice = { deviceId: "SIM-A", name: "SIM-A", platform: "ios" };
let pool: DevicePool;
let timer: FakeTimer;
let manager: ParkingDiscovery;
let sessions: SessionManager;
let liveness: RecordingLiveness;
const previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
async function setup(devices: BootedDevice[]) {
  process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  timer = new FakeTimer();
  sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  manager = new ParkingDiscovery();
  for (const platform of ["android", "ios"] as const) {
    manager.setBootedDevices(
      platform,
      devices.filter((d) => d.platform === platform),
    );
  }
  pool = new DevicePool(
    createDevicePoolDependencies(sessions, "bind-discovery", {
      timer,
      deviceManager: manager,
      missingDeviceLivenessFactory: (port) => {
        liveness = new RecordingLiveness(port);
        return liveness;
      },
      installedAppsRepository: new FakeInstalledAppsRepository(),
      retryExecutor: new DefaultRetryExecutor(timer),
      idGenerator: new FakeIdGenerator(),
      deviceSessionRepository: { markAutolockSession: async () => {} },
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
    }),
  );
  await pool.initializeWithDevices(devices);
}
afterEach(() => {
  sessions?.stopCleanupTimer();
  timer?.reset();
  if (previousAutolock === undefined) {
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  } else {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
  }
});

function acquire(path: "bind" | "autolock", device: BootedDevice, owner = "a") {
  const controller = new AbortController();
  let settled = false;
  const result = runWithAbortSignal(controller.signal, () =>
    path === "bind"
      ? pool.bindOrReuseDeviceSession(
          owner,
          device.deviceId,
          device.platform,
          undefined,
          undefined,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          owner,
        )
      : pool.autolockDevice(device.deviceId, device.platform, owner),
  ).then(
    (value) => {
      settled = true;
      return value;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  return { result, controller, isSettled: () => settled };
}

for (const path of ["bind", "autolock"] as const) {
  describe(`${path} discovery outside assignmentMutex`, () => {
    test("unpooled unresolved emulator refuses ownership", async () => {
      const device: BootedDevice = {
        deviceId: "emulator-5554",
        name: "Unknown (emulator-5554)",
        platform: "android",
      };
      await setup([]);
      manager.setBootedDevices("android", [device]);
      expect(String(await acquire(path, device).result)).toContain("identity is unresolved");
      expect(pool.getDevice(device.deviceId)?.sessionId ?? null).toBeNull();
    });

    test("unpooled reused emulator serial retries and claims the current AVD", async () => {
      const device: BootedDevice = {
        deviceId: "emulator-5554",
        name: "Pixel old",
        platform: "android",
      };
      await setup([]);
      manager.setBootedDevices("android", [device]);
      const gate = manager.park("android");
      const acquisition = acquire(path, device);
      await gate.entered.promise;
      manager.setBootedDevices("android", [{ ...device, name: "Pixel new" }]);
      gate.release.resolve();
      expect(typeof (await acquisition.result)).toBe("string");
      expect(pool.getDevice(device.deviceId)?.name).toBe("Pixel new");
      expect(pool.getDevice(device.deviceId)?.sessionId).toBe(await acquisition.result);
    });

    test("unpooled emulator refuses ownership if its fresh confirmation source fails", async () => {
      const device: BootedDevice = {
        deviceId: "emulator-5554",
        name: "Pixel",
        platform: "android",
      };
      await setup([]);
      manager.setBootedDevices("android", [device]);
      const gate = manager.park("android");
      const acquisition = acquire(path, device);
      await gate.entered.promise;
      manager.failedPlatforms.add("android");
      gate.release.resolve();
      expect(String(await acquisition.result)).toContain("not available");
      expect(pool.getDevice(device.deviceId)?.sessionId).toBeNull();
    });

    for (const source of ["ios-platform", "ios-simulator", "ios-physical"] as const) {
      test(`unpooled ${source} failed discovery refuses retained presence`, async () => {
        const device: BootedDevice =
          source !== "ios-physical"
            ? ios
            : {
                deviceId: "00008110-001A2B3C4D5E801E",
                name: "iPhone",
                platform: "ios",
              };
        await setup([]);
        manager.setBootedDevices("ios", [device]);
        if (source === "ios-platform") {
          manager.failedPlatforms.add("ios");
        } else {
          manager.failedSources.add(source);
        }
        if (source === "ios-physical") {
          manager.retainedIosDevices = [device];
        }
        expect(String(await acquire(path, device).result)).toContain("Unable to verify iOS");
        expect(pool.getDevice(device.deviceId)?.sessionId ?? null).toBeNull();
      });
    }

    for (const prune of [false, true]) {
      test(`unpooled shutdown retirement fences stale re-add${prune ? " across refresh stamp pruning" : ""}`, async () => {
        await setup([]);
        manager.setBootedDevices("android", [android[0]]);
        const gate = manager.park("android");
        const acquisition = acquire(path, android[0]);
        await gate.entered.promise;
        await pool.addDevice(android[0]);
        const reservation = await pool.reserveDeviceForShutdown(android[0].deviceId);
        expect(reservation).toBeDefined();
        manager.setBootedDevices("android", []);
        expect(await pool.retireDeviceForShutdown(reservation!.device)).toBe(true);
        await reservation!.release();
        if (prune) {
          await pool.refreshDevices();
        }
        gate.release.resolve();
        expect(String(await acquisition.result)).toContain("not available");
        expect(pool.getDevice(android[0].deviceId)).toBeNull();
        expect(sessions.getSession("a")).toBeNull();
      });
    }

    test("pooled positive snapshot retains the existing hand-out behavior after disappearance", async () => {
      await setup([android[0]]);
      const gate = manager.park("android");
      const acquisition = acquire(path, android[0]);
      await gate.entered.promise;
      manager.setBootedDevices("android", []);
      gate.release.resolve();
      expect(typeof (await acquisition.result)).toBe("string");
      expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe(await acquisition.result);
    });

    test("failed same-owner acquisition leaves the dead-device session for the disconnect monitor", async () => {
      await setup([android[0]]);
      const first = await acquire(path, android[0]).result;
      expect(typeof first).toBe("string");
      manager.setBootedDevices("android", []);
      expect(String(await acquire(path, android[0]).result)).toContain("not available");
      expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe(first);
      expect(sessions.getSession(String(first))).not.toBeNull();
    });

    for (const device of [
      ios,
      {
        deviceId: "00008110-001A2B3C4D5E801E",
        name: "iPhone",
        platform: "ios" as const,
      },
    ]) {
      test(`unpooled ${device.name} uses its successful source despite the other iOS source failing`, async () => {
        await setup([]);
        manager.setBootedDevices("ios", [device]);
        manager.failedSources.add(device === ios ? "ios-physical" : "ios-simulator");
        const acquisition = acquire(path, device);
        expect(typeof (await acquisition.result)).toBe("string");
        expect(pool.getDevice(device.deviceId)?.sessionId).toBe(await acquisition.result);
      });
    }

    test("parked discovery permits release, readiness reservation and allocation of another device", async () => {
      await setup(android);
      await pool.assignDeviceToSession("busy", "android");
      const gate = manager.park("android");
      const a = acquire(path, android[1]);
      await gate.entered.promise;
      let released = false;
      const release = pool.releaseDevice(android[0].deviceId, "busy").then(() => {
        released = true;
      });
      let reserved = false;
      const readiness = pool
        .reserveDeviceForReadiness(android[2].deviceId, android[2])
        .then((r) => {
          reserved = true;
          return r;
        });
      let allocated = false;
      const allocation = pool.assignDeviceToSession("other", "android").then((id) => {
        allocated = true;
        return id;
      });
      try {
        await flush(500);
        expect(released).toBe(true);
        expect(reserved).toBe(true);
        expect(allocated).toBe(true);
        expect(a.isSettled()).toBe(false);
      } finally {
        gate.release.resolve();
        await release;
        await (
          await readiness
        )();
        await Promise.all([a.result, allocation]);
      }
    });

    for (const mutation of ["remove", "replace", "claim", "newly pooled"] as const) {
      test(`positive snapshot invalidated by ${mutation} cannot bind on old evidence`, async () => {
        await setup(mutation === "newly pooled" ? [] : [android[0]]);
        manager.setBootedDevices("android", [android[0]]);
        const old = pool.getDevice(android[0].deviceId);
        const gate = manager.park("android");
        const a = acquire(path, android[0]);
        await gate.entered.promise;
        let competitor: ReturnType<typeof acquire> | undefined;
        let readiness: Promise<() => Promise<void>> | undefined;
        try {
          if (mutation === "claim") {
            competitor = acquire(path, android[0], "b");
            await flush(500);
            expect(competitor.isSettled()).toBe(true);
          } else {
            if (mutation === "newly pooled") {
              let reserved = false;
              readiness = pool.reserveDeviceForReadiness("unrelated", android[1]).then((r) => {
                reserved = true;
                return r;
              });
              await flush();
              expect(reserved).toBe(true);
            }
            if (mutation !== "newly pooled") {
              await pool.removeDevice(android[0].deviceId);
            }
            if (mutation !== "remove") {
              await pool.addDevice(android[0]);
            } else {
              manager.setBootedDevices("android", []);
            }
          }
        } finally {
          gate.release.resolve();
          await Promise.all([a.result, competitor?.result]);
          if (readiness) {
            await (
              await readiness
            )();
          }
        }
        if (mutation === "claim") {
          expect(String(await a.result)).toContain("already assigned");
          expect(pool.getDevice(android[0].deviceId)?.sessionId).toBe(await competitor!.result);
        } else {
          expect(manager.calls).toEqual(["android", "android"]);
          expect(old?.sessionId ?? null).toBeNull();
          if (mutation === "remove") {
            expect(String(await a.result)).toContain("not available");
          } else {
            expect(typeof (await a.result)).toBe("string");
            expect(pool.getDevice(android[0].deviceId)).not.toBe(old);
          }
        }
      });
    }

    test("two concurrent acquisitions observe before locking and exactly one owner wins", async () => {
      await setup([android[0]]);
      const gates = [manager.park("android"), manager.park("android")];
      const a = acquire(path, android[0], "a");
      const b = acquire(path, android[0], "b");
      try {
        await flush(500);
        expect(manager.calls).toEqual(["android", "android"]);
      } finally {
        for (const gate of gates) {
          gate.release.resolve();
        }
        await Promise.all([a.result, b.result]);
      }
      const results = [await a.result, await b.result];
      expect(results.filter((r) => typeof r === "string")).toHaveLength(1);
      expect(results.filter((r) => r instanceof ActionableError)).toHaveLength(1);
      expect(String(results.find((r) => r instanceof Error))).toContain("already assigned");
    });

    for (const kind of ["android", "ios", "recoverable emulator"] as const) {
      test(`absent ${kind} snapshot preserves entry, status, incarnation and starts no recovery`, async () => {
        const device =
          kind === "ios"
            ? ios
            : kind === "android"
              ? android[0]
              : { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
        await setup([device]);
        if (kind === "recoverable emulator") {
          await pool.addDevice(device, {
            name: device.name,
            platform: "android",
            isRunning: true,
            source: "local",
          });
          expect(pool.getRecoveryEligibility(device.deviceId).eligible).toBe(true);
        }
        const original = pool.getDevice(device.deviceId)!;
        const { status, incarnation } = original;
        const removal = spyOn(pool, "removeDevice");
        manager.setBootedDevices(device.platform, []);
        const a = acquire(path, device);
        await flush(500);
        expect(String(await a.result)).toContain("not available");
        expect(pool.getDevice(device.deviceId)).toBe(original);
        expect(original.status).toBe(status);
        expect(original.incarnation).toBe(incarnation);
        expect(removal).not.toHaveBeenCalled();
        removal.mockRestore();
        expect(liveness.evictions).toBe(0);
        expect(manager.getCallCount("startDevice")).toBe(0);
        expect(manager.getCallCount("killDevice")).toBe(0);
      });
    }

    for (const kind of [
      "pooled android",
      "pooled ios",
      "not pooled android",
      "not pooled ios",
      "not pooled emulator",
    ] as const) {
      test(`healthy ${kind} validates identity and releases the lock during discovery`, async () => {
        const device: BootedDevice = kind.endsWith("ios")
          ? ios
          : kind.endsWith("emulator")
            ? {
                deviceId: "emulator-5554",
                name: "Pixel",
                platform: "android",
              }
            : android[0];
        await setup(kind.startsWith("not pooled") ? [] : [device]);
        manager.setBootedDevices(device.platform, [device]);
        // Check every sweep, including any confirmation/replacement retry.
        manager.afterSnapshot = async () => {
          let lockAvailable = false;
          const reservation = pool
            .reserveDeviceForReadiness("probe", android[2])
            .then((release) => {
              lockAvailable = true;
              return release;
            });
          await flush();
          expect(lockAvailable).toBe(true);
          await (
            await reservation
          )();
        };
        const notifications = spyOn(pool, "notifyDeviceReady");
        const gate = manager.park(device.platform);
        const a = acquire(path, device);
        await gate.entered.promise;
        let reserved = false;
        const readiness = pool.reserveDeviceForReadiness("unrelated", android[1]).then((r) => {
          reserved = true;
          return r;
        });
        try {
          await flush();
          expect(reserved).toBe(true);
        } finally {
          gate.release.resolve();
          await (
            await readiness
          )();
          await a.result;
        }
        expect(typeof (await a.result)).toBe("string");
        expect(notifications).toHaveBeenCalledTimes(1);
        notifications.mockRestore();
        expect(pool.getDevice(device.deviceId)?.identityUnresolved ?? false).toBe(false);
        expect(pool.getDevice(device.deviceId)?.sessionId).toBe(await a.result);
      });

      test(`ambient abort during hung ${kind} discovery preserves original reason`, async () => {
        const device: BootedDevice = kind.endsWith("ios")
          ? ios
          : kind.endsWith("emulator")
            ? {
                deviceId: "emulator-5554",
                name: "Pixel",
                platform: "android",
              }
            : android[0];
        await setup(kind.startsWith("not pooled") ? [] : [device]);
        manager.setBootedDevices(device.platform, [device]);
        const gate = manager.park(device.platform);
        const a = acquire(path, device);
        await gate.entered.promise;
        const reason = new Error("original abort reason");
        a.controller.abort(reason);
        try {
          await flush();
          expect(a.isSettled()).toBe(true);
          expect(await a.result).toBe(reason);
        } finally {
          gate.release.resolve();
          await a.result;
        }
      });
    }

    for (const platform of ["android", "ios"] as const) {
      test(`failed ${platform} discovery keeps its existing retention or unable-to-verify contract outside the lock`, async () => {
        const device = platform === "ios" ? ios : android[0];
        await setup([device]);
        const original = pool.getDevice(device.deviceId);
        manager.setBootedDevices(platform, []);
        manager.failedPlatforms.add(platform);
        const gate = manager.park(platform);
        const a = acquire(path, device);
        await gate.entered.promise;
        let reserved = false;
        const readiness = pool.reserveDeviceForReadiness("unrelated", android[1]).then((r) => {
          reserved = true;
          return r;
        });
        try {
          await flush();
          expect(reserved).toBe(true);
        } finally {
          gate.release.resolve();
          await (
            await readiness
          )();
          await a.result;
        }
        expect(pool.getDevice(device.deviceId)).toBe(original);
        if (platform === "android") {
          expect(typeof (await a.result)).toBe("string");
        } else {
          expect(String(await a.result)).toContain("discovery failed");
        }
      });
    }

    test("reusable serial reconciliation retries with fresh evidence for its replacement", async () => {
      const device: BootedDevice = {
        deviceId: "emulator-5554",
        name: "Pixel old",
        platform: "android",
      };
      await setup([device]);
      const original = pool.getDevice(device.deviceId)!;
      manager.setBootedDevices("android", [{ ...device, name: "Pixel new" }]);
      const a = acquire(path, device);
      expect(typeof (await a.result)).toBe("string");
      expect(pool.getDevice(device.deviceId)).not.toBe(original);
      expect(original.sessionId).toBeNull();
      expect(pool.getDevice(device.deviceId)?.name).toBe("Pixel new");
      expect(manager.calls).toEqual(["android", "android"]);
    });

    test("bounded entry churn returns the existing unavailable error", async () => {
      await setup([android[0]]);
      manager.afterSnapshot = async () => {
        await pool.removeDevice(android[0].deviceId);
        await pool.addDevice(android[0]);
      };
      const a = acquire(path, android[0]);
      expect(String(await a.result)).toContain("not available");
      expect(manager.calls).toHaveLength(4);
      expect(pool.getDevice(android[0].deviceId)?.sessionId).toBeNull();
    });
  });
}
