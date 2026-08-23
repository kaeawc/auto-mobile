import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
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
import { DeviceSessionRepository } from "../../src/db/DeviceSessionRepository";
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

class FailingKillDeviceManager extends FakeDeviceUtils {
  readonly childProcess = new EventEmitter() as ChildProcess;

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

  override async killDevice(): Promise<void> {
    throw new Error("adb emu kill failed");
  }
}

class SuccessfulKillDeviceManager extends FailingKillDeviceManager {
  override async killDevice(device: BootedDevice): Promise<void> {
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

class CurrentTransportKillDeviceManager extends FailingKillDeviceManager {
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

  override killDevice(_: BootedDevice, options?: DeviceShutdownOptions): Promise<void> {
    this.commandOptions = options;
    options?.signal?.addEventListener(
      "abort",
      () => {
        this.commandWasAborted = true;
      },
      { once: true },
    );
    return new Promise<void>(() => {});
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
  private readonly markReleasedStarted = new Promise<void>((resolve) => {
    this.resolveMarkReleasedStarted = resolve;
  });

  override async markReleased(): Promise<void> {
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

describe("killDevice handler", () => {
  const originalPreferred = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
  const originalAlias = process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
  let sessionManager: SessionManager;
  let manager: FailingKillDeviceManager;

  beforeEach(async () => {
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
    const timer = new FakeTimer();
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    const successfulManager = new SuccessfulKillDeviceManager();
    manager = successfulManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => successfulManager,
      notifyResourcesChanged: async () => {
        throw new Error("resource notification failed");
      },
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {
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
    expect(pool.getDevice("emulator-5554")).toBeNull();
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

  test("waits for the transport that the Android kill preflight actually selected", async () => {
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
      transportId: "2",
    };
    const currentTransportManager = new CurrentTransportKillDeviceManager(currentDevice);
    manager = currentTransportManager;
    const deviceSessionRepository = new FakeDeviceSessionRepository();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => currentTransportManager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, deviceSessionRepository);
    currentTransportManager.setDeviceImages("android", [image]);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      currentTransportManager,
      new DefaultRetryExecutor(timer),
      deviceSessionRepository,
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.assignMultipleDevices(["session-1"], 1_000, "android");
    const tool = ToolRegistry.getTool("killDevice");
    if (!tool) {
      throw new Error("killDevice not registered");
    }

    currentTransportManager.beginShutdownPolls();
    const result = tool.handler(
      tool.schema.parse({
        device: {
          name: image.name,
          platform: "android",
          deviceId: image.deviceId!,
          transportId: "1",
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
      transportId: "1",
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

  test("bounds and aborts a hung platform shutdown command", async () => {
    const timer = new FakeTimer();
    const hungManager = new AbortAwareHungShutdownCommandDeviceManager();
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

    await expect(result).rejects.toThrow("platform shutdown command did not complete");
    expect(hungManager.commandWasAborted).toBe(true);
    expect(hungManager.commandOptions?.timeoutMs).toBe(30_000);
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
      transportId: "2",
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
        device: { ...image, transportId: "1" },
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
    const replacement: BootedDevice = {
      name: image.name,
      platform: "android",
      deviceId: image.deviceId!,
      transportId: "2",
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

    await expect(
      tool.handler(
        tool.schema.parse({
          device: {
            name: image.name,
            platform: "android",
            deviceId: image.deviceId!,
            transportId: "1",
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
      transportId: "2",
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
          device: { ...image, transportId: "1" },
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
      transportId: "2",
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
          transportId: "1",
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
      transportId: "2",
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
      stopAndroidObservers: async target => {
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
    await new Promise(resolve => setImmediate(resolve));
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
  test.skipIf(process.platform === "win32")("closes the registered Android CtrlProxy observer during teardown", async () => {
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
  });
});
