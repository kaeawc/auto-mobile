import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  defaultResolveRunningAndroidAvdName,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ActionableError } from "../../src/models/ActionableError";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { getAbortSignal, runWithAbortSignal } from "../../src/utils/AbortContext";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { IOSCtrlProxyManager } from "../../src/utils/IOSCtrlProxyManager";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import { getInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import { executionTracker } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
  DeviceShutdownOptions,
} from "../../src/utils/deviceUtils";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";

class FailingKillDeviceManager extends FakeDeviceUtils {
  readonly childProcess = new EventEmitter() as ChildProcess;
  /**
   * Serials this manager was actually asked to kill. `FakeDeviceUtils` records
   * operations in its own `killDevice`, which every subclass here overrides, so
   * `wasMethodCalled("killDevice")` would answer `false` even for a kill that
   * DID reach the device manager -- making a "the kill was refused" assertion
   * vacuously true. Assert against this instead.
   */
  readonly killedDeviceIds: string[] = [];
  /** The full targets handed to the platform kill, so a test can assert the NAME it was given. */
  readonly killedDeviceTargets: BootedDevice[] = [];

  constructor() {
    super();
    Object.assign(this.childProcess, {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: () => false,
    });
  }

  override async startDevice(device: DeviceInfo, timeoutMs?: number): Promise<ChildProcess> {
    await super.startDevice(device, timeoutMs);
    return this.childProcess;
  }

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killedDeviceIds.push(device.deviceId);
    this.killedDeviceTargets.push(device);
    throw new Error("adb emu kill failed");
  }
}

/**
 * A clock that jumps a full shutdown budget forward the next time it is read,
 * so a test can model "the caller's deadline was already consumed by the work
 * that ran before this point" without sleeping.
 */
class DeadlineSpendingFakeTimer extends FakeTimer {
  private spendOnNextRead = false;

  spendDeadlineOnNextRead(): void {
    this.spendOnNextRead = true;
  }

  override now(): number {
    const value = super.now();
    if (this.spendOnNextRead) {
      this.spendOnNextRead = false;
      super.advanceTime(60_000);
    }
    return value;
  }
}

class SuccessfulKillDeviceManager extends FailingKillDeviceManager {
  override async killDevice(device: BootedDevice): Promise<void> {
    this.killedDeviceIds.push(device.deviceId);
    this.killedDeviceTargets.push(device);
    this.setBootedDevices(device.platform, []);
  }
}

class ShutdownDiscoveryOptionsDeviceManager extends SuccessfulKillDeviceManager {
  readonly shutdownDiscoveryOptions: Array<BootedDeviceDiscoveryOptions | undefined> = [];
  private trackShutdownDiscovery = false;

  beginTrackingShutdownDiscovery(): void {
    this.trackShutdownDiscovery = true;
  }

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options?: BootedDeviceDiscoveryOptions,
  ): Promise<BootedDeviceDiscovery> {
    if (this.trackShutdownDiscovery) {
      this.shutdownDiscoveryOptions.push(options);
    }
    return await super.getBootedDevicesDetailed(platform);
  }
}

class CurrentRuntimeKillDeviceManager extends FailingKillDeviceManager {
  private shutdownPollsStarted = false;
  private shutdownPollCount = 0;

  constructor(private readonly currentDevice: BootedDevice) {
    super();
  }

  beginShutdownPolls(): void {
    this.shutdownPollsStarted = true;
  }

  override async killDevice(): Promise<BootedDevice> {
    return this.currentDevice;
  }

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options?: BootedDeviceDiscoveryOptions,
  ): Promise<BootedDeviceDiscovery> {
    if (!this.shutdownPollsStarted) {
      return await super.getBootedDevicesDetailed(platform);
    }
    this.shutdownPollCount++;
    return {
      devices: this.shutdownPollCount === 1 ? [this.currentDevice] : [],
      succeededPlatforms: new Set(["android"]),
    };
  }
}

class ReplacementBeforeShutdownWaitDeviceManager extends FailingKillDeviceManager {
  constructor(private readonly replacement: BootedDevice) {
    super();
  }

  override async killDevice(device: BootedDevice): Promise<void> {
    this.setBootedDevices(device.platform, [this.replacement]);
  }
}

class AllocationRaceDevicePool extends DevicePool {
  override async releaseDevice(deviceId: string): Promise<void> {
    await super.releaseDevice(deviceId);
    await this.assignMultipleDevices(["racing-session"], 1_000, "android");
  }
}

class DelayedSuccessfulKillDeviceManager extends FailingKillDeviceManager {
  override async killDevice(): Promise<void> {}
}

class ReleaseDuringShutdownWaitDeviceManager extends DelayedSuccessfulKillDeviceManager {
  private shutdownStarted = false;
  private releasedSession = false;
  onShutdownWait: (() => Promise<void>) | undefined;

  override async killDevice(): Promise<void> {
    this.shutdownStarted = true;
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (this.shutdownStarted) {
      if (!this.releasedSession) {
        this.releasedSession = true;
        await this.onShutdownWait?.();
      }
      return { devices: [], succeededPlatforms: new Set(["android"]) };
    }
    return await super.getBootedDevicesDetailed(platform);
  }
}

class FailedDiscoveryThenReplacementDeviceManager extends DelayedSuccessfulKillDeviceManager {
  private replacementSequenceStarted = false;
  private failedDiscoveryReported = false;

  constructor(private readonly replacement: BootedDevice) {
    super();
  }

  beginReplacementSequence(): void {
    this.replacementSequenceStarted = true;
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (!this.replacementSequenceStarted) {
      return await super.getBootedDevicesDetailed(platform);
    }
    if (!this.failedDiscoveryReported) {
      this.failedDiscoveryReported = true;
      return { devices: [], succeededPlatforms: new Set() };
    }
    return {
      devices: [this.replacement],
      succeededPlatforms: new Set([this.replacement.platform]),
    };
  }
}

class DeadlineExhaustingShutdownDeviceManager extends DelayedSuccessfulKillDeviceManager {
  private exhaustDeadlineOnNextDiscovery = false;

  constructor(private readonly timer: FakeTimer) {
    super();
  }

  exhaustDeadlineOnNextShutdownDiscovery(): void {
    this.exhaustDeadlineOnNextDiscovery = true;
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (this.exhaustDeadlineOnNextDiscovery) {
      this.exhaustDeadlineOnNextDiscovery = false;
      this.timer.setCurrentTime(30_000);
      this.setBootedDevices("android", []);
      return {
        devices: [],
        succeededPlatforms: new Set(platform === "either" ? ["android", "ios"] : [platform]),
      };
    }
    return await super.getBootedDevicesDetailed(platform);
  }
}

class TransientAbsenceThenSameIncarnationDeviceManager extends DelayedSuccessfulKillDeviceManager {
  shutdownDiscoveryCalls = 0;
  private shutdownStarted = false;

  constructor(private readonly device: BootedDevice) {
    super();
  }

  override async killDevice(): Promise<void> {
    this.shutdownStarted = true;
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (!this.shutdownStarted) {
      return await super.getBootedDevicesDetailed(platform);
    }
    this.shutdownDiscoveryCalls++;
    const isTransientAbsence =
      this.shutdownDiscoveryCalls === 2 || this.shutdownDiscoveryCalls === 5;
    return {
      devices: isTransientAbsence ? [] : [this.device],
      succeededPlatforms: new Set([this.device.platform]),
    };
  }
}

class IncompleteThenBootedDiscoveryKillDeviceManager extends FailingKillDeviceManager {
  private recoveryDiscoveryCalls = 0;

  constructor(private readonly device: BootedDevice) {
    super();
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    this.recoveryDiscoveryCalls++;
    if (this.recoveryDiscoveryCalls === 1) {
      return { devices: [], succeededPlatforms: new Set() };
    }
    return {
      devices: [this.device],
      succeededPlatforms: new Set(platform === "either" ? ["android"] : [platform]),
    };
  }
}

class ReplacementAfterObserverReconnectDeviceManager extends FailingKillDeviceManager {
  private recoveryDiscoveryCalls = 0;

  constructor(
    private readonly original: BootedDevice,
    private readonly replacement: BootedDevice,
  ) {
    super();
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    this.recoveryDiscoveryCalls++;
    return {
      devices: [this.recoveryDiscoveryCalls === 1 ? this.original : this.replacement],
      succeededPlatforms: new Set(platform === "either" ? ["android"] : [platform]),
    };
  }
}

class ReplacementDuringCacheClearRepository extends FakeInstalledAppsRepository {
  constructor(private readonly onClearDeviceSession: () => Promise<void>) {
    super();
  }

  override async clearDeviceSession(deviceId: string): Promise<void> {
    await this.onClearDeviceSession();
    await super.clearDeviceSession(deviceId);
  }
}

class HungDiscoveryKillDeviceManager extends DelayedSuccessfulKillDeviceManager {
  override getBootedDevicesDetailed(): Promise<BootedDeviceDiscovery> {
    return new Promise<BootedDeviceDiscovery>(() => {});
  }
}

class AbortAwareHungDiscoveryKillDeviceManager extends DelayedSuccessfulKillDeviceManager {
  discoveryWasAborted = false;

  override getBootedDevicesDetailed(): Promise<BootedDeviceDiscovery> {
    const signal = getAbortSignal();
    signal?.addEventListener(
      "abort",
      () => {
        this.discoveryWasAborted = true;
      },
      { once: true },
    );
    return new Promise<BootedDeviceDiscovery>(() => {});
  }
}

