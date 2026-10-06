import { describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";

/**
 * A recovery's own stop confirmation (the poll after it kills the untracked
 * emulator) matches the AVD by name against the online-only device list. An
 * emulator that drops to adb `offline` mid-kill is missing from that list while
 * its process still runs, so it must not read as stopped (#10100). Driven through
 * a real DevicePool with a fake manager: nothing spawns.
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

/** `killDevice` takes the emulator off the online list and (optionally) into adb `offline`. */
class KillGoesOfflineManager extends FakeDeviceManager {
  offlineSerials = new Set<string>();
  offlineProbeFails = false;
  readonly offlineProbes: string[][] = [];
  readonly kills: string[] = [];
  /** Called on each offline probe, before it answers. */
  onProbe: (probeCount: number) => void = () => {};

  override async killDevice(device: BootedDevice): Promise<void> {
    this.kills.push(device.deviceId);
    this.bootedDevices = this.bootedDevices.filter((d) => d.deviceId !== device.deviceId);
  }

  async getAndroidOfflineDeviceIds(candidateIds: Iterable<string>): Promise<Set<string>> {
    const candidates = Array.from(candidateIds);
    this.offlineProbes.push(candidates);
    this.onProbe(this.offlineProbes.length);
    if (this.offlineProbeFails) {
      throw new Error("adb devices unavailable");
    }
    return new Set(candidates.filter((id) => this.offlineSerials.has(id)));
  }
}

type RecoveryOutcome = { result: unknown } | { error: unknown };

async function setup() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new KillGoesOfflineManager();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "daemon", {
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager: manager,
      retryExecutor: new DefaultRetryExecutor(timer),
      recoveryPolicy: { onLoss: true, maxAttempts: 1 },
    }),
  );
  manager.bootedDevices = [original];
  await pool.addDevice(original, image);
  await pool.bindOrReuseDeviceSession(
    "session",
    original.deviceId,
    "android",
    image,
    undefined,
    original,
  );
  const captured = pool.getDevice(original.deviceId)!;
  const recover = async (): Promise<RecoveryOutcome> =>
    await settleWithFakeTime(
      timer,
      pool.recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured).then(
        (result): RecoveryOutcome => ({ result }),
        (error: unknown): RecoveryOutcome => ({ error }),
      ),
      { stepMs: 1_000, maxSteps: 40, description: "recovery stop confirmation" },
    );
  return { timer, sessions, manager, pool, recover };
}

describe("a recovery's stop confirmation after killing an untracked emulator (#10100)", () => {
  test("a serial that went offline mid-kill is not confirmed stopped and is not relaunched", async () => {
    const s = await setup();
    try {
      s.manager.offlineSerials.add(original.deviceId);
      const outcome = await s.recover();
      // Routed into the unconfirmed-recovery path: deferred, not relaunched.
      expect(outcome).toEqual({ result: "deferred" });
      expect(s.manager.kills).toEqual([original.deviceId]);
      expect(s.manager.startedDevices).toHaveLength(0);
      expect(s.manager.offlineProbes.length).toBeGreaterThan(1);
      expect(s.manager.offlineProbes.every((ids) => ids.join() === original.deviceId)).toBe(true);
      // The AVD stays reserved for the later conclusive refresh to lift.
      expect(s.pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });

  test("an unreadable adb state list is not confirmed stopped either", async () => {
    const s = await setup();
    try {
      s.manager.offlineProbeFails = true;
      const outcome = await s.recover();
      expect(outcome).toEqual({ result: "deferred" });
      expect(s.manager.startedDevices).toHaveLength(0);
      expect(s.pool.getRecoveringAndroidTargets().names).toEqual(new Set([original.name]));
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });

  test("a serial that leaves adb on a later poll is confirmed stopped and the AVD relaunches", async () => {
    const s = await setup();
    try {
      s.manager.offlineSerials.add(original.deviceId);
      s.manager.onProbe = (count) => {
        if (count >= 3) {
          s.manager.offlineSerials.clear();
        }
      };
      const outcome = await s.recover();
      expect(outcome).toEqual({ result: "recovered" });
      expect(s.manager.offlineProbes).toHaveLength(3);
      expect(s.manager.startedDevices).toHaveLength(1);
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });

  test("a serial absent from both the online and offline lists is confirmed stopped at once", async () => {
    const s = await setup();
    try {
      const outcome = await s.recover();
      expect(outcome).toEqual({ result: "recovered" });
      expect(s.manager.kills).toEqual([original.deviceId]);
      expect(s.manager.offlineProbes).toEqual([[original.deviceId]]);
      expect(s.manager.startedDevices).toHaveLength(1);
    } finally {
      s.sessions.stopCleanupTimer();
    }
  });
});
