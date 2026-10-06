import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleIdentity,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { EmulatorLaunchCancelledError } from "../../src/models/EmulatorLaunchCancelledError";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainMicrotasks, settleWithFakeTime } from "../helpers/fakeTimerStepping";

/**
 * Interactions between the lifecycle-lease work (#10075), the unconfirmed
 * recovery-reservation lift (#10076) and the offline-aware shutdown confirmation
 * (#10074), driven through a real DevicePool, lease coordinator and recovery
 * coordinator with a fake process handle: nothing spawns.
 */
const original: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};
const image: DeviceInfo = {
  name: original.name,
  platform: "android",
  isRunning: true,
  source: "local",
};
const avdLease: VirtualDeviceLifecycleIdentity = {
  kind: "stable",
  platform: "android",
  stableId: original.name,
};

/** An emulator child that ignores SIGTERM and SIGKILL until `exit()` is called. */
class StubbornChild extends EventEmitter {
  readonly pid = 4242;
  readonly exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }

  exit(): void {
    this.emit("exit", 0, null);
  }
}

/** A manager whose adb transport can report serials as `offline` (absent from booted lists). */
class OfflineAwareManager extends FakeDeviceManager {
  offlineSerials = new Set<string>();
  offlineProbeFails = false;
  readonly offlineProbes: string[][] = [];

  async getAndroidOfflineDeviceIds(candidateIds: Iterable<string>): Promise<Set<string>> {
    const candidates = Array.from(candidateIds);
    this.offlineProbes.push(candidates);
    if (this.offlineProbeFails) {
      throw new Error("adb devices unavailable");
    }
    return new Set(candidates.filter((id) => this.offlineSerials.has(id)));
  }
}

/** Every relaunch is cancelled during startup validation, carrying the spawned child. */
class CancelledRelaunchManager extends OfflineAwareManager {
  readonly child = new StubbornChild();
  onStart: (() => void) | undefined;

  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.startedDevices.push(device);
    this.onStart?.();
    throw new EmulatorLaunchCancelledError(device.name, this.child as unknown as ChildProcess);
  }
}

/**
 * The recovery's checked Android discovery hangs until released, so its shutdown
 * confirmation times out while the work behind it is still pending (a late command).
 */
class HangingDiscoveryManager extends OfflineAwareManager {
  readonly released = Promise.withResolvers<void>();
  hangDiscovery: () => boolean = () => false;

  override async getBootedDevicesDetailed(
    ...args: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>
  ): ReturnType<FakeDeviceManager["getBootedDevicesDetailed"]> {
    if (this.hangDiscovery()) {
      await this.released.promise;
    }
    return await super.getBootedDevicesDetailed(...args);
  }
}

async function setup<M extends OfflineAwareManager>(manager: M) {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const lifecycle = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
      lifecycleCoordinator: lifecycle,
    }),
  );
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  return { timer, sessions, lifecycle, pool, manager };
}

/** Drive a recovery to its end with fake time and return its failure, if any. */
async function settle(timer: FakeTimer, promise: Promise<unknown>, stepMs = 1_000) {
  return await settleWithFakeTime(
    timer,
    promise.then(
      () => undefined,
      (error: unknown) => error,
    ),
    { stepMs, maxSteps: 8, description: "recovery to fail or finish" },
  );
}