class AbortAwareHungShutdownCommandDeviceManager extends FailingKillDeviceManager {
  commandWasAborted = false;
  commandOptions: DeviceShutdownOptions | undefined;
  private finishCommand!: () => void;
  private failCommand!: (error: Error) => void;

  override killDevice(_: BootedDevice, options?: DeviceShutdownOptions): Promise<void> {
    this.commandOptions = options;
    options?.signal?.addEventListener(
      "abort",
      () => {
        this.commandWasAborted = true;
      },
      { once: true },
    );
    return new Promise<void>((resolve, reject) => {
      this.finishCommand = resolve;
      this.failCommand = reject;
    });
  }

  settleCommand(): void {
    this.finishCommand();
  }

  rejectCommand(error: Error): void {
    this.failCommand(error);
  }
}

class FirstReplacementThenEmptyDeviceManager extends DelayedSuccessfulKillDeviceManager {
  private shutdownDiscoveryCalls = 0;
  private shutdownStarted = false;

  constructor(private readonly replacement: BootedDevice) {
    super();
  }

  override async killDevice(): Promise<void> {
    this.shutdownStarted = true;
  }

  override async getBootedDevicesDetailed(platform: SomePlatform): Promise<BootedDeviceDiscovery> {
    if (!this.shutdownStarted) {
      return await super.getBootedDevicesDetailed(platform);
    }
    this.shutdownDiscoveryCalls++;
    return {
      devices: this.shutdownDiscoveryCalls === 1 ? [this.replacement] : [],
      succeededPlatforms: new Set([this.replacement.platform]),
    };
  }
}

// Models the reported hang: `emu kill` "succeeds" (logs Killed) but active
// hierarchy/screenshot observation keeps re-referencing the transport, so the
// emulator stays in `adb devices` until the per-device observers are detached.
class ActiveObservationKillDeviceManager extends FailingKillDeviceManager {
  private observersStopped = false;

  constructor(private readonly device: BootedDevice) {
    super();
  }

  markObserversStopped(): void {
    this.observersStopped = true;
  }

  override async killDevice(): Promise<BootedDevice> {
    return this.device;
  }

  override async getBootedDevicesDetailed(): Promise<BootedDeviceDiscovery> {
    return {
      devices: this.observersStopped ? [] : [this.device],
      succeededPlatforms: new Set([this.device.platform]),
    };
  }
}

class AlreadyStoppedKillDeviceManager extends FailingKillDeviceManager {
  constructor(private readonly message: string) {
    super();
  }

  override async killDevice(): Promise<void> {
    throw new Error(this.message);
  }
}

class FakeDeviceSessionRepository extends DeviceSessionRepository {
  override async getSession(): Promise<undefined> {
    return undefined;
  }
  override async upsertActiveSession(): Promise<void> {}
  override async markReleased(): Promise<void> {}
  override async recordActivity(): Promise<void> {}
}

class ReplacingDeviceSessionRepository extends FakeDeviceSessionRepository {
  constructor(private readonly onMarkReleased: () => Promise<void>) {
    super();
  }

  override async markReleased(): Promise<void> {
    await this.onMarkReleased();
  }
}

class DeferredReleaseDeviceSessionRepository extends FakeDeviceSessionRepository {
  private releaseMarkReleased: (() => void) | undefined;
  private resolveMarkReleasedStarted: (() => void) | undefined;
  private releaseAttempts = 0;
  private readonly markReleasedStarted = new Promise<void>((resolve) => {
    this.resolveMarkReleasedStarted = resolve;
  });

  override async markReleased(): Promise<void> {
    this.releaseAttempts++;
    if (this.releaseAttempts > 1) {
      return;
    }
    this.resolveMarkReleasedStarted?.();
    await new Promise<void>((resolve) => {
      this.releaseMarkReleased = resolve;
    });
  }

  async waitForMarkReleased(): Promise<void> {
    await this.markReleasedStarted;
  }

  finishMarkReleased(): void {
    this.releaseMarkReleased?.();
  }
}

class FailFirstReleaseDeviceSessionRepository extends FakeDeviceSessionRepository {
  releaseAttempts = 0;

  constructor(private readonly failedReleaseAttempts: number = 1) {
    super();
  }

  override async markReleased(): Promise<void> {
    this.releaseAttempts++;
    if (this.releaseAttempts <= this.failedReleaseAttempts) {
      throw new Error("transient release persistence failure");
    }
  }
}

