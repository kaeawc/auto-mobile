import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import type { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";

async function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true,
    });
  }
}

describe("DevicePool", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeDeviceManager: FakeDeviceManager;
  const createBootedDevice = (
    deviceId: string,
    platform: Platform = "android",
    name?: string,
    iosVersion?: string,
  ): BootedDevice => ({
    name: name ?? deviceId,
    platform,
    deviceId,
    iosVersion,
  });

  const initializeLiveDevices = async (devices: BootedDevice[]): Promise<void> => {
    fakeDeviceManager.bootedDevices = [...devices];
    await devicePool.initializeWithDevices(devices);
  };

  const configureAfterFirstSession = (configure: () => void): void => {
    const createSession = sessionManager.createSession.bind(sessionManager);
    let sessionCreates = 0;
    sessionManager.createSession = async (
      sessionId,
      deviceId,
      platform,
      timeoutMs,
      heartbeatTimeoutMs,
    ) => {
      const session = await createSession(
        sessionId,
        deviceId,
        platform,
        timeoutMs,
        heartbeatTimeoutMs,
      );
      sessionCreates++;
      if (sessionCreates === 1) {
        configure();
      }
      return session;
    };
  };

  const failIosLivenessAfterFirstSession = (): void => {
    configureAfterFirstSession(() => fakeDeviceManager.failedPlatforms.add("ios"));
  };

  class FakeDeviceManagerWithMinimalReadyDevice extends FakeDeviceManager {
    async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
      const id = device.deviceId ?? device.name;
      return {
        name: device.name,
        platform: device.platform,
        deviceId: id,
        source: device.source,
      };
    }
  }

  class CountingFakeDeviceManager extends FakeDeviceManager {
    detailedBootedCalls = 0;

    async getBootedDevicesDetailed(platform: "android" | "ios" | "either") {
      this.detailedBootedCalls++;
      return super.getBootedDevicesDetailed(platform);
    }
  }

  class DeferredDiscoveryFakeDeviceManager extends FakeDeviceManager {
    private readonly discoveryStartedPromise: Promise<void>;
    private readonly discoveryReleasePromise: Promise<void>;
    private resolveDiscoveryStarted!: () => void;
    private resolveDiscoveryRelease!: () => void;

    constructor() {
      super();
      this.discoveryStartedPromise = new Promise((resolve) => {
        this.resolveDiscoveryStarted = resolve;
      });
      this.discoveryReleasePromise = new Promise((resolve) => {
        this.resolveDiscoveryRelease = resolve;
      });
    }

    async getBootedDevicesDetailed(platform: SomePlatform) {
      this.resolveDiscoveryStarted();
      await this.discoveryReleasePromise;
      return await super.getBootedDevicesDetailed(platform);
    }

    async waitForDiscoveryStart(): Promise<void> {
      await this.discoveryStartedPromise;
    }

    releaseDiscovery(): void {
      this.resolveDiscoveryRelease();
    }
  }

  class ThrowingDiscoveryFakeDeviceManager extends FakeDeviceManager {
    override async getBootedDevicesDetailed(): Promise<never> {
      throw new Error("adb discovery crashed");
    }
  }

  class FakeChildProcess extends EventEmitter {
    pid = 12345;
    exitCode: number | null | undefined = undefined;
    signalCode: NodeJS.Signals | null | undefined = undefined;
    killCount = 0;
    kill(): boolean {
      this.killCount++;
      return true;
    }
  }

  class FakeDeviceManagerWithStartedProcess extends FakeDeviceManagerWithMinimalReadyDevice {
    readonly childProcess = new FakeChildProcess();

    async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<FakeChildProcess> {
      await super.startDevice(device, timeoutMs);
      return this.childProcess;
    }
  }

  class FakeDeviceManagerWithDistinctStartedProcesses extends FakeDeviceManager {
    readonly childProcesses: FakeChildProcess[] = [];

    async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<FakeChildProcess> {
      await super.startDevice(device, timeoutMs);
      this.bootedDevices = this.bootedDevices.map((booted) =>
        booted.deviceId === device.name ? { ...booted, deviceId: "emulator-5554" } : booted,
      );
      const childProcess = new FakeChildProcess();
      this.childProcesses.push(childProcess);
      return childProcess;
    }

    async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
      return {
        name: device.name,
        platform: device.platform,
        deviceId: "emulator-5554",
        source: device.source,
      };
    }
  }

  class FakeDeviceManagerWithExitedRecoveryProcess extends FakeDeviceManagerWithDistinctStartedProcesses {
    constructor(
      devices: DeviceInfo[],
      private readonly recoveryExitCode: number | null = 1,
      private readonly recoverySignalCode: NodeJS.Signals | null = null,
    ) {
      super(devices);
    }

    override async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<FakeChildProcess> {
      const childProcess = await super.startDevice(device, timeoutMs);
      if (this.childProcesses.length === 2) {
        childProcess.exitCode = this.recoveryExitCode;
        childProcess.signalCode = this.recoverySignalCode;
      }
      return childProcess;
    }
  }

  class FakeDeviceManagerWithExitedInitialProcess extends FakeDeviceManagerWithDistinctStartedProcesses {
    override async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<FakeChildProcess> {
      const childProcess = await super.startDevice(device, timeoutMs);
      if (this.childProcesses.length === 1) {
        childProcess.exitCode = 1;
        childProcess.signalCode = null;
      }
      return childProcess;
    }
  }

  class StubbornChildProcess extends EventEmitter {
    readonly pid = 12345;
    readonly exitCode = null;
    readonly signalCode = null;
    readonly signals: Array<NodeJS.Signals | number | undefined> = [];

    kill(signal?: NodeJS.Signals | number): boolean {
      this.signals.push(signal);
      return true;
    }
  }

  class FakeDeviceManagerWithStubbornProcess extends FakeDeviceManager {
    readonly childProcess = new StubbornChildProcess();

    override async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<ChildProcess> {
      await super.startDevice(device, timeoutMs);
      return this.childProcess as unknown as ChildProcess;
    }
  }

  class DeferredRecoveryDeviceManager extends FakeDeviceManager {
    readonly childProcesses: FakeChildProcess[] = [];
    private readonly recoveryStartedPromise: Promise<void>;
    private readonly recoveryReleasePromise: Promise<void>;
    private resolveRecoveryStarted!: () => void;
    private resolveRecoveryRelease!: () => void;

    constructor() {
      super();
      this.recoveryStartedPromise = new Promise((resolve) => {
        this.resolveRecoveryStarted = resolve;
      });
      this.recoveryReleasePromise = new Promise((resolve) => {
        this.resolveRecoveryRelease = resolve;
      });
    }

    override async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<FakeChildProcess> {
      if (this.childProcesses.length === 0) {
        await super.startDevice(device, timeoutMs);
      } else if (this.childProcesses.length === 1) {
        this.bootedDevices = [];
        this.resolveRecoveryStarted();
      }
      const childProcess =
        this.childProcesses.length === 1 ? this.createRecoveryChild() : new FakeChildProcess();
      this.childProcesses.push(childProcess);
      return childProcess;
    }

    protected createRecoveryChild(): FakeChildProcess {
      return new FakeChildProcess();
    }

    override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
      if (this.childProcesses.length === 2) {
        await this.recoveryReleasePromise;
      }
      const ready: BootedDevice = {
        name: device.name,
        platform: device.platform,
        deviceId: "emulator-5554",
        source: device.source,
      };
      this.bootedDevices = [ready];
      return ready;
    }

    override async isDeviceImageRunning(): Promise<boolean> {
      return false;
    }

    async waitForRecoveryStart(): Promise<void> {
      await this.recoveryStartedPromise;
    }

    releaseRecovery(): void {
      this.resolveRecoveryRelease();
    }
  }

  class StubbornRecoveryChildProcess extends FakeChildProcess {
    readonly signals: Array<NodeJS.Signals | number | undefined> = [];

    constructor() {
      super();
      this.exitCode = null;
      this.signalCode = null;
    }

    override kill(signal?: NodeJS.Signals | number): boolean {
      this.killCount++;
      this.signals.push(signal);
      return true;
    }
  }

  class DeferredRecoveryDeviceManagerWithStubbornChild extends DeferredRecoveryDeviceManager {
    readonly recoveryChild = new StubbornRecoveryChildProcess();

    protected override createRecoveryChild(): FakeChildProcess {
      return this.recoveryChild;
    }
  }

  class DeferredRecoveryDeviceManagerWithStubbornFailingReadiness extends DeferredRecoveryDeviceManagerWithStubbornChild {
    override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
      const ready = await super.waitForDeviceReady(device);
      if (this.childProcesses.length === 2) {
        throw new Error("recovery readiness rejected");
      }
      return ready;
    }
  }

  class DeferredLivenessRecoveryDeviceManager extends FakeDeviceManager {
    readonly childProcess = new FakeChildProcess();
    private readonly recoveryStartedPromise: Promise<void>;
    private readonly recoveryReleasePromise: Promise<void>;
    private resolveRecoveryStarted!: () => void;
    private resolveRecoveryRelease!: () => void;

    constructor(images: DeviceInfo[], booted: BootedDevice[]) {
      super(images, booted);
      this.recoveryStartedPromise = new Promise((resolve) => {
        this.resolveRecoveryStarted = resolve;
      });
      this.recoveryReleasePromise = new Promise((resolve) => {
        this.resolveRecoveryRelease = resolve;
      });
    }

    override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
      this.startedDevices.push(device);
      this.resolveRecoveryStarted();
      return this.childProcess as unknown as ChildProcess;
    }

    override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
      await this.recoveryReleasePromise;
      const ready = createBootedDevice("emulator-5554", "android", device.name);
      this.bootedDevices.push(ready);
      return ready;
    }

    async waitForRecoveryStart(): Promise<void> {
      await this.recoveryStartedPromise;
    }

    releaseRecovery(): void {
      this.resolveRecoveryRelease();
    }
  }

  // Hands back a spawned handle from startDevice, then fails readiness — used to
  // assert the pool cancels a hung boot via handle.kill() (issue #3952). Reuses
  // FakeChildProcess, adding only a kill counter.
  class KillTrackingChildProcess extends FakeChildProcess {
    killCount = 0;
    override kill(): boolean {
      this.killCount++;
      return true;
    }
  }

  class FakeDeviceManagerWithFailingReadiness extends FakeDeviceManager {
    readonly childProcess = new KillTrackingChildProcess();

    async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<ChildProcess> {
      await super.startDevice(device, timeoutMs);
      return this.childProcess as unknown as ChildProcess;
    }

    async waitForDeviceReady(): Promise<BootedDevice> {
      throw new Error("readiness timeout");
    }
  }

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    sessionManager = new SessionManager(fakeTimer);
    fakeAppsRepo = new FakeInstalledAppsRepository();
    fakeDeviceManager = new FakeDeviceManager();
    // Create a RetryExecutor that uses the fakeTimer so time advancement works correctly
    const retryExecutor = new DefaultRetryExecutor(fakeTimer);
    devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      fakeDeviceManager,
      retryExecutor,
    );
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  describe("initializeWithDevices", () => {
    test("should initialize with empty device list", async () => {
      await devicePool.initializeWithDevices([]);
      expect(devicePool.getTotalDeviceCount()).toBe(0);
      expect(devicePool.getAvailableDeviceCount()).toBe(0);
    });

    test("should initialize with single device", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      const device = devicePool.getDevice("emulator-5554");
      expect(device).not.toBeNull();
      expect(device?.status).toBe("idle");
      expect(device?.sessionId).toBeNull();
      expect(device?.assignmentCount).toBe(0);
      expect(device?.errorCount).toBe(0);
    });

    test("notifies the removal listener so a device session epoch is retired", async () => {
      const registry = new DeviceSessionRegistry(fakeTimer, new FakeIdGenerator(["uuid-a"]));
      const removedDeviceIds: string[] = [];
      let listenerObservedDeletedDevice = false;
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (deviceId) => {
          listenerObservedDeletedDevice = devicePool.getDevice(deviceId) === null;
          removedDeviceIds.push(deviceId);
          registry.onDeviceDisconnected(deviceId);
        },
      );
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const pooled = devicePool.getDevice("emulator-5554");
      if (!pooled) {
        throw new Error("expected pooled device");
      }
      const record = registry.onDeviceConnected({
        deviceId: pooled.id,
        platform: pooled.platform,
        incarnation: pooled.incarnation,
      });

      const removal = devicePool.removeDevice(pooled.id);

      expect(removedDeviceIds).toEqual([pooled.id]);
      expect(listenerObservedDeletedDevice).toBe(true);
      await removal;
      expect(registry.list()).toEqual([]);
      expect(registry.getByUuid(record.deviceSessionUuid)).toBeUndefined();
    });

    test("should initialize with multiple devices", async () => {
      const deviceIds = ["emulator-5554", "emulator-5556", "emulator-5558"];
      await devicePool.initializeWithDevices(deviceIds.map(createBootedDevice));
      expect(devicePool.getTotalDeviceCount()).toBe(3);
      expect(devicePool.getAvailableDeviceCount()).toBe(3);
      for (const deviceId of deviceIds) {
        const device = devicePool.getDevice(deviceId);
        expect(device).not.toBeNull();
        expect(device?.status).toBe("idle");
        expect(device?.sessionId).toBeNull();
      }
    });

    // Boundary row (PARAM-7): the pool is keyed by device id, so two devices
    // with the same id collapse to a single tracked entry rather than being
    // double-counted. Pins the de-dup invariant a duplicate-id feed depends on.
    test("collapses duplicate device ids to a single tracked device", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5554"),
      ]);
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
    });

    test("records the source AVD when a recovery boot races with pool refresh", async () => {
      const ready = createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)");
      const source: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await devicePool.initializeWithDevices([ready]);

      await devicePool.addDevice(ready, source);

      expect(devicePool.getDevice("emulator-5554")?.avdName).toBe("Pixel 8");
    });

    test("replaces stale AVD identity at a same-serial authoritative boot boundary", async () => {
      const ready = createBootedDevice("emulator-5554", "android", "Pixel");
      await devicePool.addDevice(ready, {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      });

      await devicePool.addDevice(ready, {
        name: "Pixel 9",
        platform: "android",
        isRunning: false,
        source: "local",
      });

      expect(devicePool.getDevice(ready.deviceId)?.avdName).toBe("Pixel 9");
    });

    test("an authoritative same-serial replacement clears an old intentional-stop marker", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel");
      try {
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          fakeDeviceManager,
          new DefaultRetryExecutor(fakeTimer),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { onLoss: true, maxAttempts: 2 },
        );
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        devicePool.markIntentionalShutdown(ready.deviceId);
        await devicePool.addDevice(ready, {
          name: "Pixel 9",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        fakeDeviceManager.bootedDevices = [];

        await devicePool.removeDisconnectedDevice(ready.deviceId, false);

        expect(fakeDeviceManager.startedDevices.map((device) => device.name)).toEqual(["Pixel 9"]);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("intentional shutdown remains a current disconnect for monitor cleanup", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const device = devicePool.getDevice("emulator-5554");
      if (!device) {
        throw new Error("expected pooled device");
      }
      devicePool.markIntentionalShutdown(device.id);

      expect(await devicePool.isCurrentDisconnectedDevice(device)).toBe("current");
    });

    test("does not accept a different AVD that reuses the disconnected emulator serial", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        const disconnected = devicePool.getDevice(ready.deviceId);
        if (!disconnected) {
          throw new Error("expected disconnected pooled device");
        }
        fakeDeviceManager.bootedDevices = [
          createBootedDevice("emulator-5554", "android", "Pixel 9"),
        ];

        expect(await devicePool.isCurrentDisconnectedDevice(disconnected)).toBe("current");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retains a same-serial Android emulator when its AVD name is unresolved", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          fakeDeviceManager,
          new DefaultRetryExecutor(fakeTimer),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { onLoss: true, maxAttempts: 2 },
        );
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        const disconnected = devicePool.getDevice(ready.deviceId);
        if (!disconnected) {
          throw new Error("expected disconnected pooled device");
        }
        fakeDeviceManager.bootedDevices = [
          createBootedDevice("emulator-5554", "android", "Unknown (emulator-5554)"),
        ];

        expect(await devicePool.isCurrentDisconnectedDevice(disconnected)).toBe("recovered");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("reports an unknown disconnect state when Android rediscovery discovery fails", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          fakeDeviceManager,
          new DefaultRetryExecutor(fakeTimer),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { onLoss: true, maxAttempts: 2 },
        );
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        const disconnected = devicePool.getDevice(ready.deviceId);
        if (!disconnected) {
          throw new Error("expected disconnected pooled device");
        }
        fakeDeviceManager.failedPlatforms = new Set(["android"]);

        expect(await devicePool.isCurrentDisconnectedDevice(disconnected)).toBe("unknown");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("stale disconnect validation rejects a same-serial replacement added during discovery", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const source: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      try {
        await devicePool.addDevice(ready, source);
        const original = devicePool.getDevice(ready.deviceId);
        if (!original) {
          throw new Error("expected original pooled device");
        }
        const validation = devicePool.isCurrentDisconnectedDevice(original);
        await manager.waitForDiscoveryStart();
        await devicePool.removeDevice(ready.deviceId);
        await devicePool.addDevice(ready, source);
        const replacement = devicePool.getDevice(ready.deviceId);

        manager.releaseDiscovery();

        expect(await validation).toBe("recovered");
        expect(devicePool.getDevice(ready.deviceId)).toBe(replacement);
      } finally {
        manager.releaseDiscovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("stale disconnect cleanup preserves a same-serial replacement added during discovery", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const source: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      try {
        await devicePool.addDevice(ready, source);
        const cleanup = devicePool.removeDisconnectedDevice(ready.deviceId);
        await manager.waitForDiscoveryStart();
        await devicePool.removeDevice(ready.deviceId);
        await devicePool.addDevice(ready, source);
        const replacement = devicePool.getDevice(ready.deviceId);

        manager.releaseDiscovery();
        await cleanup;

        expect(devicePool.getDevice(ready.deviceId)).toBe(replacement);
      } finally {
        manager.releaseDiscovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retains a recovery-owned emulator when detailed discovery throws", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new ThrowingDiscoveryFakeDeviceManager();
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      const ready = createBootedDevice("emulator-5554", "android", "Pixel 8");
      try {
        await devicePool.addDevice(ready, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });

        await devicePool.removeDisconnectedDevice(ready.deviceId);

        expect(devicePool.getDevice(ready.deviceId)).not.toBeNull();
        expect(manager.startedDevices).toHaveLength(0);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });
  });

  describe("intentional-shutdown marker incarnation scoping", () => {
    const androidImage = {
      name: "Pixel 8",
      platform: "android" as const,
      isRunning: false,
      source: "local" as const,
    };

    const withRebootOnDeath = async (run: () => Promise<void>): Promise<void> => {
      const original = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        await run();
      } finally {
        if (original === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = original;
        }
      }
    };

    test("a stale disconnect does not remove an intentionally-stopped device that is still booted", async () => {
      await withRebootOnDeath(async () => {
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          fakeDeviceManager,
          new DefaultRetryExecutor(fakeTimer),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { onLoss: true, maxAttempts: 2 },
        );
        await devicePool.addDevice(
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
          androidImage,
        );
        devicePool.markIntentionalShutdown("emulator-5554");
        // The serial is still booted — the kill has not taken effect yet, or a
        // same-serial device is already back. The disconnect signal is stale.
        fakeDeviceManager.bootedDevices = [
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
        ];

        await devicePool.removeDisconnectedDevice("emulator-5554", true);

        // Before the fix the marker was consumed before the rediscovery check, so
        // this live device would be removed.
        expect(devicePool.getDevice("emulator-5554")).not.toBeNull();

        // A genuine disconnect (the serial is truly gone) still honors the mark.
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554", true);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      });
    });

    test("does not remove a same-serial replacement that swaps in during the rediscovery await", async () => {
      await withRebootOnDeath(async () => {
        const deferred = new DeferredDiscoveryFakeDeviceManager();
        fakeDeviceManager = deferred;
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          deferred,
          new DefaultRetryExecutor(fakeTimer),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { onLoss: true, maxAttempts: 2 },
        );
        await devicePool.addDevice(
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
          androidImage,
        );
        devicePool.markIntentionalShutdown("emulator-5554");
        // Discovery will find nothing, so without a post-await identity re-check
        // the disconnect would fall through to consume + remove.
        deferred.bootedDevices = [];

        // Start the disconnect; it blocks inside the rediscovery discovery await.
        const disconnect = devicePool.removeDisconnectedDevice("emulator-5554", true);
        await deferred.waitForDiscoveryStart();

        // While the await is in flight, the marked incarnation leaves and a fresh
        // same-serial incarnation (with its own marker) takes its place.
        await devicePool.removeDevice("emulator-5554");
        await devicePool.addDevice(
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
          androidImage,
        );
        devicePool.markIntentionalShutdown("emulator-5554");
        const replacement = devicePool.getDevice("emulator-5554");
        if (!replacement) {
          throw new Error("expected replacement device");
        }

        deferred.releaseDiscovery();
        await disconnect;

        // The stale disconnect for the prior incarnation must not delete the live
        // replacement (nor consume its newly set marker).
        const afterDisconnect = devicePool.getDevice("emulator-5554");
        expect(afterDisconnect).not.toBeNull();
        expect(afterDisconnect!.incarnation).toBe(replacement.incarnation);
      });
    });

    test("assigns a fresh incarnation per pooled connection and keeps it across a reusing refresh", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554", "android", "Pixel 8")]);
      const first = devicePool.getDevice("emulator-5554");
      if (!first) {
        throw new Error("expected pooled device");
      }
      const firstIncarnation = first.incarnation;

      // A refresh that rediscovers the same serial reuses the entry — same
      // incarnation, so an existing mark for it still applies.
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(firstIncarnation);

      // Once the serial leaves and re-appears, it is a new connection and gets a
      // fresh incarnation, so a mark from the prior incarnation cannot match it.
      await devicePool.removeDevice("emulator-5554");
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];
      await devicePool.refreshDevices();
      const second = devicePool.getDevice("emulator-5554");
      expect(second).not.toBeNull();
      expect(second!.incarnation).toBeGreaterThan(firstIncarnation);
    });
  });

  describe("device-ready notifications", () => {
    test("notifies when a boot-ready device reuses an existing serial", async () => {
      const connectedDeviceIds: string[] = [];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        (deviceId) => connectedDeviceIds.push(deviceId),
      );
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);

      await devicePool.addDevice(createBootedDevice("emulator-5554"));

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
    });

    test("notifies when refresh rediscovers an existing serial", async () => {
      const connectedDeviceIds: string[] = [];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        (deviceId) => connectedDeviceIds.push(deviceId),
      );
      const device = createBootedDevice("emulator-5554");
      await devicePool.initializeWithDevices([device]);
      fakeDeviceManager.bootedDevices = [device];

      await devicePool.refreshDevices();

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
    });

    test("notifies before binding validates an existing serial", async () => {
      const connectedDeviceIds: string[] = [];
      const deferredDeviceManager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        deferredDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        (deviceId) => connectedDeviceIds.push(deviceId),
      );
      const device = createBootedDevice("emulator-5554");
      await devicePool.initializeWithDevices([device]);
      deferredDeviceManager.bootedDevices = [device];

      const binding = devicePool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android");
      await deferredDeviceManager.waitForDiscoveryStart();
      try {
        expect(connectedDeviceIds).toEqual(["emulator-5554"]);
      } finally {
        deferredDeviceManager.releaseDiscovery();
        await binding;
      }

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
    });

    test("notifies before autolock validates an existing serial", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const connectedDeviceIds: string[] = [];
      const deferredDeviceManager = new DeferredDiscoveryFakeDeviceManager();
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        deferredDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        (deviceId) => connectedDeviceIds.push(deviceId),
      );
      const device = createBootedDevice("emulator-5554");
      await devicePool.initializeWithDevices([device]);
      deferredDeviceManager.bootedDevices = [device];
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";

      try {
        const binding = devicePool.autolockDevice("emulator-5554", "android", "mcp-session-1");
        await deferredDeviceManager.waitForDiscoveryStart();
        try {
          expect(connectedDeviceIds).toEqual(["emulator-5554"]);
        } finally {
          deferredDeviceManager.releaseDiscovery();
          await binding;
        }
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }

      expect(connectedDeviceIds).toEqual(["emulator-5554"]);
    });
  });

  describe("refreshDevices", () => {
    test("does not query simctl during Linux Android-only refresh", async () => {
      await withProcessPlatform("linux", async () => {
        let simctlBootedCalls = 0;
        const androidDevice = createBootedDevice("emulator-5554", "android", "Pixel 8");
        const fakeSimctl = {
          isAvailable: async () => false,
          getBootedSimulators: async () => {
            simctlBootedCalls++;
            throw new Error("simctl should not be queried");
          },
          getBootedSimulatorsChecked: async () => {
            simctlBootedCalls++;
            throw new Error("simctl should not be queried");
          },
        } as unknown as SimCtlClient;
        const fakeEmulator = {
          getBootedDevices: async () => [androidDevice],
          getBootedDevicesChecked: async () => [androidDevice],
        } as unknown as AndroidEmulatorClient;
        const manager = new MultiPlatformDeviceManager(
          new FakeAdbClient() as unknown as AdbClient,
          fakeSimctl,
          fakeEmulator,
        );
        const pool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        const added = await pool.refreshDevices();

        expect(added).toBe(1);
        expect(pool.getDevice("emulator-5554")).not.toBeNull();
        expect(simctlBootedCalls).toBe(0);
      });
    });

    test("keeps Android devices when Linux iOS discovery fails after availability", async () => {
      await withProcessPlatform("linux", async () => {
        const androidDevice = createBootedDevice("emulator-5554", "android", "Pixel 8");
        const fakeSimctl = {
          isAvailable: async () => true,
          getBootedSimulators: async () => {
            throw new Error("simctl unavailable");
          },
          getBootedSimulatorsChecked: async () => {
            throw new Error("simctl unavailable");
          },
        } as unknown as SimCtlClient;
        const fakeEmulator = {
          getBootedDevices: async () => [androidDevice],
          getBootedDevicesChecked: async () => [androidDevice],
        } as unknown as AndroidEmulatorClient;
        const manager = new MultiPlatformDeviceManager(
          new FakeAdbClient() as unknown as AdbClient,
          fakeSimctl,
          fakeEmulator,
        );
        const pool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        const added = await pool.refreshDevices();

        expect(added).toBe(1);
        expect(pool.getDevice("emulator-5554")).not.toBeNull();
      });
    });

    test("removes unassigned devices that are no longer booted", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      await fakeAppsRepo.upsertInstalledApp("sim-old", 0, "com.test.app", false, Date.now());
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-new", "ios", "iPhone 16")];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getDevice("sim-new")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(1);
      expect(await fakeAppsRepo.listInstalledApps("sim-old")).toEqual([]);
    });

    test("keeps missing assigned devices until session cleanup releases them", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-old", "ios", "iPhone 15")];
      await devicePool.assignDeviceToSession("session-1", "ios");
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-new", "ios", "iPhone 16")];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(devicePool.getDevice("sim-old")?.sessionId).toBe("session-1");
      expect(devicePool.getDevice("sim-new")?.status).toBe("idle");
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("evicts an assigned stale identity before refreshing the same serial", async () => {
      const oldDevice = createBootedDevice("emulator-5554", "android", "Old Pixel");
      await devicePool.initializeWithDevices([oldDevice]);
      fakeDeviceManager.bootedDevices = [oldDevice];
      await devicePool.bindOrReuseDeviceSession("session-1", oldDevice.deviceId, "android");
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "New Pixel"),
      ];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        name: "New Pixel",
        platform: "android",
        sessionId: null,
        status: "idle",
      });
    });

    test("retains unassigned devices on first empty discovery", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(0);
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      expect(devicePool.getTotalDeviceCount()).toBe(1);
    });

    test("removes unassigned devices after repeated empty discovery misses", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      await devicePool.refreshDevices();
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("retains devices on first partial platform discovery miss", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];

      const added = await devicePool.refreshDevices();

      expect(added).toBe(1);
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("retains iOS devices across repeated refreshes when iOS discovery keeps failing", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      // Android discovery succeeds, but iOS discovery fails this and every refresh.
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];
      fakeDeviceManager.failedPlatforms = new Set<Platform>(["ios"]);

      // Even past the miss threshold, a device on a platform whose discovery
      // failed must never be pruned (it may still be running).
      await devicePool.refreshDevices();
      await devicePool.refreshDevices();
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("retains all devices when discovery fails for every platform", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
        createBootedDevice("sim-old", "ios", "iPhone 15"),
      ]);
      fakeDeviceManager.bootedDevices = [];
      fakeDeviceManager.failedPlatforms = new Set<Platform>(["android", "ios"]);

      await devicePool.refreshDevices();
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getDevice("sim-old")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("prunes iOS devices once iOS discovery succeeds and confirms them gone", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      // iOS discovery now succeeds but reports zero booted simulators.
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];
      fakeDeviceManager.failedPlatforms = new Set<Platform>();

      // Genuine empties are tolerated for one refresh, then removed.
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("sim-old")?.status).toBe("idle");
      await devicePool.refreshDevices();

      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(1);
    });

    test("recomputes candidates after refresh prunes all unavailable error devices", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-old", "ios", "iPhone 15")]);
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("sim-old");
      }
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5554", "android", "Pixel 8")];

      await devicePool.refreshDevices();
      await expect(devicePool.assignDeviceToSession("session-1", "ios")).rejects.toThrow(
        /No devices in pool/,
      );
      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getTotalDeviceCount()).toBe(1);
    });
  });

  describe("assignDeviceToSession", () => {
    test("should assign device to session when devices available", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-1");
      expect(deviceId).toBe("emulator-5554");
      const device = devicePool.getDevice("emulator-5554");
      expect(device?.sessionId).toBe("session-1");
      expect(device?.status).toBe("busy");
      expect(device?.assignmentCount).toBe(1);
      expect(device?.errorCount).toBe(0);
    });

    test("concurrent same-session creation converges on one assigned device", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      const [first, second] = await Promise.all([
        sessionManager.getOrCreateSession("shared-session", devicePool),
        sessionManager.getOrCreateSession("shared-session", devicePool),
      ]);

      expect(first.sessionId).toBe("shared-session");
      expect(second).toBe(first);
      expect(first.assignedDevice).toBe(second.assignedDevice);
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      expect(devicePool.getDevice(first.assignedDevice)?.status).toBe("busy");
    });

    test("does not reserve a second device when binding an automatically created session", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      const session = await sessionManager.getOrCreateSession("shared-session", devicePool);
      const otherDeviceId = session.assignedDevice === "emulator-5554"
        ? "emulator-5556"
        : "emulator-5554";

      await expect(
        devicePool.bindOrReuseDeviceSession("shared-session", otherDeviceId, "android"),
      ).rejects.toThrow(`Session 'shared-session' is already assigned to device '${session.assignedDevice}'.`);

      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      expect(devicePool.getDevice(otherDeviceId)).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("keeps an explicit binding as the sole owner during automatic creation", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      const explicitBinding = devicePool.bindOrReuseDeviceSession(
        "shared-session",
        "emulator-5556",
        "android",
      );
      const automaticCreation = sessionManager.getOrCreateSession("shared-session", devicePool);
      const [boundSession, session] = await Promise.all([explicitBinding, automaticCreation]);

      expect(boundSession).toBe("shared-session");
      expect(session.assignedDevice).toBe("emulator-5556");
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    });

    test("should throw error when no devices available after timeout", async () => {
      // Use manual mode so we can control time advancement

      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      await devicePool.assignDeviceToSession("session-1");

      // Start the second assignment (will wait for a device)
      let error: Error | null = null;
      const assignPromise = devicePool.assignDeviceToSession("session-2").catch((e) => {
        error = e as Error;
      });

      // Advance time past the 60 second timeout with multiple iterations
      // Each iteration advances time, resolves any pending sleeps, and yields
      for (let i = 0; i < 70; i++) {
        fakeTimer.advanceTime(1000); // Advance 1 second at a time
        await new Promise((resolve) => setImmediate(resolve));
        if (error) {
          break;
        }
      }

      await assignPromise;

      expect(error).not.toBeNull();
      expect(error!.message).toContain("Timed out waiting for device");
    });

    test("should wait and succeed when device becomes available", async () => {
      // Use manual mode so we can control time advancement

      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const device1 = await devicePool.assignDeviceToSession("session-1");

      // Start the second assignment (will wait for a device)
      const assignPromise = devicePool.assignDeviceToSession("session-2");

      // Advance time a few iterations
      for (let i = 0; i < 5; i++) {
        fakeTimer.advanceTime(1000);
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Release the device
      await devicePool.releaseDevice(device1, "session-1");

      // Advance time to allow the retry
      fakeTimer.advanceTime(1000);
      await new Promise((resolve) => setImmediate(resolve));

      // Now the assignment should succeed
      const device2 = await assignPromise;
      expect(device2).toBe("emulator-5554");
    });

    test("should assign different devices to different sessions", async () => {
      const deviceIds = ["emulator-5554", "emulator-5556"];
      await devicePool.initializeWithDevices(deviceIds.map(createBootedDevice));
      const device1 = await devicePool.assignDeviceToSession("session-1");
      const device2 = await devicePool.assignDeviceToSession("session-2");
      expect(device1).not.toBe(device2);
      expect(devicePool.getAvailableDeviceCount()).toBe(0);
    });

    test("should reuse device after session release", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const device1 = await devicePool.assignDeviceToSession("session-1");
      await devicePool.releaseDevice(device1, "session-1");
      const device2 = await devicePool.assignDeviceToSession("session-2");
      expect(device1).toBe(device2);
    });

    test("evicts a released iOS simulator that is no longer booted before reassignment", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-old", "ios", "iPhone 15"),
        createBootedDevice("sim-new", "ios", "iPhone 16"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("sim-old", "ios", "iPhone 15"),
        createBootedDevice("sim-new", "ios", "iPhone 16"),
      ];

      const firstDevice = await devicePool.assignDeviceToSession("session-1", "ios");
      expect(firstDevice).toBe("sim-old");
      await devicePool.releaseDevice(firstDevice, "session-1");
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-new", "ios", "iPhone 16")];

      const secondDevice = await devicePool.assignDeviceToSession("session-2", "ios");

      expect(secondDevice).toBe("sim-new");
      expect(devicePool.getDevice("sim-old")).toBeNull();
      expect(devicePool.getDevice("sim-new")?.sessionId).toBe("session-2");
    });

    test("does not assign but retains a pooled iOS simulator when liveness discovery fails", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];
      fakeDeviceManager.failedPlatforms = new Set<Platform>(["ios"]);

      await expect(devicePool.assignDeviceToSession("session-1", "ios")).rejects.toThrow(
        /Unable to verify iOS simulator liveness/,
      );

      expect(devicePool.getDevice("sim-1")?.status).toBe("idle");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("validates multiple idle iOS candidates with one liveness discovery snapshot", async () => {
      const countingDeviceManager = new CountingFakeDeviceManager(
        [],
        [createBootedDevice("sim-live", "ios", "iPhone 16")],
      );
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        countingDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-stale", "ios", "iPhone 15"),
        createBootedDevice("sim-live", "ios", "iPhone 16"),
      ]);

      const deviceId = await devicePool.assignDeviceToSession("session-1", "ios");

      expect(deviceId).toBe("sim-live");
      expect(devicePool.getDevice("sim-stale")).toBeNull();
      expect(countingDeviceManager.detailedBootedCalls).toBe(1);
    });

    test("evicts a stale idle Android emulator before assigning it", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      await expect(devicePool.assignDeviceToSession("session-1", "android")).rejects.toThrow(
        /No healthy android devices|No devices in pool/,
      );

      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("evicts stale idle Android emulator and assigns the next live candidate", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
        createBootedDevice("emulator-5556", "android", "Pixel 9"),
      ]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("emulator-5556", "android", "Pixel 9")];

      const deviceId = await devicePool.assignDeviceToSession("session-1", "android");

      expect(deviceId).toBe("emulator-5556");
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(devicePool.getDevice("emulator-5556")?.sessionId).toBe("session-1");
    });

    test("assigns an unrelated healthy emulator while stale-device recovery is pending", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const stale = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const healthy = createBootedDevice("emulator-5556", "android", "Pixel 9");
      const manager = new DeferredLivenessRecoveryDeviceManager(
        [{ name: "Pixel 8", platform: "android", isRunning: false, source: "local" }],
        [healthy],
      );
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.addDevice(stale, {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        });
        await devicePool.addDevice(healthy);

        await expect(devicePool.assignDeviceToSession("session-1", "android")).resolves.toBe(
          "emulator-5556",
        );
        await manager.waitForRecoveryStart();
        expect(manager.startedDevices).toHaveLength(1);
      } finally {
        manager.releaseRecovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("should bind a specific device to a session", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];

      const sessionId = await devicePool.bindOrReuseDeviceSession("session-1", "sim-1", "ios");

      expect(sessionId).toBe("session-1");
      const device = devicePool.getDevice("sim-1");
      expect(device?.sessionId).toBe("session-1");
      expect(device?.status).toBe("busy");
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("sim-1");
    });

    test("rejects a changed runtime identity inside the assignment mutex", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Old Pixel"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("emulator-5554", "android", "New Pixel"),
      ];

      await expect(
        devicePool.bindOrReuseDeviceSession(
          "session-1",
          "emulator-5554",
          "android",
          undefined,
          undefined,
          createBootedDevice("emulator-5554", "android", "New Pixel"),
        ),
      ).rejects.toThrow(/Device pool identity mismatch.*Old Pixel/);

      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("should reuse a live session when the device is already bound", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-1", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [createBootedDevice("sim-1", "ios", "iPhone 15")];
      await devicePool.bindOrReuseDeviceSession("session-1", "sim-1", "ios");

      const sessionId = await devicePool.bindOrReuseDeviceSession("session-2", "sim-1", "ios");

      expect(sessionId).toBe("session-1");
      expect(devicePool.getDevice("sim-1")?.sessionId).toBe("session-1");
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    test("rejects binding a stale idle iOS simulator that is no longer booted", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("sim-stale", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-stale", "sim-stale", "ios"),
      ).rejects.toThrow(/not available/);
      expect(devicePool.getDevice("sim-stale")).toBeNull();
      expect(sessionManager.getSession("session-stale")).toBeNull();
    });

    test("evicts a stale pooled Android emulator before direct binding", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android"),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("releases an active session when its Android emulator is stale before reuse", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554", "android", "Pixel 8")]);
      await devicePool.bindOrReuseDeviceSession("session-1", "emulator-5554", "android");
      fakeDeviceManager.bootedDevices = [];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-2", "emulator-5554", "android"),
      ).rejects.toThrow(/not available|shut down|disconnected/);

      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(sessionManager.getSession("session-2")).toBeNull();
    });

    test("evicts a stale pooled Android emulator before autolock", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      try {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await devicePool.initializeWithDevices([
          createBootedDevice("emulator-5554", "android", "Pixel 8"),
        ]);
        fakeDeviceManager.bootedDevices = [];

        await expect(
          devicePool.autolockDevice("emulator-5554", "android", "mcp-session-1"),
        ).rejects.toThrow(/not available|shut down|disconnected/);

        expect(devicePool.getDevice("emulator-5554")).toBeNull();
        expect(
          devicePool.resolveAutolockSessionForMcpSession("mcp-session-1", "android"),
        ).toBeUndefined();
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });
  });

  describe("assignMultipleDevices", () => {
    test("rolls back sessions and devices when platform allocation loses iOS liveness after a partial assignment", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);

      failIosLivenessAfterFirstSession();

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSession("session-b")).toBeNull();
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back sessions and devices when criteria allocation loses iOS liveness after a partial assignment", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);

      failIosLivenessAfterFirstSession();

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            { sessionId: "session-a", criteria: { platform: "ios" } },
            { sessionId: "session-b", criteria: { platform: "ios" } },
          ],
          1000,
        ),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSession("session-b")).toBeNull();
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back the completed assignment when platform allocation exhausts retries", async () => {
      await initializeLiveDevices([
        createBootedDevice("device-a"),
        createBootedDevice("device-b"),
      ]);
      configureAfterFirstSession(() => {
        const unavailable = devicePool.getDevice("device-b");
        if (!unavailable) {
          throw new Error("expected second pooled device");
        }
        unavailable.status = "busy";
      });

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "android"),
      ).rejects.toThrow(/Timed out allocating devices/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(devicePool.getDevice("device-a")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back the completed assignment when criteria allocation times out", async () => {
      await initializeLiveDevices([
        createBootedDevice("device-a"),
        createBootedDevice("device-b"),
      ]);
      configureAfterFirstSession(() => {
        const unavailable = devicePool.getDevice("device-b");
        if (!unavailable) {
          throw new Error("expected second pooled device");
        }
        unavailable.status = "busy";
        fakeTimer.advanceTime(1001);
      });

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            { sessionId: "session-a", criteria: { platform: "android" } },
            { sessionId: "session-b", criteria: { platform: "android" } },
          ],
          1000,
        ),
      ).rejects.toThrow(/Timed out allocating devices/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(devicePool.getDevice("device-a")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("rolls back the completed assignment when criteria allocation becomes non-retryable", async () => {
      await initializeLiveDevices([
        createBootedDevice("device-a"),
        createBootedDevice("device-b", "ios", "iPhone 16"),
      ]);
      configureAfterFirstSession(() => {
        const unavailable = devicePool.getDevice("device-b");
        if (!unavailable) {
          throw new Error("expected second pooled device");
        }
        unavailable.status = "error";
      });

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            { sessionId: "session-a", criteria: { platform: "android" } },
            { sessionId: "session-b", criteria: { platform: "ios" } },
          ],
          1000,
        ),
      ).rejects.toThrow(/Failed to allocate device for session session-b/);

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(devicePool.getDevice("device-a")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("evicts a started emulator when its process exits after readiness", async () => {
      const images: DeviceInfo[] = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const releaseCalls: Array<{ sessionId: string; deviceId: string; reason: string }> = [];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        async (sessionId, deviceId, reason) => {
          releaseCalls.push({ sessionId, deviceId, reason });
          await sessionManager.releaseSession(sessionId, reason);
        },
      );

      const assignments = await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
      expect(assignments.get("session-1")).toBe("emulator-5554");

      manager.childProcess.emit("exit", 0, null);
      await new Promise((resolve) => setImmediate(resolve));

      expect(releaseCalls).toEqual([
        {
          sessionId: "session-1",
          deviceId: "emulator-5554",
          reason: "device-disconnected:emulator-5554",
        },
      ]);
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("keeps criteria auto-start available after a process exit when recovery is disabled", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      const originalRebootOnDeathAlias = process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
      delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        manager.bootedDevices = [];
        manager.childProcess.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));

        await expect(
          devicePool.assignMultipleDevices(["session-2"], 1000, "android"),
        ).resolves.toEqual(new Map([["session-2", "emulator-5554"]]));
        expect(manager.startedDevices).toHaveLength(2);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
        if (originalRebootOnDeathAlias === undefined) {
          delete process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeathAlias;
        }
      }
    });

    test("reboots a disconnected pool-started Android emulator from its source AVD when enabled", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        manager.bootedDevices = [];

        manager.childProcess.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.startedDevices.map((device) => device.name)).toEqual(["Pixel 8", "Pixel 8"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
        expect(devicePool.getDevice("Pixel 8")?.avdName).toBe("Pixel 8");
        expect(sessionManager.getSession("session-1")).toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not recover an emulator intentionally shut down by the client", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        devicePool.markIntentionalShutdown("emulator-5554");
        manager.childProcess.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.startedDevices).toHaveLength(1);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("recovers an emulator after a failed intentional shutdown is cleared", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithStartedProcess(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        devicePool.markIntentionalShutdown("emulator-5554");
        devicePool.clearIntentionalShutdown("emulator-5554");
        manager.childProcess.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.startedDevices).toHaveLength(2);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("ignores an old emulator process exit after same-serial recovery", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithDistinctStartedProcesses(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554");
        await devicePool.assignMultipleDevices(["session-2"], 1000, "android");

        manager.childProcesses[0]!.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));

        expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-2");
        expect(sessionManager.getSession("session-2")).not.toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retries when a recovery process exited before tracking was attached", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithExitedRecoveryProcess(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));
        fakeTimer.resolveAll();
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.childProcesses).toHaveLength(3);
        expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("accepts a recovered replacement when the initial cold boot exited before tracking", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithExitedInitialProcess(images);
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await expect(
          devicePool.assignMultipleDevices(["session-1"], 1_000, "android"),
        ).resolves.toEqual(new Map([["session-1", "emulator-5554"]]));
        expect(manager.childProcesses).toHaveLength(2);
        expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("retries when a recovery process was killed by a signal before tracking", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      try {
        const images: DeviceInfo[] = [
          {
            name: "Pixel 8",
            platform: "android",
            isRunning: false,
            deviceId: "emulator-5554",
            source: "local",
          },
        ];
        const manager = new FakeDeviceManagerWithExitedRecoveryProcess(images, null, "SIGTERM");
        devicePool = new DevicePool(
          sessionManager,
          "test-daemon-session-id",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );

        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));
        fakeTimer.resolveAll();
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.childProcesses).toHaveLength(3);
        expect(devicePool.getDevice("emulator-5554")).not.toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not launch an AVD while recovery already owns its boot", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        {
          name: "pixel_8_api_35",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          deviceType: "Pixel 8",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        const allocation = devicePool.assignMultipleDevicesByCriteria(
          [
            {
              sessionId: "session-2",
              criteria: { platform: "android", simulatorType: "Pixel 8" },
            },
          ],
          3_000,
        );
        expect(manager.childProcesses).toHaveLength(2);
        manager.releaseRecovery();
        await new Promise((resolve) => setImmediate(resolve));
        fakeTimer.resolveAll();

        const assignments = await allocation;
        expect(assignments.get("session-2")).toBe("emulator-5554");
        expect(manager.childProcesses).toHaveLength(2);
      } finally {
        manager.releaseRecovery();
        await new Promise((resolve) => setImmediate(resolve));
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not defer incompatible criteria allocation for an unrelated recovering AVD", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        {
          name: "pixel_8_api_35",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          deviceType: "Pixel 8",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        await expect(
          devicePool.assignMultipleDevicesByCriteria(
            [
              {
                sessionId: "session-2",
                criteria: { platform: "android", simulatorType: "Pixel 9" },
              },
            ],
            3_000,
          ),
        ).rejects.toThrow(/No devices match criteria.*simulatorType=Pixel 9/);
        expect(manager.childProcesses).toHaveLength(2);
      } finally {
        manager.releaseRecovery();
        await new Promise((resolve) => setImmediate(resolve));
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not count one pending recovery as capacity for multiple devices", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        await expect(
          devicePool.assignMultipleDevices(["session-2", "session-3"], 3_000, "android"),
        ).rejects.toThrow("Not enough devices in pool: need 2, have 0");
        expect(manager.childProcesses).toHaveLength(2);
      } finally {
        manager.releaseRecovery();
        await new Promise((resolve) => setImmediate(resolve));
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("cancels an in-flight recovery after an intentional shutdown", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        manager.childProcesses[0]!.emit("exit", 1, null);
        await manager.waitForRecoveryStart();

        devicePool.markIntentionalShutdown("emulator-5554");
        manager.releaseRecovery();
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.childProcesses).toHaveLength(2);
        expect(manager.childProcesses[1]!.killCount).toBe(1);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        manager.releaseRecovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not re-terminate a recovery child that already exited by signal", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      fakeTimer.enableAutoAdvance();
      const manager = new DeferredRecoveryDeviceManager();
      manager.deviceImages = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");

        const recovery = devicePool.removeDisconnectedDevice("emulator-5554", false);
        await manager.waitForRecoveryStart();
        devicePool.markIntentionalShutdown("emulator-5554");
        const recoveryChild = manager.childProcesses[1]!;
        recoveryChild.exitCode = null;
        recoveryChild.signalCode = "SIGTERM";
        recoveryChild.emit("exit", null, "SIGTERM");
        manager.releaseRecovery();

        await expect(recovery).resolves.toBeUndefined();
        expect(recoveryChild.killCount).toBe(0);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        manager.releaseRecovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not retry recovery when cancelling the owned child fails", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      fakeTimer.enableAutoAdvance();
      const manager = new DeferredRecoveryDeviceManagerWithStubbornChild();
      manager.deviceImages = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");

        const recovery = devicePool.removeDisconnectedDevice("emulator-5554", false);
        await manager.waitForRecoveryStart();
        devicePool.markIntentionalShutdown("emulator-5554");
        manager.releaseRecovery();

        await expect(recovery).rejects.toThrow("did not exit after SIGKILL");
        expect(manager.childProcesses).toHaveLength(2);
        expect(manager.recoveryChild.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        manager.releaseRecovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("stops the owned child when cancellation coincides with readiness failure", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      fakeTimer.enableAutoAdvance();
      const manager = new DeferredRecoveryDeviceManagerWithStubbornFailingReadiness();
      manager.deviceImages = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");

        const recovery = devicePool.removeDisconnectedDevice("emulator-5554", false);
        await manager.waitForRecoveryStart();
        devicePool.markIntentionalShutdown("emulator-5554");
        manager.releaseRecovery();

        await expect(recovery).rejects.toThrow("did not exit after SIGKILL");
        expect(manager.childProcesses).toHaveLength(2);
        expect(manager.recoveryChild.signals).toEqual([undefined, "SIGTERM", "SIGKILL"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        manager.releaseRecovery();
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("does not relaunch an AVD while its old emulator process survives SIGKILL", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      fakeTimer.enableAutoAdvance();
      const manager = new FakeDeviceManagerWithStubbornProcess([
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ]);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];

        await devicePool.removeDisconnectedDevice("emulator-5554", false);

        expect(manager.startedDevices).toHaveLength(1);
        expect(manager.childProcess.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("same-serial rediscovery clears suppression for the authoritative AVD name", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const image: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      };
      const manager = new FakeDeviceManager([image]);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        undefined,
        { run: async () => false },
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554", false);

        await expect(
          devicePool.assignMultipleDevices(["session-suppressed"], 1_000, "android"),
        ).rejects.toThrow("Not enough devices in pool");
        expect(manager.startedDevices).toHaveLength(1);

        manager.bootedDevices = [
          {
            name: "Pixel 8",
            platform: "android",
            deviceId: "emulator-5554",
          },
        ];
        await devicePool.refreshDevices();
        await devicePool.removeDevice("emulator-5554");
        manager.bootedDevices = [];

        await expect(
          devicePool.assignMultipleDevices(["session-2"], 1_000, "android"),
        ).resolves.toEqual(new Map([["session-2", "emulator-5554"]]));
        expect(manager.startedDevices).toHaveLength(2);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("same-serial rediscovery keeps suppression for a different AVD", async () => {
      const originalRebootOnDeath = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
      const image: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      };
      const manager = new FakeDeviceManager([image]);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
        undefined,
        undefined,
        undefined,
        undefined,
        { run: async () => false },
      );
      try {
        await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
        await devicePool.releaseDevice("emulator-5554", "session-1");
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice("emulator-5554", false);

        manager.bootedDevices = [
          {
            name: "Pixel 9",
            platform: "android",
            deviceId: "emulator-5554",
          },
        ];
        await devicePool.refreshDevices();
        await devicePool.removeDevice("emulator-5554");
        manager.bootedDevices = [];

        await expect(
          devicePool.assignMultipleDevices(["session-2"], 1_000, "android"),
        ).rejects.toThrow("Not enough devices in pool");
        expect(manager.startedDevices).toHaveLength(1);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("cancels the boot (kills the spawned handle) when a pool cold-boot fails readiness", async () => {
      const images: DeviceInfo[] = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      const manager = new FakeDeviceManagerWithFailingReadiness(images);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );

      // No pre-booted devices: the pool must cold-boot one, readiness then fails.
      // Allocation cannot be satisfied (throws), but the half-booted device must
      // have been torn back down via handle.kill() (issue #3952).
      await expect(
        devicePool.assignMultipleDevices(["session-1"], 1000, "android"),
      ).rejects.toThrow();
      expect(manager.childProcess.killCount).toBe(1);
    });

    test("boots replacement emulator after stale pooled emulator is evicted before allocation", async () => {
      const images: DeviceInfo[] = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      const manager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);

      const assignments = await devicePool.assignMultipleDevices(["session-1"], 1000, "android");

      expect(assignments.get("session-1")).toBe("emulator-5554");
      expect(manager.startedDevices.map((device) => device.deviceId)).toEqual(["emulator-5554"]);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
    });

    test("boots criteria replacement emulator after stale matching pooled emulator is evicted", async () => {
      const images: DeviceInfo[] = [
        {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          deviceId: "emulator-5554",
          source: "local",
        },
      ];
      const manager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await devicePool.initializeWithDevices([
        createBootedDevice("emulator-5554", "android", "Pixel 8"),
      ]);

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [{ sessionId: "session-1", criteria: { platform: "android" } }],
        1000,
      );

      expect(assignments.get("session-1")).toBe("emulator-5554");
      expect(manager.startedDevices.map((device) => device.deviceId)).toEqual(["emulator-5554"]);
      expect(devicePool.getDevice("emulator-5554")?.sessionId).toBe("session-1");
    });

    test("should auto-start iOS simulators when pool is short", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Shutdown",
          isAvailable: true,
        },
        {
          name: "iPhone 15",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-2",
          state: "Shutdown",
          isAvailable: true,
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      const assignments = await devicePool.assignMultipleDevices(
        ["session-a", "session-b"],
        1000,
        "ios",
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(assignments.get("session-b")).toBe("sim-2");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-1",
        "sim-2",
      ]);
      expect(fakeDeviceManager.startDeviceTimeouts).toEqual([
        DEFAULT_DEVICE_READY_TIMEOUT_MS,
        DEFAULT_DEVICE_READY_TIMEOUT_MS,
      ]);
      expect(devicePool.getTotalDeviceCount()).toBe(2);
    });

    test("should boot a platform replacement when a stale pooled iOS simulator masked the shortage", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 16",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-replacement",
          state: "Shutdown",
          isAvailable: true,
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );
      await devicePool.initializeWithDevices([createBootedDevice("sim-stale", "ios", "iPhone 15")]);
      fakeDeviceManager.bootedDevices = [];

      const assignments = await devicePool.assignMultipleDevices(["session-a"], 1000, "ios");

      expect(assignments.get("session-a")).toBe("sim-replacement");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-replacement",
      ]);
      expect(devicePool.getDevice("sim-stale")).toBeNull();
    });

    test("should boot shutdown iOS simulator matching allocation criteria", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-wrong-type",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.5",
        },
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-wrong-version",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.4",
        },
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-unavailable",
          state: "Unavailable",
          isAvailable: false,
          iosVersion: "17.5",
        },
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManager(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual(["sim-1"]);
      expect(fakeDeviceManager.startDeviceTimeouts).toEqual([DEFAULT_DEVICE_READY_TIMEOUT_MS]);
      expect(devicePool.getDevice("sim-1")?.iosVersion).toBe("17.5");
    });

    test("should use osVersion as iOS criteria metadata after booting a shutdown simulator", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Shutdown",
          isAvailable: true,
          osVersion: "17.5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(devicePool.getDevice("sim-1")?.iosVersion).toBe("17.5");
    });

    test("should use runtime as iOS criteria metadata after booting a shutdown simulator", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Shutdown",
          isAvailable: true,
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(devicePool.getDevice("sim-1")?.iosVersion).toBe("17.5");
    });

    test("should preserve deviceType matching metadata after booting a custom-named simulator", async () => {
      const images: DeviceInfo[] = [
        {
          name: "QA Phone",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.5",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(devicePool.getDevice("sim-1")?.name).toBe("QA Phone");
      expect(devicePool.getDevice("sim-1")?.simulatorType).toBe("iPhone 15 Pro");
    });

    test("should boot replacement simulator when matching pooled simulator is in error", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-replacement",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-failed", "ios", "iPhone 15 Pro", "17.5"),
      ]);
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("sim-failed");
      }

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-replacement");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-replacement",
      ]);
      expect(devicePool.getDevice("sim-failed")?.status).toBe("error");
    });

    test("should boot a criteria replacement when a stale pooled iOS simulator matched first", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-replacement",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-stale", "ios", "iPhone 15 Pro", "17.5"),
      ]);
      fakeDeviceManager.bootedDevices = [];

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-replacement");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual([
        "sim-replacement",
      ]);
      expect(devicePool.getDevice("sim-stale")).toBeNull();
    });

    test("should recover errored pooled simulator when its own image is rebooted", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Shutdown",
          isAvailable: true,
          iosVersion: "17.5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManagerWithMinimalReadyDevice(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15 Pro", "17.5"),
      ]);
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("sim-1");
      }
      expect(devicePool.getDevice("sim-1")?.status).toBe("error");

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
      expect(fakeDeviceManager.startedDevices.map((device) => device.deviceId)).toEqual(["sim-1"]);
      expect(devicePool.getDevice("sim-1")?.status).toBe("busy");
      expect(devicePool.getDevice("sim-1")?.errorCount).toBe(0);
    });

    test("should fail criteria allocation without starting unavailable iOS simulators", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-unavailable",
          state: "Unavailable",
          isAvailable: false,
          iosVersion: "17.5",
        },
      ];
      const fakeDeviceManager = new FakeDeviceManager(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      await expect(
        devicePool.assignMultipleDevicesByCriteria(
          [
            {
              sessionId: "session-a",
              criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
            },
          ],
          1000,
        ),
      ).rejects.toThrow(/No devices match criteria/);
      expect(fakeDeviceManager.startedDevices).toHaveLength(0);
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("should fail iOS platform allocation without starting unavailable simulators", async () => {
      const images: DeviceInfo[] = [
        {
          name: "iPhone 15 Pro",
          platform: "ios",
          isRunning: false,
          deviceId: "sim-1",
          state: "Unavailable",
          isAvailable: false,
        },
      ];
      const fakeDeviceManager = new FakeDeviceManager(images);
      const retryExecutor = new DefaultRetryExecutor(fakeTimer);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        retryExecutor,
      );

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Not enough devices in pool/);
      expect(fakeDeviceManager.startedDevices).toHaveLength(0);
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("should assign iOS simulators by criteria", async () => {
      await devicePool.initializeWithDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15 Pro", "17.5"),
        createBootedDevice("sim-2", "ios", "iPhone 15", "17.4"),
      ]);
      fakeDeviceManager.bootedDevices = [
        createBootedDevice("sim-1", "ios", "iPhone 15 Pro", "17.5"),
        createBootedDevice("sim-2", "ios", "iPhone 15", "17.4"),
      ];

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-a",
            criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-a")).toBe("sim-1");
    });

    test("should prefer the least-recently-used idle device for criteria allocation", async () => {
      // Regression test for LRU drift between tryAssignDevice and
      // tryAssignDeviceWithCriteria (issue #2656). Criteria-based allocation
      // must distribute load to the least-recently-used idle device, the same
      // way platform-based allocation does.
      await devicePool.initializeWithDevices([
        createBootedDevice("dev-a", "android"),
        createBootedDevice("dev-b", "android"),
        createBootedDevice("dev-c", "android"),
      ]);

      // Touch devices in reverse insertion order so lastUsedAt ordering
      // (c < b < a) differs from map insertion order (a, b, c).
      await devicePool.bindOrReuseDeviceSession("seed-c", "dev-c", "android");
      await devicePool.bindOrReuseDeviceSession("seed-b", "dev-b", "android");
      await devicePool.bindOrReuseDeviceSession("seed-a", "dev-a", "android");

      await devicePool.releaseDevice("dev-a", "seed-a");
      await devicePool.releaseDevice("dev-b", "seed-b");
      await devicePool.releaseDevice("dev-c", "seed-c");

      // Re-bind dev-c so it is busy (and remains the lastReleasedDeviceId,
      // which should be ignored because it is no longer idle). Idle pool is
      // now {dev-a, dev-b}; insertion order would yield dev-a, but dev-b is
      // less recently used and must win.
      await devicePool.bindOrReuseDeviceSession("seed-c2", "dev-c", "android");

      const assignments = await devicePool.assignMultipleDevicesByCriteria(
        [
          {
            sessionId: "session-lru",
            criteria: { platform: "android" },
          },
        ],
        1000,
      );

      expect(assignments.get("session-lru")).toBe("dev-b");
    });
  });

  describe("releaseDevice", () => {
    test("does not release a replacement allocation when an expected session no longer owns the device", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-a");

      await sessionManager.releaseSession("session-a");
      await devicePool.releaseDevice(deviceId);
      await devicePool.assignDeviceToSession("session-b");

      await devicePool.releaseDevice(deviceId, "session-a");

      expect(sessionManager.getSession("session-b")?.assignedDevice).toBe(deviceId);
      expect(devicePool.getDevice(deviceId)).toMatchObject({
        sessionId: "session-b",
        status: "busy",
      });
    });

    test("should release device assigned to session", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-1");
      await devicePool.releaseDevice(deviceId, "session-1");
      const device = devicePool.getDevice(deviceId);
      expect(device?.sessionId).toBeNull();
      expect(device?.status).toBe("idle");
      expect(devicePool.getAvailableDeviceCount()).toBe(1);
    });

    test("keeps repeated release idempotent", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      await devicePool.assignDeviceToSession("session-1");
      await devicePool.releaseDevice("emulator-5554", "session-1");
      await devicePool.releaseDevice("emulator-5554", "session-1");
      const device = devicePool.getDevice("emulator-5554");
      expect(device?.status).toBe("idle");
    });

    test("should handle release of non-existent device", async () => {
      await devicePool.releaseDevice("non-existent", "session-1");
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });

    test("does not release a replacement session after a duplicate stale release", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const deviceId = await devicePool.assignDeviceToSession("session-s");

      await devicePool.releaseDevice(deviceId, "session-s");
      await devicePool.assignDeviceToSession("session-t");
      await devicePool.releaseDevice(deviceId, "session-s");

      const device = devicePool.getDevice(deviceId);
      expect(device?.sessionId).toBe("session-t");
      expect(device?.status).toBe("busy");
      expect(devicePool.getAvailableDeviceCount()).toBe(0);
    });
  });

  describe("error tracking", () => {
    test("should record device error and increment error count", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const device = devicePool.getDevice("emulator-5554");
      expect(device?.errorCount).toBe(0);
      devicePool.recordDeviceError("emulator-5554");
      expect(device?.errorCount).toBe(1);
      expect(device?.status).toBe("idle");
    });

    test("should mark device as error after max consecutive errors", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
      const device = devicePool.getDevice("emulator-5554");
      // Record 5 errors to reach MAX_DEVICE_ERRORS (5)
      for (let i = 0; i < 5; i++) {
        devicePool.recordDeviceError("emulator-5554");
      }
      expect(device?.errorCount).toBe(5);
      expect(device?.status).toBe("error");
    });

    test("should clear error count when device assignment succeeds", async () => {
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      devicePool.recordDeviceError("emulator-5554");
      expect(devicePool.getDevice("emulator-5554")?.errorCount).toBe(1);
      await devicePool.releaseDevice("emulator-5554", "session-1");
      await devicePool.assignDeviceToSession("session-1");
      expect(devicePool.getDevice("emulator-5554")?.errorCount).toBe(0);
    });

    test("should handle error recording for non-existent device", async () => {
      devicePool.recordDeviceError("non-existent");
      expect(devicePool.getTotalDeviceCount()).toBe(0);
    });
  });

  describe("statistics", () => {
    test("should return correct pool statistics", async () => {
      const deviceIds = ["emulator-5554", "emulator-5556", "emulator-5558"];
      await devicePool.initializeWithDevices(deviceIds.map(createBootedDevice));

      // Assign all 3 devices
      await devicePool.assignDeviceToSession("session-1");
      await devicePool.assignDeviceToSession("session-2");
      await devicePool.assignDeviceToSession("session-3");

      const stats = devicePool.getStats();
      expect(stats.total).toBe(3);
      expect(stats.idle).toBe(0);
      expect(stats.assigned).toBe(3);
      expect(stats.error).toBe(0);
    });
  });

  describe("session tracking", () => {
    test("should clear cache when device is removed", async () => {
      await devicePool.initializeWithDevices([createBootedDevice("emulator-5554")]);

      // Add some fake cache data
      await fakeAppsRepo.upsertInstalledApp("emulator-5554", 0, "com.test.app", false, Date.now());
      const appsBefore = await fakeAppsRepo.listInstalledApps("emulator-5554");
      expect(appsBefore.length).toBe(1);

      // Remove device should clear cache
      await devicePool.removeDevice("emulator-5554");
      const appsAfter = await fakeAppsRepo.listInstalledApps("emulator-5554");
      expect(appsAfter.length).toBe(0);
    });
  });
});