describe("a recovery relaunch cancelled during startup validation (#10075)", () => {
  const setupCancelled = async () => {
    const s = await setup(new CancelledRelaunchManager());
    // The lost emulator is already gone, so the recovery's stop confirms at once and
    // proceeds to the relaunch that gets cancelled.
    s.manager.bootedDevices = [];
    s.manager.onStart = () => s.pool.markIntentionalShutdown(original.deviceId);
    return s;
  };

  test("an unkillable carried child holds the lease until it exits and leaks no reservation", async () => {
    const s = await setupCancelled();
    try {
      const failure = await settle(
        s.timer,
        s.pool.removeDisconnectedDevice(original.deviceId, false),
      );
      expect(String(failure)).toContain("did not exit after SIGKILL");
      expect(s.manager.startedDevices).toHaveLength(1);
      // The carried child was asked to stop, SIGTERM then SIGKILL...
      expect(s.manager.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      // ...it is still alive, so the AVD's lease is held on its exit...
      expect(s.lifecycle.isReserved(avdLease)).toBe(true);
      // ...while the attempt's image reservation ended with the attempt.
      expect(s.pool.getRecoveringAndroidTargets().names.size).toBe(0);

      s.manager.child.exit();
      await drainMicrotasks(200);
      expect(s.lifecycle.isReserved(avdLease)).toBe(false);
      const release = await s.pool.reserveAndroidStartupLease(original.name, true);
      await release();
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });

  test("a child that exits on SIGTERM leaves neither the lease nor the reservation held", async () => {
    const s = await setupCancelled();
    try {
      s.manager.child.kill = function (this: StubbornChild, signal) {
        this.signals.push(signal);
        queueMicrotask(() => this.exit());
        return true;
      };
      const failure = await settle(
        s.timer,
        s.pool.removeDisconnectedDevice(original.deviceId, false),
      );
      expect(failure).toBeUndefined();
      expect(s.manager.child.signals).toEqual(["SIGTERM"]);
      expect(s.lifecycle.isReserved(avdLease)).toBe(false);
      expect(s.pool.getRecoveringAndroidTargets().names.size).toBe(0);
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });
});

describe("a recovery that cannot confirm the old emulator stopped (#10076)", () => {
  /** Its checked discovery hangs: the lease is held on it and the AVD stays reserved. */
  const setupUnconfirmed = async () => {
    const s = await setup(new HangingDiscoveryManager());
    // Only the discovery made under the recovery's own lease hangs; the disconnect
    // pre-checks before it answer normally.
    s.manager.hangDiscovery = () => s.lifecycle.isReserved(avdLease);
    const failure = await settle(
      s.timer,
      s.pool.removeDisconnectedDevice(original.deviceId, false),
      30_000,
    );
    expect(String(failure)).toContain("is unconfirmed");
    expect(s.manager.startedDevices).toHaveLength(0);
    // The lost emulator then drops to adb `offline`: its process may still run.
    s.manager.bootedDevices = [];
    return s;
  };

  test("an offline serial is not read as gone when the reservation's lift is checked (#10074)", async () => {
    const s = await setupUnconfirmed();
    try {
      expect(s.pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));
      s.manager.released.resolve();
      await drainMicrotasks(200);
      expect(s.lifecycle.isReserved(avdLease)).toBe(false);

      // The emulator process is alive but adb lists its serial as offline, so the
      // online-only discovery has no row for the AVD.
      s.manager.offlineSerials.add(original.deviceId);
      await s.pool.refreshDevices();
      expect(s.manager.offlineProbes).toEqual([[original.deviceId]]);
      expect(s.pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));

      // An unreadable adb state list cannot prove it is gone either.
      s.manager.offlineSerials.clear();
      s.manager.offlineProbeFails = true;
      await s.pool.refreshDevices();
      expect(s.pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));

      // Detached from adb altogether: now it is gone and the reservation lifts.
      s.manager.offlineProbeFails = false;
      await s.pool.refreshDevices();
      expect(s.pool.getRecoveringAndroidTargets().names.size).toBe(0);
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });

  test("startDevice for an AVD lease-held by the pending shutdown work and recovery-reserved gets one clear error", async () => {
    const s = await setupUnconfirmed();
    try {
      // Both fences hold at once: the lifecycle lease waits on that work and the AVD
      // is reserved by the interrupted recovery.
      expect(s.lifecycle.isReserved(avdLease)).toBe(true);
      expect(s.pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));

      // A start takes the Android startup lease before the lifecycle lease, so it is
      // refused with the reservation's explanation at once, rather than first
      // waiting out its boot budget behind the held lease and failing with a timeout.
      const sleepsBefore = s.timer.getSleepHistory().length;
      await expect(s.pool.reserveAndroidStartupLease(original.name, true)).rejects.toThrow(
        `Android AVD '${original.name}' is reserved by an interrupted emulator recovery`,
      );
      expect(s.timer.getSleepHistory()).toHaveLength(sleepsBefore);
      expect(s.timer.getPendingTimeoutCount()).toBe(0);

      // The refused request queued nothing: once the shutdown work settles and the next
      // conclusive observation lifts the reservation, a start proceeds.
      s.manager.released.resolve();
      await drainMicrotasks(200);
      await s.pool.refreshDevices();
      const release = await s.pool.reserveAndroidStartupLease(original.name, true);
      await release();
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });
});