describe("killDevice handler", () => {
  const originalPreferred = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
  const originalAlias = process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
  let sessionManager: SessionManager;
  let manager: FailingKillDeviceManager;
  // What `emu avd name` answers for a serial whose discovered runtime name is
  // `Unknown (<serial>)`. undefined == the console did not answer.
  let runtimeAvdNames: Map<string, string | undefined>;
  let runtimeAvdNameProbes: string[];

  beforeEach(async () => {
    runtimeAvdNames = new Map();
    runtimeAvdNameProbes = [];
    process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
    delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
    manager = new FailingKillDeviceManager();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: {
        listRecordings: async () => [],
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      resolveRunningAndroidAvdName: async (device) => {
        runtimeAvdNameProbes.push(device.deviceId);
        return runtimeAvdNames.get(device.deviceId);
      },
    });
    registerDeviceTools();
  });

  afterEach(() => {
    AndroidCtrlProxyClient.resetInstances();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    if (originalPreferred === undefined) {
      delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
    } else {
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalPreferred;
    }
    if (originalAlias === undefined) {
      delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
    } else {
      process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH = originalAlias;
    }
  });

  /**
   * The pooled AVD name is a host-side label, not proof of identity: a different
   * AVD can take over a reused serial before discovery observes the previous one
   * disappear. Killing on that stale label would stop the emulator running NOW,
   * so the runtime is asked to confirm the name first (#6863 review).
   */
  describe("pooled AVD name verification before a kill", () => {
    async function poolWithUnknownRuntime(
      booted: BootedDevice,
      pooledAvdName: string,
    ): Promise<void> {
      const timer = new FakeTimer();
      sessionManager = new SessionManager(timer, new FakeDeviceSessionRepository());
      const pool = new DevicePool(
        sessionManager,
        "daemon-session",
        timer,
        new FakeInstalledAppsRepository(),
        manager,
        new DefaultRetryExecutor(timer),
        new FakeDeviceSessionRepository(),
      );
      DaemonState.getInstance().initialize(sessionManager, pool);
      await pool.addDevice(booted, {
        platform: "android",
        name: pooledAvdName,
        isRunning: true,
      });
      manager.setBootedDevices("android", [booted]);
    }

    function killTool() {
      const tool = ToolRegistry.getTool("killDevice");
      if (!tool) {
        throw new Error("killDevice not registered");
      }
      return tool;
    }

    const unknownEmulator: BootedDevice = {
      platform: "android",
      name: "Unknown (emulator-5554)",
      deviceId: "emulator-5554",
    };

    test("refuses when the runtime names a different AVD than the pool", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      runtimeAvdNames.set("emulator-5554", "Pixel_9_New");

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /Pixel_8_Old[\s\S]*Pixel_9_New/,
      );
      expect(manager.killedDeviceIds).toEqual([]);
    });

    test("proceeds when the runtime confirms the pooled AVD name", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      runtimeAvdNames.set("emulator-5554", "Pixel_8_Old");

      await expect(killTool().handler({ device: unknownEmulator })).resolves.toBeDefined();
      expect(runtimeAvdNameProbes).toEqual(["emulator-5554"]);
      expect(manager.killedDeviceIds).toEqual(["emulator-5554"]);
    });

    // `Unknown (<serial>)` means "no information", and a probe that does not
    // answer leaves it that way. A kill issued on nothing but the pooled label
    // could stop a different AVD that took the serial, so the tool refuses and
    // says how to do it by hand. Nothing destructive may reach the device
    // manager (#6863 review).
    test("refuses the kill when the runtime cannot answer", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /emulator-5554[\s\S]*Pixel_8_Old[\s\S]*adb -s emulator-5554 emu kill/,
      );
      expect(runtimeAvdNameProbes).toEqual(["emulator-5554"]);
      expect(manager.killedDeviceIds).toEqual([]);
    });

    // The probe borrows the kill's deadline. When that deadline is already spent
    // by the time verification runs, there is no budget to probe with and no way
    // to identify the target, so the refusal is immediate and the console is
    // never contacted (#6863 review).
    test("refuses without probing when the kill deadline is already spent", async () => {
      manager = new SuccessfulKillDeviceManager();
      const timer = new DeadlineSpendingFakeTimer();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager, timer });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      runtimeAvdNames.set("emulator-5554", "Pixel_8_Old");
      timer.spendDeadlineOnNextRead();

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /did not answer/,
      );
      expect(runtimeAvdNameProbes).toEqual([]);
      expect(manager.killedDeviceIds).toEqual([]);
    });

    // Confirming the runtime's AVD name and then killing under the
    // `Unknown (<serial>)` placeholder throws the proof away:
    // `AndroidEmulatorClient.killDevice` re-discovers the serial and refuses to
    // kill when the discovered name differs from the target's. The verified
    // name has to travel into the kill target
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("hands the CONFIRMED AVD name to the platform kill", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      runtimeAvdNames.set("emulator-5554", "Pixel_8_Old");

      await expect(killTool().handler({ device: unknownEmulator })).resolves.toBeDefined();

      expect(manager.killedDeviceTargets.map((device) => device.name)).toEqual(["Pixel_8_Old"]);
    });

    // A QUARANTINED pooled entry is the state in which confirmation matters
    // most: the pool has observed the placeholder on this serial and can no
    // longer say which AVD answers there. It used to produce no capture at all
    // (`getValidatedPooledAndroidEntry` returns undefined), which skipped the
    // runtime confirmation entirely and let a sessionless kill carrying
    // `Unknown (<serial>)` run against whatever holds the serial now
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    async function quarantinePooledIdentity(): Promise<void> {
      const pool = DaemonState.getInstance().getDevicePool();
      await pool.refreshDevices();
      expect(pool.isPooledIdentityUnresolved("emulator-5554")).toBe(true);
    }

    test("refuses a kill on a quarantined entry when the runtime cannot answer", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      await quarantinePooledIdentity();

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /emulator-5554[\s\S]*did not answer/,
      );
      expect(runtimeAvdNameProbes).toEqual(["emulator-5554"]);
      expect(manager.killedDeviceIds).toEqual([]);
    });

    test("kills a quarantined entry under the name the runtime confirms", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      await quarantinePooledIdentity();
      runtimeAvdNames.set("emulator-5554", "Pixel_8_Old");

      await expect(killTool().handler({ device: unknownEmulator })).resolves.toBeDefined();

      expect(runtimeAvdNameProbes).toEqual(["emulator-5554"]);
      expect(manager.killedDeviceTargets.map((device) => device.name)).toEqual(["Pixel_8_Old"]);
    });

    // The quarantine is not proof of a replacement either: a runtime that names
    // a DIFFERENT AVD than the pooled label is, and the kill is refused rather
    // than retargeted.
    test("refuses a quarantined entry whose runtime names a different AVD", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      await quarantinePooledIdentity();
      runtimeAvdNames.set("emulator-5554", "Pixel_9_New");

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /Pixel_8_Old[\s\S]*Pixel_9_New/,
      );
      expect(manager.killedDeviceIds).toEqual([]);
    });

    // The shutdown reservation protects the CAPTURED pool entry from eviction,
    // but it cannot stop the emulator behind the serial from going away and
    // being replaced. Re-read the epoch at the confirm and refuse when a
    // different incarnation now holds the serial
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("refuses when the pooled incarnation moves between preflight and the kill", async () => {
      manager = new SuccessfulKillDeviceManager();
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      runtimeAvdNames.set("emulator-5554", "Pixel_8_Old");
      const pool = DaemonState.getInstance().getDevicePool();
      // The lifecycle reservation is taken after the preflight capture and
      // before the confirm, which is the window a same-serial replacement lands
      // in production.
      class ReplacingLifecycleCoordinator extends InMemoryVirtualDeviceLifecycleCoordinator {
        override async reserve(
          identity: Parameters<InMemoryVirtualDeviceLifecycleCoordinator["reserve"]>[0],
          options: Parameters<InMemoryVirtualDeviceLifecycleCoordinator["reserve"]>[1],
        ) {
          const pooled = pool.getDevice("emulator-5554");
          if (pooled) {
            pooled.incarnation += 1;
          }
          return await super.reserve(identity, options);
        }
      }
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        lifecycleCoordinator: new ReplacingLifecycleCoordinator(new FakeTimer()),
      });

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /emulator-5554[\s\S]*Pixel_8_Old/,
      );
      expect(manager.killedDeviceIds).toEqual([]);
    });

    // Cancellation is not evidence about the runtime's identity. Swallowing an
    // abort into "unresolved" would make a caller who stopped waiting see an
    // identity refusal naming a manual `emu kill` escape
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("the default AVD resolver rethrows caller cancellation instead of reporting unresolved", async () => {
      const controller = new AbortController();
      const reason = new ActionableError("Operation cancelled by the caller");
      controller.abort(reason);

      await expect(
        defaultResolveRunningAndroidAvdName(unknownEmulator, 1_000, controller.signal),
      ).rejects.toBe(reason);
    });

    test("killDevice surfaces a cancelled AVD probe instead of an identity refusal", async () => {
      manager = new SuccessfulKillDeviceManager();
      const reason = new ActionableError("Operation cancelled by the caller");
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        resolveRunningAndroidAvdName: async () => {
          throw reason;
        },
      });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");

      const rejection = await killTool()
        .handler({ device: unknownEmulator })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(String(rejection)).toContain("cancelled");
      expect(String(rejection)).not.toContain("did not answer");
      expect(manager.killedDeviceIds).toEqual([]);
    });

    // A handset's name is `ro.product.model`, not an AVD, and two handsets of the
    // same model share it — there is no AVD name to verify and nothing an
    // emulator console could answer.
    test("never probes a physical handset", async () => {
      manager = new SuccessfulKillDeviceManager();
      setDeviceToolsDependencies({ deviceManagerFactory: () => manager });
      const handset: BootedDevice = {
        platform: "android",
        name: "Unknown (R5CT10ABCDE)",
        deviceId: "R5CT10ABCDE",
      };
      await poolWithUnknownRuntime(handset, "Pixel 8");

      await expect(killTool().handler({ device: handset })).resolves.toBeDefined();
      expect(runtimeAvdNameProbes).toEqual([]);
    });

    // The verifier is the LAST gate before anything destructive, but it used to
    // sit downstream of `shutdownDevice`'s preparation: by the time it refused,
    // recordings had been stopped, the Android CtrlProxy singleton had been
    // closed and removed, and passive observers had been detached -- on a device
    // that is still running and that the daemon just decided it may not touch.
    // A refusal must leave that device exactly as it found it
    // ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
    test("leaves a still-running device fully intact when it refuses", async () => {
      manager = new SuccessfulKillDeviceManager();
      const stoppedRecordings: string[] = [];
      const stoppedObserverDeviceIds: string[] = [];
      await setVideoRecordingManagerDependencies({
        videoRecorderService: {
          // Records the call and then fails; the shutdown path logs and moves
          // on, so what this test pins is whether the call happened at all.
          stopRecording: async (recordingId: string) => {
            stoppedRecordings.push(recordingId);
            throw new Error("recording teardown unavailable");
          },
          listActiveRecordingIds: () => [],
        } as never,
        recordingRepository: {
          // Only the shutdown path's per-device query answers with an active
          // recording; the manager's own startup scan must stay empty.
          listRecordings: async (filter?: { deviceId?: string }) =>
            filter?.deviceId ? [{ recordingId: "recording-1" }] : [],
          getRecording: async () => undefined,
        } as never,
        configRepository: {} as never,
        highlightClient: {} as never,
        timer: new FakeTimer(),
        now: () => new Date(0),
      });
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        stopAndroidObservers: async (target) => {
          stoppedObserverDeviceIds.push(target.deviceId);
        },
      });
      await poolWithUnknownRuntime(unknownEmulator, "Pixel_8_Old");
      // A passive observation subscriber already owns the per-device singleton.
      const activeObserver = AndroidCtrlProxyClient.getInstance(
        { ...unknownEmulator },
        new FakeAdbClientFactory(),
      );
      // The console does not answer, so the identity is never confirmed.

      await expect(killTool().handler({ device: unknownEmulator })).rejects.toThrow(
        /did not answer/,
      );

      expect(manager.killedDeviceIds).toEqual([]);
      expect(stoppedRecordings).toEqual([]);
      expect(stoppedObserverDeviceIds).toEqual([]);
      expect(AndroidCtrlProxyClient.getExistingInstance(unknownEmulator.deviceId)).toBe(
        activeObserver,
      );
    });
  });

  test("a failed explicit shutdown remains eligible for later crash recovery", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    manager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      manager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }
    const device: BootedDevice = {
      name: image.name,
      platform: "android",
      deviceId: "emulator-5554",
    };
    await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

    Object.assign(manager.childProcess, { exitCode: 1 });
    manager.childProcess.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.getCallCount("startDevice")).toBe(2);
  });

  test("a successful explicit shutdown does not reboot the emulator", async () => {
    const coordinator = getInstalledAppsCacheWriteCoordinator();
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {
        await coordinator.invalidate("emulator-5554", async () => undefined);
        throw new Error("resource notification failed");
      },
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {
        await coordinator.invalidate("emulator-5554", async () => undefined);
        throw new Error("cache cleanup failed");
      },
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }
    await tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: "emulator-5554",
      },
    });
    Object.assign(successfulManager.childProcess, { exitCode: 0 });
    successfulManager.childProcess.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(successfulManager.getCallCount("startDevice")).toBe(1);
    expect(coordinator.isDirty("emulator-5554")).toBe(true);
    expect(pool.getDevice("emulator-5554")).toBeNull();
    expect(sessionManager.getTerminalReleaseSnapshot("session-1")).toMatchObject({
      sessionId: "session-1",
      deviceId: "emulator-5554",
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("terminally fences a session released while shutdown is being confirmed", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const releaseDuringWaitManager = new ReleaseDuringShutdownWaitDeviceManager();
    manager = releaseDuringWaitManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => releaseDuringWaitManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    releaseDuringWaitManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      releaseDuringWaitManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    await pool.addDevice({
      name: "Pixel 9",
      platform: "android",
      deviceId: "emulator-5560",
    });
    releaseDuringWaitManager.onShutdownWait = async () => {
      await sessionManager.releaseSession("session-1", "explicit-release");
      await pool.releaseDevice(image.deviceId!, "session-1");
      expect(pool.getDevice(image.deviceId!)?.sessionId).toBeNull();
      await expect(sessionManager.getOrCreateSession("session-1", pool, "android")).rejects.toThrow(
        "being terminally released",
      );
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
    });

    expect(sessionManager.getTerminalReleaseSnapshot("session-1")).toMatchObject({
      deviceId: image.deviceId,
      releaseReason: "device-killed",
      terminal: true,
    });
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("captures a session released immediately before shutdown reservation", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    await sessionManager.releaseSession("session-1", "explicit-release");
    expect(pool.getDevice(image.deviceId!)?.sessionId).toBe("session-1");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
    });

    expect(sessionManager.getTerminalReleaseSnapshot("session-1")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("captures a session whose ordinary release persistence is still in flight", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new DeferredReleaseDeviceSessionRepository();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");

    const ordinaryRelease = sessionManager.releaseSession("session-1", "explicit-release");
    await deviceSessionRepository.waitForMarkReleased();
    const reservationStarted = Promise.withResolvers<void>();
    const reserveDeviceForShutdown = pool.reserveDeviceForShutdown.bind(pool);
    pool.reserveDeviceForShutdown = async (...args) => {
      const reservation = await reserveDeviceForShutdown(...args);
      reservationStarted.resolve();
      return reservation;
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
    });
    await reservationStarted.promise;
    deviceSessionRepository.finishMarkReleased();
    await Promise.all([ordinaryRelease, result]);

    expect(sessionManager.getTerminalReleaseSnapshot("session-1")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("finishes device retirement after terminal release persistence retries", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FailFirstReleaseDeviceSessionRepository(2);
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    let reservationReleaseCalls = 0;
    const reserveDeviceForShutdown = pool.reserveDeviceForShutdown.bind(pool);
    pool.reserveDeviceForShutdown = async (...args) => {
      const reservation = await reserveDeviceForShutdown(...args);
      if (!reservation) {
        return undefined;
      }
      const release = reservation.release;
      return {
        ...reservation,
        release: async () => {
          reservationReleaseCalls++;
          await release();
        },
      };
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(
      tool.handler({
        device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
      }),
    ).rejects.toThrow("Failed to persist terminal release");
    timer.advanceTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));

    expect(deviceSessionRepository.releaseAttempts).toBe(3);
    expect(reservationReleaseCalls).toBe(1);
    expect(pool.getDevice(image.deviceId!)).toBeNull();
    expect(sessionManager.getTerminalReleaseSnapshot("session-1")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("bounds terminal release persistence retries while retaining shutdown ownership", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FailFirstReleaseDeviceSessionRepository(
      Number.POSITIVE_INFINITY,
    );
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    let reservationReleaseCalls = 0;
    const reserveDeviceForShutdown = pool.reserveDeviceForShutdown.bind(pool);
    pool.reserveDeviceForShutdown = async (...args) => {
      const reservation = await reserveDeviceForShutdown(...args);
      if (!reservation) {
        return undefined;
      }
      const release = reservation.release;
      return {
        ...reservation,
        release: async () => {
          reservationReleaseCalls++;
          await release();
        },
      };
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(
      tool.handler({
        device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
      }),
    ).rejects.toThrow("Failed to persist terminal release");
    timer.advanceTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(10_000);
    await new Promise((resolve) => setImmediate(resolve));

    expect(deviceSessionRepository.releaseAttempts).toBe(3);
    expect(reservationReleaseCalls).toBe(0);
    await expect(pool.reserveDeviceForShutdown(image.deviceId!)).rejects.toThrow(
      "already shutting down",
    );
    expect(sessionManager.getTerminalReleaseSnapshot("session-1")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("keeps the initiating parallel plan alive while cancelling other execution tracks", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const initiatingPlan = executionTracker.startExecution("executePlan", undefined, "session-1");
    const competingExecution = executionTracker.startExecution("tapOn", undefined, "session-1");
    const trackAbortController = new AbortController();
    const parallelTrackSignal = AbortSignal.any([
      initiatingPlan.abortController.signal,
      trackAbortController.signal,
    ]);
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    try {
      expect(parallelTrackSignal).not.toBe(initiatingPlan.abortController.signal);
      await runWithToolSelectionContext(
        {
          execution: {
            executionId: initiatingPlan.id,
            startTime: initiatingPlan.startTime,
          },
        },
        async () =>
          await runWithAbortSignal(
            parallelTrackSignal,
            async () =>
              await tool.handler(
                { device: { name: image.name, platform: "android", deviceId: image.deviceId! } },
                undefined,
                parallelTrackSignal,
              ),
          ),
      );

      expect(initiatingPlan.abortController.signal.aborted).toBe(false);
      expect(competingExecution.abortController.signal.aborted).toBe(true);
    } finally {
      executionTracker.endExecution(initiatingPlan.id);
      executionTracker.endExecution(competingExecution.id);
    }
  });

  test("bypasses the Android device-list cache while confirming shutdown", async () => {
    const timer = new FakeTimer();
    const cacheAwareManager = new ShutdownDiscoveryOptionsDeviceManager();
    manager = cacheAwareManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => cacheAwareManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    cacheAwareManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      cacheAwareManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    cacheAwareManager.beginTrackingShutdownDiscovery();
    await tool.handler({
      device: { name: image.name, platform: "android", deviceId: image.deviceId! },
    });

    expect(cacheAwareManager.shutdownDiscoveryOptions).not.toBeEmpty();
    expect(cacheAwareManager.shutdownDiscoveryOptions).toEqual(
      expect.arrayContaining([{ bypassAndroidDeviceListCache: true }]),
    );
  });

  test("waits for the runtime the Android kill preflight actually resolved", async () => {
    const timer = new FakeTimer();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const currentDevice: BootedDevice = {
      name: image.name,
      platform: "android",
      deviceId: image.deviceId!,
    };
    const currentRuntimeManager = new CurrentRuntimeKillDeviceManager(currentDevice);
    manager = currentRuntimeManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => currentRuntimeManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    currentRuntimeManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      currentRuntimeManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    currentRuntimeManager.beginShutdownPolls();
    // The caller's identity is stale: killDevice resolves the live runtime and
    // must wait for THAT one to leave. Waiting on the caller's stale name would
    // read the very first poll as "something else already took this serial" and
    // retire the pool entry before the device physically exited.
    const result = tool.handler(
      tool.schema.parse({
        device: {
          name: "Stale AVD",
          platform: "android",
          deviceId: image.deviceId!,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(pool.getDevice(image.deviceId!)).not.toBeNull();
    timer.advanceTime(1_000);
    await expect(result).resolves.toBeDefined();

    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("waits for physical exit before retiring the matching session, pool entry, and device session", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const delayedManager = new DelayedSuccessfulKillDeviceManager();
    manager = delayedManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => delayedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    delayedManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      delayedManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const pooled = pool.getDevice("emulator-5554");
    if (!pooled) {
      throw new Error("expected assigned device to be pooled");
    }
    const deviceSession = registry.onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });

    // `adb emu kill` resolving only means the command was accepted. Keep the
    // fake visible until after the handler starts waiting for its disappearance.
    delayedManager.setBootedDevices("android", [
      {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    ]);
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }
    const result = tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    });

    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(pool.getDevice(image.deviceId!)).toBe(pooled);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBe("session-1");
    expect(registry.getByUuid(deviceSession.deviceSessionUuid)).toBeDefined();

    delayedManager.setBootedDevices("android", []);
    timer.advanceTime(1_000);
    const response = await result;
    expect(response.isError).toBeUndefined();
    expect(pool.getDevice(image.deviceId!)).toBeNull();
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(deviceSession.deviceSessionUuid)).toBeUndefined();
  });

  test("keeps a shutdown target reserved against allocation during ownership release", async () => {
    const timer = new FakeTimer();
    const delayedManager = new DelayedSuccessfulKillDeviceManager();
    manager = delayedManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    let allocationOutcome: "assigned" | "blocked" | undefined;
    const deviceSessionRepository = new ReplacingDeviceSessionRepository(async () => {
      const activePool = DaemonState.getInstance().getDevicePool();
      await activePool.releaseDevice(image.deviceId!);
      allocationOutcome = await activePool
        .assignMultipleDevices(["racing-session"], 1, "android")
        .then(
          () => "assigned" as const,
          () => "blocked" as const,
        );
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => delayedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    delayedManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      delayedManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected assigned device to be pooled");
    }
    delayedManager.setBootedDevices("android", [
      {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    ]);
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: "android", deviceId: image.deviceId! },
    });
    await new Promise((resolve) => setImmediate(resolve));
    delayedManager.setBootedDevices("android", []);
    timer.advanceTime(1_000);
    await expect(result).resolves.toBeDefined();

    expect(allocationOutcome).toBe("blocked");
    expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
    expect(sessionManager.getSession("racing-session")).toBeNull();
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("keeps a shutdown target reserved against direct session binding", async () => {
    const timer = new FakeTimer();
    const delayedManager = new DelayedSuccessfulKillDeviceManager();
    manager = delayedManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    let bindingError: unknown;
    const deviceSessionRepository = new ReplacingDeviceSessionRepository(async () => {
      const activePool = DaemonState.getInstance().getDevicePool();
      await activePool.releaseDevice(image.deviceId!);
      try {
        await activePool.bindOrReuseDeviceSession("racing-session", image.deviceId!, "android");
      } catch (error) {
        bindingError = error;
      }
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => delayedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    delayedManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      delayedManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    delayedManager.setBootedDevices("android", [
      {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    ]);
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: "android", deviceId: image.deviceId! },
    });
    await new Promise((resolve) => setImmediate(resolve));
    delayedManager.setBootedDevices("android", []);
    timer.advanceTime(1_000);
    await expect(result).resolves.toBeDefined();

    expect(bindingError).toBeInstanceOf(Error);
    expect(String(bindingError)).toContain("shutting down");
    expect(sessionManager.getSession("racing-session")).toBeNull();
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("reserves a shutdown target before recording teardown yields", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    let allocationOutcome: "assigned" | "blocked" | undefined;
    let recordingListCalls = 0;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    await pool.releaseDevice(image.deviceId!, "session-1");
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {
        stopRecording: async () => {
          allocationOutcome = await pool
            .assignMultipleDevices(["racing-session"], 1, "android")
            .then(
              () => "assigned" as const,
              () => "blocked" as const,
            );
          throw new Error("recording already stopped");
        },
      } as never,
      recordingRepository: {
        listRecordings: async () => {
          recordingListCalls++;
          return recordingListCalls === 1 ? [] : [{ recordingId: "recording-1" }];
        },
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: { name: image.name, platform: "android", deviceId: image.deviceId! },
    });

    expect(allocationOutcome).toBe("blocked");
    expect(sessionManager.getSession("racing-session")).toBeNull();
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("releases a shutdown reservation when recording teardown exhausts the deadline", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    let recordingListCalls = 0;
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {
        stopRecording: async () => await new Promise<void>(() => {}),
      } as never,
      recordingRepository: {
        listRecordings: async () => {
          recordingListCalls++;
          return recordingListCalls === 1 ? [] : [{ recordingId: "recording-1" }];
        },
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
    });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);

    await expect(result).rejects.toThrow("video recording teardown did not complete");
    expect(pool.getDevice(image.deviceId!)?.sessionId).toBe("session-1");
    await pool.releaseDevice(image.deviceId!, "session-1");
    expect(pool.getAvailableDeviceCount()).toBe(1);
  });

  test("returns an actionable timeout instead of reporting success while the device remains visible", async () => {
    const timer = new FakeTimer();
    const delayedManager = new DelayedSuccessfulKillDeviceManager();
    manager = delayedManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => delayedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    delayedManager.setBootedDevices("android", [device]);
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({ device });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);

    await expect(result).rejects.toThrow(
      "Timed out waiting for android device 'Pixel 8' (emulator-5554) to disappear",
    );
  });

  test("clears the intentional-shutdown marker after confirmation times out", async () => {
    const timer = new FakeTimer();
    const delayedManager = new DelayedSuccessfulKillDeviceManager();
    manager = delayedManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => delayedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    delayedManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      delayedManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    delayedManager.setBootedDevices("android", [
      {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    ]);
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: "android", deviceId: image.deviceId! },
    });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);
    await expect(result).rejects.toThrow("Timed out waiting for android device");

    Object.assign(delayedManager.childProcess, { exitCode: 1 });
    delayedManager.childProcess.emit("exit", 1, null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(delayedManager.getCallCount("startDevice")).toBe(2);
  });

  test("resumes shutdown polling when the same incarnation reappears after a transient absence", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const transientManager = new TransientAbsenceThenSameIncarnationDeviceManager(device);
    manager = transientManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => transientManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    transientManager.setDeviceImages("android", [
      {
        name: device.name,
        platform: device.platform,
        deviceId: device.deviceId,
        isRunning: false,
        source: "local",
      },
    ]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      transientManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler(tool.schema.parse({ device }));
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    expect(transientManager.shutdownDiscoveryCalls).toBe(4);
    timer.advanceTime(1_000);
    await expect(result).resolves.toBeDefined();

    expect(transientManager.shutdownDiscoveryCalls).toBe(5);
    expect(pool.getDevice(device.deviceId)).toBeNull();
  });

  test("awaits iOS pool removal before retiring its device-session epoch", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "ios-udid-1",
      isRunning: false,
      source: "local",
    };
    successfulManager.setDeviceImages("ios", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "ios");
    const pooled = pool.getDevice(image.deviceId!);
    if (!pooled) {
      throw new Error("expected assigned iOS device to be pooled");
    }
    const deviceSession = registry.onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: { name: image.name, platform: "ios", deviceId: image.deviceId! },
    });

    expect(pool.getDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(deviceSession.deviceSessionUuid)).toBeUndefined();
  });

  test("releases an iOS shutdown reservation after a late CtrlProxy teardown failure", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "ios-udid-1",
      isRunning: false,
      source: "local",
    };
    let rejectStop: (error: Error) => void;
    const deferredStop = new Promise<void>((_, reject) => {
      rejectStop = reject;
    });
    const originalGetInstance = IOSCtrlProxyManager.getInstance;
    (
      IOSCtrlProxyManager as unknown as {
        getInstance: typeof IOSCtrlProxyManager.getInstance;
      }
    ).getInstance = () => ({ stop: () => deferredStop }) as never;
    try {
      setDeviceToolsDependencies({
        deviceManagerFactory: () => successfulManager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      sessionManager = new SessionManager(timer, new FakeDeviceSessionRepository());
      successfulManager.setDeviceImages("ios", [image]);
      const pool = new DevicePool(
        sessionManager,
        "daemon-session",
        timer,
        new FakeInstalledAppsRepository(),
        successfulManager,
        new DefaultRetryExecutor(timer),
        new FakeDeviceSessionRepository(),
      );
      DaemonState.getInstance().initialize(sessionManager, pool);
      await pool.assignMultipleDevices(["session-1"], 1_000, "ios");
      await pool.releaseDevice(image.deviceId!, "session-1");
      const tool = ToolRegistry.getTool("killDevice");
      if (!tool) {
        throw new Error("killDevice not registered");
      }

      const result = tool.handler({
        device: { name: image.name, platform: "ios", deviceId: image.deviceId! },
      });
      await new Promise((resolve) => setImmediate(resolve));
      timer.advanceTime(30_000);
      await expect(result).rejects.toThrow("iOS CtrlProxy shutdown did not complete");
      expect(pool.getStats()).toMatchObject({ idle: 0, assigned: 1 });

      rejectStop!(new Error("CtrlProxy stop failed"));
      await deferredStop.catch(() => undefined);
      expect(pool.getStats()).toMatchObject({ idle: 1, assigned: 0 });
    } finally {
      (
        IOSCtrlProxyManager as unknown as {
          getInstance: typeof IOSCtrlProxyManager.getInstance;
        }
      ).getInstance = originalGetInstance;
    }
  });

  test("bounds a hung shutdown discovery with the same actionable timeout", async () => {
    const timer = new FakeTimer();
    const hungManager = new HungDiscoveryKillDeviceManager();
    manager = hungManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => hungManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({ device });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);

    await expect(result).rejects.toThrow("platform discovery did not complete");
  });

  test("aborts a hung shutdown discovery when the deadline expires", async () => {
    const timer = new FakeTimer();
    const abortAwareManager = new AbortAwareHungDiscoveryKillDeviceManager();
    manager = abortAwareManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => abortAwareManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    const device: BootedDevice = {
      name: "iPhone 16",
      platform: "ios",
      deviceId: "IOS-UDID",
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({ device });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);
    await expect(result).rejects.toThrow("platform discovery did not complete");

    expect(abortAwareManager.discoveryWasAborted).toBe(true);
  });

  test("leases the current resolved AVD name when pooled metadata is stale", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const hungManager = new AbortAwareHungShutdownCommandDeviceManager();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    manager = hungManager;
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    hungManager.setDeviceImages("android", [
      {
        name: "Old AVD",
        platform: "android",
        deviceId: "emulator-5554",
        isRunning: false,
        source: "local",
      },
    ]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      hungManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    expect(pool.getDevice("emulator-5554")?.avdName).toBe("Old AVD");
    setDeviceToolsDependencies({
      deviceManagerFactory: () => hungManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
      lifecycleCoordinator,
    });
    const device: BootedDevice = {
      name: "Current AVD",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({ device });
    await new Promise((resolve) => setImmediate(resolve));
    const competingLease = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: device.name },
      { operation: "start", deadlineMs: 1_000 },
    );
    let acquired = false;
    void competingLease.then(() => {
      acquired = true;
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(acquired).toBe(false);

    hungManager.settleCommand();
    await expect(result).resolves.toBeDefined();
    const lease = await competingLease;
    lease.release();
  });

  test("bounds and aborts a hung platform shutdown command", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const hungManager = new AbortAwareHungShutdownCommandDeviceManager();
    manager = hungManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => hungManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
      lifecycleCoordinator,
    });
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({ device });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);

    await expect(result).rejects.toThrow("platform shutdown command did not complete");
    expect(hungManager.commandWasAborted).toBe(true);
    expect(hungManager.commandOptions?.timeoutMs).toBe(30_000);

    const startLease = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: device.name },
      { operation: "start", deadlineMs: 31_000 },
    );
    let acquired = false;
    void startLease.then(() => {
      acquired = true;
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(acquired).toBe(false);

    hungManager.settleCommand();
    const lease = await startLease;
    lease.release();
  });

  test("releases a pooled shutdown reservation after the late command rejects", async () => {
    const timer = new FakeTimer();
    const hungManager = new AbortAwareHungShutdownCommandDeviceManager();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    manager = hungManager;
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    hungManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      hungManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    await pool.releaseDevice(image.deviceId!, "session-1");
    setDeviceToolsDependencies({
      deviceManagerFactory: () => hungManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
    });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);
    await expect(result).rejects.toThrow("platform shutdown command did not complete");
    expect(pool.getAvailableDeviceCount()).toBe(0);

    hungManager.rejectCommand(new Error("late adb emu kill failure"));
    for (let attempt = 0; pool.getAvailableDeviceCount() === 0 && attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(pool.getAvailableDeviceCount()).toBe(1);
  });

  test("preserves caller cancellation while shutdown discovery is pending", async () => {
    const timer = new FakeTimer();
    const abortAwareManager = new AbortAwareHungDiscoveryKillDeviceManager();
    let markedIntentionalShutdown = 0;
    let clearedIntentionalShutdown = 0;
    manager = abortAwareManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => abortAwareManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    DaemonState.getInstance().initialize(
      {} as SessionManager,
      {
        markIntentionalShutdown: () => {
          markedIntentionalShutdown++;
        },
        clearIntentionalShutdown: () => {
          clearedIntentionalShutdown++;
        },
        reserveDeviceForShutdown: async () => undefined,
      } as never,
    );
    const controller = new AbortController();
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler(
      {
        device: { name: "Pixel 8", platform: "android", deviceId: "emulator-5554" },
      },
      undefined,
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("caller cancelled shutdown"));

    await expect(result).rejects.toThrow("caller cancelled shutdown");
    expect(abortAwareManager.discoveryWasAborted).toBe(true);
    expect(markedIntentionalShutdown).toBe(1);
    expect(clearedIntentionalShutdown).toBe(0);
  });

  test("does not retire ownership when shutdown discovery fails", async () => {
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const delayedManager = new DelayedSuccessfulKillDeviceManager();
    manager = delayedManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => delayedManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    delayedManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      delayedManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const pooled = pool.getDevice(image.deviceId!);
    if (!pooled) {
      throw new Error("expected assigned device to be pooled");
    }
    const deviceSession = registry.onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });
    delayedManager.failedPlatforms.add("android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(30_000);

    await expect(result).rejects.toThrow("platform discovery did not succeed");
    expect(pool.getDevice(image.deviceId!)).toBe(pooled);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBe("session-1");
    expect(registry.getByUuid(deviceSession.deviceSessionUuid)).toBeDefined();
  });

  test("does not remove a replacement pool incarnation during shutdown ownership retirement", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const deviceSessionRepository = new ReplacingDeviceSessionRepository(async () => {
      await pool.releaseDevice(image.deviceId!);
      await pool.removeDevice(image.deviceId!);
      await pool.initializeWithDevices([replacement]);
      const replacementPooled = pool.getDevice(image.deviceId!);
      if (!replacementPooled) {
        throw new Error("expected replacement device to enter the pool");
      }
      registry.onDeviceConnected({
        deviceId: replacementPooled.id,
        platform: replacementPooled.platform,
        incarnation: replacementPooled.incarnation,
      });
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected original device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    });

    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(current?.name).toBe(replacement.name);
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
  });

  test("rebuilds a same-ID device that reappears while releasing the old session", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const deviceSessionRepository = new ReplacingDeviceSessionRepository(async () => {
      successfulManager.setBootedDevices("android", [replacement]);
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected original device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    });

    await expect(result).resolves.toBeDefined();
    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(current?.name).toBe(replacement.name);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
  });

  // While an emulator shuts down, `adb devices` can keep listing its serial after
  // the console has stopped answering `avd name`, so discovery labels the device
  // that is STILL THERE `Unknown (<serial>)`. That placeholder is not evidence
  // that a different AVD took the serial: reading it as a replacement would end
  // the shutdown wait early and rebuild the pool around a device that is still
  // going away (#6863 review).
  test("does not treat an unresolved name during shutdown as a same-ID replacement", async () => {
    const timer = new FakeTimer();
    // The wait has to poll again instead of returning on the first observation,
    // so the fake clock has to keep moving for the second discovery to happen.
    timer.enableAutoAdvance();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const stillShuttingDown: BootedDevice = {
      name: `Unknown (${image.deviceId!})`,
      platform: "android",
      deviceId: image.deviceId!,
    };
    const shutdownManager = new FirstReplacementThenEmptyDeviceManager(stillShuttingDown);
    manager = shutdownManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => shutdownManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    shutdownManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      shutdownManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(tool.handler(tool.schema.parse({ device: { ...image } }))).resolves.toBeDefined();

    // The wait ran on to actual absence, so the device is retired rather than
    // rebuilt under a fresh incarnation labelled with the placeholder.
    expect(pool.getDevice(image.deviceId!)).toBeNull();
  });

  test("releases the shutdown reservation before post-shutdown cleanup", async () => {
    const timer = new FakeTimer();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const replacementManager = new FirstReplacementThenEmptyDeviceManager(replacement);
    manager = replacementManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    let finishCleanup: (() => void) | undefined;
    let resolveCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      resolveCleanupStarted = resolve;
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => replacementManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {
        resolveCleanupStarted?.();
        await new Promise<void>((resolve) => {
          finishCleanup = resolve;
        });
      },
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    replacementManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      replacementManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler(
      tool.schema.parse({
        device: { ...image },
      }),
    );
    await cleanupStarted;

    const replacementReservation = await pool.reserveDeviceForShutdown(image.deviceId!);
    expect(replacementReservation?.device.name).toBe(replacement.name);
    await replacementReservation?.release();

    finishCleanup?.();
    await expect(result).resolves.toBeDefined();
  });

  test("finishes retiring a stopped device after a timed-out session release completes", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const deviceSessionRepository = new DeferredReleaseDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const pooled = pool.getDevice(image.deviceId!);
    if (!pooled) {
      throw new Error("expected assigned device to be pooled");
    }
    const deviceSession = registry.onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({
      device: { name: image.name, platform: image.platform, deviceId: image.deviceId! },
    });
    await deviceSessionRepository.waitForMarkReleased();
    timer.advanceTime(30_000);

    await expect(result).rejects.toThrow("session ownership retirement did not complete");
    expect(pool.getDevice(image.deviceId!)).toBe(pooled);

    deviceSessionRepository.finishMarkReleased();
    await new Promise((resolve) => setImmediate(resolve));

    expect(pool.getDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(deviceSession.deviceSessionUuid)).toBeUndefined();
  });

  test("recognizes a same-ID Android replacement before the first shutdown poll", async () => {
    const timer = new FakeTimer();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    // The AVD this pool started, rediscovered on the serial after the kill --
    // a different runtime from the one the caller observed before it.
    const replacement: BootedDevice = {
      name: image.name,
      platform: "android",
      deviceId: image.deviceId!,
    };
    const replacementManager = new ReplacementBeforeShutdownWaitDeviceManager(replacement);
    manager = replacementManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => replacementManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    replacementManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      replacementManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected original device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    // With no ADB transport id in the identity model, a same-serial replacement
    // is recognized by its runtime name -- and only by a RESOLVED one on both
    // sides. Here the caller's pre-kill observation and the device found on the
    // serial afterwards both name an AVD, and they differ, so the handoff is
    // detected before the first shutdown poll. An `Unknown (<serial>)` on either
    // side would assert nothing and the wait would run on instead (#6863
    // review).
    await expect(
      tool.handler(
        tool.schema.parse({
          device: {
            name: "Pixel 7 API 34",
            platform: "android",
            deviceId: image.deviceId!,
          },
        }),
      ),
    ).resolves.toBeDefined();

    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
    expect(pool.getRecoveryEligibility(image.deviceId!)).toEqual({
      eligible: true,
      action: "restart",
    });
  });

  test("rebuilds a replacement observed by the initial shutdown wait", async () => {
    const timer = new FakeTimer();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const replacementManager = new FirstReplacementThenEmptyDeviceManager(replacement);
    manager = replacementManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => replacementManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    replacementManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      replacementManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(
      tool.handler(
        tool.schema.parse({
          device: { ...image },
        }),
      ),
    ).resolves.toBeDefined();

    expect(pool.getDevice(image.deviceId!)?.name).toBe(replacement.name);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
  });

  test("rebuilds a replacement found after a failed post-release discovery", async () => {
    const timer = new FakeTimer();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const replacementManager = new FailedDiscoveryThenReplacementDeviceManager(replacement);
    manager = replacementManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => replacementManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    replacementManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      replacementManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected original device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    replacementManager.beginReplacementSequence();
    const result = tool.handler(
      tool.schema.parse({
        device: {
          name: image.name,
          platform: "android",
          deviceId: image.deviceId!,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    timer.advanceTime(1_000);
    await expect(result).resolves.toBeDefined();

    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(current?.name).toBe(replacement.name);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
  });

  test("retires ownership after shutdown is observed at the disappearance deadline", async () => {
    const timer = new FakeTimer();
    const deadlineManager = new DeadlineExhaustingShutdownDeviceManager(timer);
    manager = deadlineManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deadlineManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    deadlineManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deadlineManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const pooled = pool.getDevice(image.deviceId!);
    if (!pooled) {
      throw new Error("expected assigned device to be pooled");
    }
    const deviceSession = registry.onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    deadlineManager.exhaustDeadlineOnNextShutdownDiscovery();
    await expect(
      tool.handler({
        device: { name: image.name, platform: "android", deviceId: image.deviceId! },
      }),
    ).resolves.toBeDefined();

    expect(pool.getDevice(image.deviceId!)).toBeNull();
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(deviceSession.deviceSessionUuid)).toBeUndefined();
  });

  test("rechecks for a replacement that boots while releasing ownership after the deadline", async () => {
    const timer = new FakeTimer();
    const deadlineManager = new DeadlineExhaustingShutdownDeviceManager(timer);
    manager = deadlineManager;
    const stoppedDeviceIds: string[] = [];
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const deviceSessionRepository = new ReplacingDeviceSessionRepository(async () => {
      deadlineManager.setBootedDevices("android", [replacement]);
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deadlineManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      stopPerformanceMonitoring: (deviceId) => stoppedDeviceIds.push(deviceId),
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    deadlineManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deadlineManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected assigned device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    deadlineManager.exhaustDeadlineOnNextShutdownDiscovery();
    await expect(
      tool.handler({
        device: { name: image.name, platform: "android", deviceId: image.deviceId! },
      }),
    ).resolves.toBeDefined();

    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(current?.name).toBe(replacement.name);
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
    expect(stoppedDeviceIds).toEqual([image.deviceId]);
  });

  test("stops performance monitoring after direct shutdown retirement", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const stoppedDeviceIds: string[] = [];
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      stopPerformanceMonitoring: (deviceId) => stoppedDeviceIds.push(deviceId),
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(
      tool.handler({
        device: { name: image.name, platform: "android", deviceId: image.deviceId! },
      }),
    ).resolves.toBeDefined();

    expect(stoppedDeviceIds).toEqual([image.deviceId]);
  });

  test("keeps a replacement epoch created during shutdown cache cleanup", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const registry = new DeviceSessionRegistry(timer);
    const installedAppsRepository = new ReplacementDuringCacheClearRepository(async () => {
      await pool.addDevice(replacement);
      const current = pool.getDevice(image.deviceId!);
      if (!current) {
        throw new Error("expected replacement device to be pooled");
      }
      registry.onDeviceConnected({
        deviceId: current.id,
        platform: current.platform,
        incarnation: current.incarnation,
      });
    });
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      installedAppsRepository,
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected original device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: { name: image.name, platform: "android", deviceId: image.deviceId! },
    });

    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(current?.name).toBe(replacement.name);
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
  });

  test("does not publish a same-ID replacement's dead incarnation as idle", async () => {
    const timer = new FakeTimer();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    const image: DeviceInfo = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local",
    };
    const replacement: BootedDevice = {
      name: "Pixel 8 replacement",
      platform: "android",
      deviceId: image.deviceId!,
    };
    const deviceSessionRepository = new ReplacingDeviceSessionRepository(async () => {
      successfulManager.setBootedDevices("android", [replacement]);
    });
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    successfulManager.setDeviceImages("android", [image]);
    const pool = new AllocationRaceDevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      successfulManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    const registry = new DeviceSessionRegistry(timer);
    DaemonState.getInstance().initialize(sessionManager, pool, registry);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const original = pool.getDevice(image.deviceId!);
    if (!original) {
      throw new Error("expected original device to be pooled");
    }
    const originalSession = registry.onDeviceConnected({
      deviceId: original.id,
      platform: original.platform,
      incarnation: original.incarnation,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await tool.handler({
      device: {
        name: image.name,
        platform: "android",
        deviceId: image.deviceId!,
      },
    });

    const current = pool.getDevice(image.deviceId!);
    expect(current).not.toBeNull();
    expect(current).not.toBe(original);
    expect(current?.name).toBe(replacement.name);
    expect(sessionManager.getSessionForDevice(image.deviceId!)).toBeNull();
    expect(registry.getByUuid(originalSession.deviceSessionUuid)).toBeUndefined();
    expect(registry.getByDeviceId(image.deviceId!)?.deviceSessionUuid).toBeDefined();
  });

  test.each([
    ["android", "Emulator 'forge-ivory-crown' is not running"],
    ["android", "adb: device 'emulator-5554' not found"],
    ["ios", "Unable to shutdown device: device is already shut down"],
  ] as const)(
    "returns a structured terminal error for an already-stopped %s device",
    async (platform, message) => {
      let cleanupCalled = false;
      let notifyCalled = false;
      let markedIntentionalShutdown = 0;
      let clearedIntentionalShutdown = 0;
      const stoppedManager = new AlreadyStoppedKillDeviceManager(message);
      manager = stoppedManager;
      if (platform === "android") {
        DaemonState.getInstance().initialize(
          {} as SessionManager,
          {
            markIntentionalShutdown: () => {
              markedIntentionalShutdown++;
            },
            clearIntentionalShutdown: () => {
              clearedIntentionalShutdown++;
            },
            reserveDeviceForShutdown: async () => undefined,
          } as never,
        );
      }
      setDeviceToolsDependencies({
        deviceManagerFactory: () => stoppedManager,
        notifyResourcesChanged: async () => {
          notifyCalled = true;
        },
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {
          cleanupCalled = true;
        },
      });
      registerDeviceTools();

      const tool = ToolRegistry.getTool("killDevice");
      if (!tool) {
        throw new Error("killDevice not registered");
      }
      const response = await tool.handler({
        device: {
          name: platform === "android" ? "Pixel 8" : "iPhone 16",
          platform,
          deviceId: platform === "android" ? "emulator-5554" : "IOS-UDID",
        },
      });

      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text)).toEqual({
        success: false,
        message: expect.stringContaining(message),
        error: {
          code: "device_already_stopped",
          message: expect.stringContaining(message),
        },
      });
      expect(cleanupCalled).toBe(true);
      expect(notifyCalled).toBe(true);
      if (platform === "android") {
        expect(markedIntentionalShutdown).toBe(1);
        expect(clearedIntentionalShutdown).toBe(0);
      }
    },
  );

  test("keeps recording-list failures as actionable errors", async () => {
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: {
        listRecordings: async () => {
          throw new Error("Emulator 'forge-ivory-crown' is not running");
        },
      } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });

    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    await expect(
      tool.handler({
        device: {
          name: "Pixel 8",
          platform: "android",
          deviceId: "emulator-5554",
        },
      }),
    ).rejects.toThrow("Failed to kill android device");
  });

  test("detaches Android observers so a killed emulator stops holding the response open", async () => {
    const timer = new FakeTimer();
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const observationManager = new ActiveObservationKillDeviceManager(device);
    manager = observationManager;
    const stoppedObserverDeviceIds: string[] = [];
    setDeviceToolsDependencies({
      deviceManagerFactory: () => observationManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      stopAndroidObservers: async (target) => {
        stoppedObserverDeviceIds.push(target.deviceId);
        observationManager.markObserversStopped();
      },
      timer,
    });
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    const result = tool.handler({ device });
    await new Promise((resolve) => setImmediate(resolve));
    // Advancing the full deadline makes the pre-fix hang deterministic: without
    // observer teardown the device never disappears and this reaches the timeout.
    timer.advanceTime(30_000);

    const response = await result;
    // Teardown ran against the shutting-down device's observers...
    expect(stoppedObserverDeviceIds).toEqual(["emulator-5554"]);
    // ...so the tool resolves with success rather than the shutdown-timeout error.
    expect(JSON.stringify(response)).toContain("shutdown successfully");
    expect(JSON.stringify(response)).not.toContain("Timed out waiting for");
  });

  test.skipIf(process.platform === "win32")(
    "restores an active Android observer when an ordinary kill failure leaves its incarnation booted",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      manager.setBootedDevices("android", [device]);
      const deviceSessionRepository = new FakeDeviceSessionRepository();
      sessionManager = new SessionManager(timer, deviceSessionRepository);
      const image: DeviceInfo = {
        name: device.name,
        platform: device.platform,
        deviceId: device.deviceId,
        isRunning: false,
        source: "local",
      };
      manager.setDeviceImages("android", [image]);
      const pool = new DevicePool(
        sessionManager,
        "daemon-session",
        timer,
        new FakeInstalledAppsRepository(),
        manager,
        new DefaultRetryExecutor(timer),
        deviceSessionRepository,
      );
      DaemonState.getInstance().initialize(sessionManager, pool);
      await pool.assignMultipleDevices(["session-5503"], 1_000, "android");
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      // An active observation-stream subscriber has already caused this singleton
      // to exist. Its cadence callback later resolves only an existing instance.
      const activeObserver = AndroidCtrlProxyClient.getInstance(
        { ...device },
        new FakeAdbClientFactory(),
      );
      activeObserver.bindSession("session-5503");
      const closeSpy = spyOn(activeObserver, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let restoredObserver: AndroidCtrlProxyClient | undefined;
      let ensureConnectedSpy: ReturnType<typeof spyOn> | undefined;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => {
          restoredObserver = originalGetInstance(target, new FakeAdbClientFactory());
          ensureConnectedSpy = spyOn(restoredObserver, "ensureConnected")
            .mockResolvedValueOnce(false)
            .mockResolvedValue(true);
          return restoredObserver;
        },
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(getInstanceSpy).toHaveBeenCalledWith(device);
        expect(ensureConnectedSpy).toHaveBeenCalledTimes(2);
        const registeredObserver = AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
        expect(registeredObserver).toBe(restoredObserver);
        expect(registeredObserver).not.toBe(activeObserver);
        expect(registeredObserver?.getBoundSessionId()).toBe("session-5503");
      } finally {
        ensureConnectedSpy?.mockRestore();
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps the original kill failure bounded when observer reconnection stalls",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      manager.setBootedDevices("android", [device]);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const activeObserver = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(activeObserver, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let ensureConnectedSpy: ReturnType<typeof spyOn> | undefined;
      let restoredCloseSpy: ReturnType<typeof spyOn> | undefined;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => {
          const restoredObserver = originalGetInstance(target, new FakeAdbClientFactory());
          ensureConnectedSpy = spyOn(restoredObserver, "ensureConnected").mockImplementation(
            async () => await new Promise<boolean>(() => {}),
          );
          restoredCloseSpy = spyOn(restoredObserver, "close").mockImplementation(
            async () => await new Promise<void>(() => {}),
          );
          return restoredObserver;
        },
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        const result = tool.handler({ device });
        await new Promise((resolve) => setImmediate(resolve));
        timer.advanceTime(30_000);

        await expect(result).rejects.toThrow("adb emu kill failed");
        expect(ensureConnectedSpy).toHaveBeenCalledTimes(1);
        expect(restoredCloseSpy).toHaveBeenCalledTimes(1);
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      } finally {
        restoredCloseSpy?.mockRestore();
        ensureConnectedSpy?.mockRestore();
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "evicts an observer when its device is replaced during reconnection",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      // A different AVD taking the serial is the detectable replacement now
      // that the identity model carries no ADB transport id.
      const replacement: BootedDevice = { ...device, name: "Pixel 9" };
      const replacementManager = new ReplacementAfterObserverReconnectDeviceManager(
        device,
        replacement,
      );
      manager = replacementManager;
      setDeviceToolsDependencies({
        deviceManagerFactory: () => replacementManager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const activeObserver = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(activeObserver, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let restoredObserver: AndroidCtrlProxyClient | undefined;
      let ensureConnectedSpy: ReturnType<typeof spyOn> | undefined;
      let restoredCloseSpy: ReturnType<typeof spyOn> | undefined;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => {
          restoredObserver = originalGetInstance(target, new FakeAdbClientFactory());
          ensureConnectedSpy = spyOn(restoredObserver, "ensureConnected").mockResolvedValue(true);
          restoredCloseSpy = spyOn(restoredObserver, "close").mockResolvedValue(undefined);
          return restoredObserver;
        },
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(ensureConnectedSpy).toHaveBeenCalledTimes(1);
        expect(restoredCloseSpy).toHaveBeenCalledTimes(1);
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      } finally {
        restoredCloseSpy?.mockRestore();
        ensureConnectedSpy?.mockRestore();
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "retries incomplete Android discovery before restoring an observer",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      const incompleteManager = new IncompleteThenBootedDiscoveryKillDeviceManager(device);
      manager = incompleteManager;
      setDeviceToolsDependencies({
        deviceManagerFactory: () => incompleteManager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const activeObserver = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(activeObserver, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let ensureConnectedSpy: ReturnType<typeof spyOn> | undefined;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => {
          const restoredObserver = originalGetInstance(target, new FakeAdbClientFactory());
          ensureConnectedSpy = spyOn(restoredObserver, "ensureConnected").mockResolvedValue(true);
          return restoredObserver;
        },
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        const result = tool.handler({ device });
        await new Promise((resolve) => setImmediate(resolve));
        timer.advanceTime(1_000);

        await expect(result).rejects.toThrow("adb emu kill failed");
        expect(ensureConnectedSpy).toHaveBeenCalledTimes(1);
      } finally {
        ensureConnectedSpy?.mockRestore();
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not rebind an observer to a session released during failed shutdown",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      manager.setBootedDevices("android", [device]);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const activeObserver = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      activeObserver.bindSession("released-session");
      const closeSpy = spyOn(activeObserver, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let restoredObserver: AndroidCtrlProxyClient | undefined;
      let ensureConnectedSpy: ReturnType<typeof spyOn> | undefined;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => {
          restoredObserver = originalGetInstance(target, new FakeAdbClientFactory());
          ensureConnectedSpy = spyOn(restoredObserver, "ensureConnected").mockResolvedValue(true);
          return restoredObserver;
        },
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(ensureConnectedSpy).toHaveBeenCalledTimes(1);
        expect(restoredObserver?.getBoundSessionId()).toBeNull();
      } finally {
        ensureConnectedSpy?.mockRestore();
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps an Android observer detached when a failed kill leaves no booted device",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const observer = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(observer, "close").mockResolvedValue(undefined);
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      } finally {
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not create an Android observer when no active observer was detached",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      manager.setBootedDevices("android", [device]);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(getInstanceSpy).not.toHaveBeenCalled();
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      } finally {
        getInstanceSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "restores an observer when the kill request omits its known transport",
    async () => {
      const timer = new FakeTimer();
      const requestedDevice: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      const observedDevice: BootedDevice = {
        ...requestedDevice,
      };
      manager.setBootedDevices("android", [observedDevice]);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const activeObserver = AndroidCtrlProxyClient.getInstance(
        observedDevice,
        new FakeAdbClientFactory(),
      );
      const closeSpy = spyOn(activeObserver, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      let ensureConnectedSpy: ReturnType<typeof spyOn> | undefined;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => {
          const restoredObserver = originalGetInstance(target, new FakeAdbClientFactory());
          ensureConnectedSpy = spyOn(restoredObserver, "ensureConnected").mockResolvedValue(true);
          return restoredObserver;
        },
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device: requestedDevice })).rejects.toThrow(
          "adb emu kill failed",
        );

        expect(getInstanceSpy).toHaveBeenCalledWith(observedDevice);
        expect(ensureConnectedSpy).toHaveBeenCalledTimes(1);
      } finally {
        ensureConnectedSpy?.mockRestore();
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "does not restore an observer onto a different AVD that took the same serial",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      const replacement: BootedDevice = { ...device, name: "Pixel 9" };
      manager.setBootedDevices("android", [replacement]);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const observer = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(observer, "close").mockResolvedValue(undefined);
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance");
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(getInstanceSpy).not.toHaveBeenCalled();
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      } finally {
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "documented blind spot: a same-AVD restart on the same serial reads as the surviving incarnation",
    async () => {
      // Identity is platform + serial + name, so an emulator that restarted the
      // SAME AVD under the same serial between two observations is
      // indistinguishable from one that never left. The observer is restored
      // onto it; recovery depends on the observer's own post-connect identity
      // check and its reconnect failures, not on this comparison. Asserted so
      // the gap stays deliberate rather than becoming a surprise.
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      const restarted: BootedDevice = { ...device };
      manager.setBootedDevices("android", [restarted]);
      setDeviceToolsDependencies({
        deviceManagerFactory: () => manager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      const observer = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(observer, "close").mockResolvedValue(undefined);
      const originalGetInstance = AndroidCtrlProxyClient.getInstance;
      const getInstanceSpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
        (target) => originalGetInstance(target, new FakeAdbClientFactory()),
      );
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await expect(tool.handler({ device })).rejects.toThrow("adb emu kill failed");

        expect(getInstanceSpy).toHaveBeenCalled();
      } finally {
        getInstanceSpy.mockRestore();
        closeSpy.mockRestore();
      }
    },
  );

  // Skipped on Windows: bun evaluates `AndroidCtrlProxyClient` as more than one
  // module record there (the singleton creators import it via the
  // `features/observe/android` barrel while `deviceTools` teardown imports the
  // direct file), so the class statics — including the per-device `instances`
  // registry — do not share one map. `getExistingInstance` in the teardown then
  // reads an empty registry and the close/evict never runs. This is a
  // pre-existing bun-on-Windows module-duplication limitation, not specific to
  // killDevice: it cannot be bridged from application code (a `globalThis`-backed
  // registry does not unify the records either). The killDevice *hang* fix
  // (issue #5452) still holds on Windows — the observer detach simply degrades to
  // a no-op and shutdown proceeds — and this close/evict behavior is verified on
  // macOS/Linux, where module identity is stable.
  test.skipIf(process.platform === "win32")(
    "closes the registered Android CtrlProxy observer during teardown",
    async () => {
      const timer = new FakeTimer();
      const device: BootedDevice = {
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      };
      const successfulManager = new SuccessfulKillDeviceManager();
      manager = successfulManager;
      setDeviceToolsDependencies({
        deviceManagerFactory: () => successfulManager,
        notifyResourcesChanged: async () => {},
        ensureCtrlProxyReady: async () => {},
        clearInstalledAppsForDevice: async () => {},
        timer,
      });
      // A real per-device observer singleton, backed by a fake ADB factory so no
      // real device I/O runs. The default stopAndroidObservers dependency must
      // find and close it during teardown.
      const observer = AndroidCtrlProxyClient.getInstance(device, new FakeAdbClientFactory());
      const closeSpy = spyOn(observer, "close").mockResolvedValue(undefined);
      try {
        const tool = ToolRegistry.getTool("killDevice");
        if (!tool) {
          throw new Error("killDevice not registered");
        }

        await tool.handler({ device });

        expect(closeSpy).toHaveBeenCalledTimes(1);
        // The detached observer is evicted so a re-booted same-serial emulator
        // does not reuse a closed, reconnect-disabled client.
        expect(AndroidCtrlProxyClient.getExistingInstance(device.deviceId)).toBeNull();
      } finally {
        closeSpy.mockRestore();
      }
    },
  );
});
