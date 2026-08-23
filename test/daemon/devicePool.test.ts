import { afterEach, describe, expect, test, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { DeviceSessionPersistence } from "../../src/db/deviceSessionRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import type { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { getAbortSignal } from "../../src/utils/AbortContext";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossIncidentStore,
} from "../../src/daemon/emulatorLossIncident";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

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

  class TransportAwareFakeDeviceManager extends FakeDeviceManager {
    discoveryOptions: Array<{ bypassAndroidDeviceListCache?: boolean } | undefined> = [];

    override async getBootedDevicesDetailed(
      platform: SomePlatform,
      options?: { bypassAndroidDeviceListCache?: boolean },
    ) {
      this.discoveryOptions.push(options);
      return await super.getBootedDevicesDetailed(platform);
    }
  }

  class OutOfOrderRefreshFakeDeviceManager extends FakeDeviceManager {
    private readonly firstDiscoveryStartedPromise: Promise<void>;
    private readonly firstDiscoveryReleasePromise: Promise<void>;
    private resolveFirstDiscoveryStarted!: () => void;
    private resolveFirstDiscoveryRelease!: () => void;
    private discoveryCount = 0;

    constructor(
      private readonly firstSnapshot: BootedDevice[],
      private readonly secondSnapshot: BootedDevice[],
    ) {
      super();
      this.firstDiscoveryStartedPromise = new Promise((resolve) => {
        this.resolveFirstDiscoveryStarted = resolve;
      });
      this.firstDiscoveryReleasePromise = new Promise((resolve) => {
        this.resolveFirstDiscoveryRelease = resolve;
      });
    }

    override async getBootedDevicesDetailed(platform: SomePlatform) {
      this.discoveryCount++;
      if (this.discoveryCount === 1) {
        this.resolveFirstDiscoveryStarted();
        await this.firstDiscoveryReleasePromise;
        this.bootedDevices = this.firstSnapshot;
      } else {
        this.bootedDevices = this.secondSnapshot;
      }
      return await super.getBootedDevicesDetailed(platform);
    }

    async waitForFirstDiscoveryStart(): Promise<void> {
      await this.firstDiscoveryStartedPromise;
    }

    releaseFirstDiscovery(): void {
      this.resolveFirstDiscoveryRelease();
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

  class DeferredSessionTrackingAppsRepository extends FakeInstalledAppsRepository {
    private deferTracking = false;
    private resolveDeferredTracking: (() => void) | undefined;

    deferNextTrackingWrite(): void {
      this.deferTracking = true;
    }

    finishDeferredTrackingWrite(): void {
      this.resolveDeferredTracking?.();
    }

    override async setSessionTracking(
      daemonSessionId: string,
      deviceId: string,
      deviceSessionStart: number,
    ): Promise<void> {
      if (this.deferTracking) {
        this.deferTracking = false;
        await new Promise<void>(resolve => {
          this.resolveDeferredTracking = resolve;
        });
      }
      await super.setSessionTracking(daemonSessionId, deviceId, deviceSessionStart);
    }
  }

  class DeferredReconnectionDiscoveryFakeDeviceManager extends FakeDeviceManager {
    private readonly discoveryStartedPromise: Promise<void>;
    private readonly discoveryReleasePromise: Promise<void>;
    private resolveDiscoveryStarted!: () => void;
    private resolveDiscoveryRelease!: () => void;
    private discoveryCount = 0;

    constructor(
      private readonly delayedSnapshot: BootedDevice[],
      private readonly concurrentSnapshot: BootedDevice[],
    ) {
      super();
      this.discoveryStartedPromise = new Promise((resolve) => {
        this.resolveDiscoveryStarted = resolve;
      });
      this.discoveryReleasePromise = new Promise((resolve) => {
        this.resolveDiscoveryRelease = resolve;
      });
    }

    override async getBootedDevicesDetailed(platform: SomePlatform) {
      this.discoveryCount++;
      if (this.discoveryCount === 1) {
        this.resolveDiscoveryStarted();
        await this.discoveryReleasePromise;
        return this.discoveryFor(this.delayedSnapshot, platform);
      }
      return this.discoveryFor(this.concurrentSnapshot, platform);
    }

    async waitForDiscoveryStart(): Promise<void> {
      await this.discoveryStartedPromise;
    }

    releaseDiscovery(): void {
      this.resolveDiscoveryRelease();
    }

    private discoveryFor(devices: BootedDevice[], platform: SomePlatform) {
      const platforms: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
      return {
        devices: devices.filter((device) => platforms.includes(device.platform)),
        succeededPlatforms: new Set(platforms),
      };
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

  class DeferredDeviceSessionPersistence implements DeviceSessionPersistence {
    private writeStarted = Promise.withResolvers<void>();
    private writeFinished = Promise.withResolvers<void>();
    private deferWrite = true;

    deferNextUpsert(): void {
      this.writeStarted = Promise.withResolvers<void>();
      this.writeFinished = Promise.withResolvers<void>();
      this.deferWrite = true;
    }

    async waitForUpsert(): Promise<void> {
      await this.writeStarted.promise;
    }

    finishUpsert(): void {
      this.writeFinished.resolve();
    }

    async upsertActiveSession(): Promise<void> {
      if (!this.deferWrite) {
        return;
      }
      this.deferWrite = false;
      this.writeStarted.resolve();
      await this.writeFinished.promise;
    }

    async recordActivity(): Promise<void> {}

    async markReleased(): Promise<void> {}
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

  class FakeDeviceManagerWithFailingRecoveryStart extends FakeDeviceManagerWithDistinctStartedProcesses {
    override async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<FakeChildProcess> {
      if (this.childProcesses.length > 0) {
        throw new Error("recovery spawn failed");
      }
      return await super.startDevice(device, timeoutMs);
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

  class FakeDeviceManagerWithPendingReadiness extends FakeDeviceManager {
    readonly childProcess = new KillTrackingChildProcess();

    override async startDevice(
      device: DeviceInfo,
      timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
    ): Promise<ChildProcess> {
      await super.startDevice(device, timeoutMs);
      return this.childProcess as unknown as ChildProcess;
    }

    override async waitForDeviceReady(
      _device: DeviceInfo,
      _timeoutMs?: number,
      _childProcess?: ChildProcess | null,
      _signal?: AbortSignal,
    ): Promise<BootedDevice> {
      return await new Promise<BootedDevice>(() => {});
    }
  }

  class FakeDeviceManagerWithPendingStart extends FakeDeviceManager {
    startObservedAbort = false;

    override async startDevice(): Promise<ChildProcess> {
      const signal = getAbortSignal();
      return await new Promise<ChildProcess>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            this.startObservedAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
  }

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
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

    test("does not remove a same-serial device added after an absent disconnect capture", async () => {
      const device = createBootedDevice("emulator-5554");

      const disconnect = devicePool.removeDisconnectedDevice(device.deviceId);
      await devicePool.initializeWithDevices([device]);
      const replacement = devicePool.getDevice(device.deviceId);
      await disconnect;

      expect(devicePool.getDevice(device.deviceId)).toBe(replacement);
    });

    test("does not release a same-UUID replacement assignment after session persistence", async () => {
      const device = createBootedDevice("emulator-5554");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform);
      const originalAssignmentCount = devicePool.getDevice(device.deviceId)?.assignmentCount;

      await sessionManager.releaseSession("session-1");
      await devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform);
      const replacement = devicePool.getDevice(device.deviceId);
      expect(replacement?.assignmentCount).toBe((originalAssignmentCount ?? 0) + 1);

      await devicePool.releaseDevice(device.deviceId, "session-1");

      expect(devicePool.getDevice(device.deviceId)).toBe(replacement);
      expect(replacement).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
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

    test("assigns a fresh incarnation per pooled connection and keeps it across a same-transport refresh", async () => {
      const device = { ...createBootedDevice("emulator-5554", "android", "Pixel 8"), transportId: "1" };
      await initializeLiveDevices([device]);
      const first = devicePool.getDevice("emulator-5554");
      if (!first) {
        throw new Error("expected pooled device");
      }
      const firstIncarnation = first.incarnation;

      // A refresh that rediscovers the same serial and transport reuses the
      // entry — same incarnation, so an existing mark for it still applies.
      await devicePool.refreshDevices();
      expect(devicePool.getDevice("emulator-5554")?.incarnation).toBe(firstIncarnation);

      // Once the serial leaves and re-appears, it is a new connection and gets a
      // fresh incarnation, so a mark from the prior incarnation cannot match it.
      await devicePool.removeDevice("emulator-5554");
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.refreshDevices();
      const second = devicePool.getDevice("emulator-5554");
      expect(second).not.toBeNull();
      expect(second!.incarnation).toBeGreaterThan(firstIncarnation);
    });

    test("replaces a fast same-serial transport reconnect with a new device session epoch", async () => {
      const registry = new DeviceSessionRegistry(fakeTimer, new FakeIdGenerator(["uuid-a", "uuid-b"]));
      const transportAwareDeviceManager = new TransportAwareFakeDeviceManager();
      fakeDeviceManager = transportAwareDeviceManager;
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
        (deviceId) => {
          const pooled = devicePool.getDevice(deviceId);
          if (pooled) {
            registry.onDeviceConnected({
              deviceId: pooled.id,
              platform: pooled.platform,
              incarnation: pooled.incarnation,
            });
          }
        },
        undefined,
        undefined,
        deviceId => registry.onDeviceDisconnected(deviceId),
      );
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      await initializeLiveDevices([firstConnection]);
      devicePool.notifyDeviceReady(firstConnection.deviceId);
      const firstEpoch = registry.getByDeviceId(firstConnection.deviceId);
      const firstIncarnation = devicePool.getDevice(firstConnection.deviceId)?.incarnation;
      if (!firstEpoch || firstIncarnation === undefined) {
        throw new Error("expected the first pooled connection epoch");
      }

      fakeDeviceManager.bootedDevices = [reconnected];

      const added = await devicePool.refreshDevices();

      const secondEpoch = registry.getByDeviceId(reconnected.deviceId);
      expect(added).toBe(1);
      expect(devicePool.getDevice(reconnected.deviceId)?.incarnation).toBeGreaterThan(firstIncarnation);
      expect(secondEpoch?.deviceSessionUuid).toBe("uuid-b");
      expect(secondEpoch?.deviceSessionUuid).not.toBe(firstEpoch.deviceSessionUuid);
      expect(registry.getByUuid(firstEpoch.deviceSessionUuid)).toBeUndefined();
      expect(transportAwareDeviceManager.discoveryOptions).toEqual([{ bypassAndroidDeviceListCache: true }]);
    });

    test("rekeys a same-serial transport reconnect before assigning an idle device", async () => {
      const registry = new DeviceSessionRegistry(fakeTimer, new FakeIdGenerator(["uuid-a", "uuid-b"]));
      fakeDeviceManager = new TransportAwareFakeDeviceManager();
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
        (deviceId) => {
          const pooled = devicePool.getDevice(deviceId);
          if (pooled) {
            registry.onDeviceConnected({
              deviceId: pooled.id,
              platform: pooled.platform,
              incarnation: pooled.incarnation,
            });
          }
        },
        undefined,
        undefined,
        (deviceId) => registry.onDeviceDisconnected(deviceId),
      );
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      await initializeLiveDevices([firstConnection]);
      devicePool.notifyDeviceReady(firstConnection.deviceId);
      const firstEpoch = registry.getByDeviceId(firstConnection.deviceId);
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(devicePool.assignDeviceToSession("session-1", "android")).resolves.toBe(
        reconnected.deviceId,
      );

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        transportId: "2",
        sessionId: "session-1",
      });
      expect(registry.getByDeviceId(reconnected.deviceId)?.deviceSessionUuid).toBe("uuid-b");
      expect(registry.getByUuid(firstEpoch!.deviceSessionUuid)).toBeUndefined();
    });

    test("discards an older refresh snapshot after a newer transport replacement", async () => {
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      const outOfOrderManager = new OutOfOrderRefreshFakeDeviceManager(
        [firstConnection],
        [reconnected],
      );
      fakeDeviceManager = outOfOrderManager;
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await initializeLiveDevices([firstConnection]);

      const olderRefresh = devicePool.refreshDevices();
      await outOfOrderManager.waitForFirstDiscoveryStart();
      await devicePool.refreshDevices();
      outOfOrderManager.releaseFirstDiscovery();
      await olderRefresh;

      expect(devicePool.getDevice(reconnected.deviceId)?.transportId).toBe("2");
    });

    test("preserves AutoMobile-owned emulator metadata across a transport rekey", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      await devicePool.addDevice(firstConnection, sourceImage);
      fakeDeviceManager.bootedDevices = [reconnected];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        transportId: "2",
        avdName: "Pixel 8",
        androidImage: sourceImage,
      });
    });

    test("does not transfer AutoMobile-owned metadata to a different AVD with the same serial", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const replacement = {
        ...firstConnection,
        name: "Pixel 9",
        transportId: "2",
      };
      await devicePool.addDevice(firstConnection, sourceImage);
      fakeDeviceManager.bootedDevices = [replacement];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
        name: "Pixel 9",
        transportId: "2",
      });
      expect(devicePool.getDevice(replacement.deviceId)?.androidImage).toBeUndefined();
      expect(devicePool.getDevice(replacement.deviceId)?.avdName).toBeUndefined();
    });

    test("keeps AutoMobile-owned metadata when emulator name discovery is unknown", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const rediscoveredWithUnknownName = {
        ...firstConnection,
        name: "Unknown (emulator-5554)",
        transportId: "2",
      };
      await devicePool.addDevice(firstConnection, sourceImage);
      fakeDeviceManager.bootedDevices = [rediscoveredWithUnknownName];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(firstConnection.deviceId)).toMatchObject({
        name: "Unknown (emulator-5554)",
        transportId: "2",
        androidImage: sourceImage,
        avdName: "Pixel 8",
      });
    });

    test("does not transfer ownership from an unknown-name emulator to a different known AVD", async () => {
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const rediscoveredWithUnknownName = {
        ...firstConnection,
        name: "Unknown (emulator-5554)",
        transportId: "2",
      };
      const differentAvd = {
        ...firstConnection,
        name: "Pixel 9",
        transportId: "3",
      };
      await devicePool.addDevice(firstConnection, sourceImage);
      fakeDeviceManager.bootedDevices = [rediscoveredWithUnknownName];
      await devicePool.refreshDevices();
      fakeDeviceManager.bootedDevices = [differentAvd];

      await devicePool.refreshDevices();

      expect(devicePool.getDevice(differentAvd.deviceId)).toMatchObject({
        name: "Pixel 9",
        transportId: "3",
      });
      expect(devicePool.getDevice(differentAvd.deviceId)?.androidImage).toBeUndefined();
      expect(devicePool.getDevice(differentAvd.deviceId)?.avdName).toBeUndefined();
    });

    test("rekeys a transport-only mismatch before reserving startDevice readiness", async () => {
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      await initializeLiveDevices([firstConnection]);

      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        reconnected.deviceId,
        reconnected,
      );

      expect(devicePool.getDevice(reconnected.deviceId)?.transportId).toBe("2");
      await releaseReservation();
    });

    test("rekeys a non-emulator Android transport reconnect before allocation", async () => {
      const firstConnection = {
        ...createBootedDevice("R5CT123456", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      await initializeLiveDevices([firstConnection]);
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(devicePool.assignDeviceToSession("session-usb", "android")).resolves.toBe(
        reconnected.deviceId,
      );

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        transportId: "2",
        sessionId: "session-usb",
      });
    });

    test("does not hide same-model physical Android devices behind an AVD reservation", async () => {
      const firstPhone = createBootedDevice("R5CT123456", "android", "Pixel 8");
      const secondPhone = createBootedDevice("R5CT654321", "android", "Pixel 8");
      await initializeLiveDevices([firstPhone, secondPhone]);
      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        firstPhone.deviceId,
        firstPhone,
        "Pixel 8",
        "Pixel 8",
      );

      try {
        await expect(
          devicePool.assignDeviceToSession("second-phone-session", "android"),
        ).resolves.toBe(secondPhone.deviceId);
      } finally {
        await releaseReservation();
      }
    });

    test("reserves a verified AVD name when the running emulator lacks AVD metadata", async () => {
      const original = createBootedDevice(
        "emulator-5554",
        "android",
        "Unknown (emulator-5554)",
      );
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await initializeLiveDevices([original, replacement]);
      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
        sourceImage.name,
      );

      try {
        expect(devicePool.getIdleDevices().map((device) => device.id)).not.toContain(
          replacement.deviceId,
        );
      } finally {
        await releaseReservation();
      }
    });

    test("rejects direct binding to an AVD reserved for recovery readiness", async () => {
      const original = createBootedDevice(
        "emulator-5554",
        "android",
        "Unknown (emulator-5554)",
      );
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await initializeLiveDevices([original, replacement]);
      const releaseReservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
        sourceImage.name,
      );

      try {
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "competing-session",
            replacement.deviceId,
            "android",
            sourceImage,
          ),
        ).rejects.toThrow("not available");
        expect(sessionManager.getSession("competing-session")).toBeNull();
      } finally {
        await releaseReservation();
      }
    });

    test("allows the readiness reservation owner to bind its recovered AVD", async () => {
      const original = createBootedDevice(
        "emulator-5554",
        "android",
        "Unknown (emulator-5554)",
      );
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      await initializeLiveDevices([original, replacement]);
      const reservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
        sourceImage.name,
      );

      try {
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "recovery-session",
            replacement.deviceId,
            "android",
            sourceImage,
            undefined,
            undefined,
            false,
            new Set([reservation.owner]),
          ),
        ).resolves.toBe("recovery-session");
        expect(sessionManager.getSession("recovery-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await reservation();
      }
    });

    test("keeps a same-serial recovery replacement reserved for its readiness owner", async () => {
      const original = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [original];
      await devicePool.addDevice(original, sourceImage);
      const reservation = await devicePool.reserveDeviceForReadiness(
        original.deviceId,
        original,
        sourceImage.name,
      );
      const originalIncarnation = devicePool.getDevice(original.deviceId)?.incarnation;

      await devicePool.removeDevice(original.deviceId);
      const replacement = { ...original, transportId: "2" };
      fakeDeviceManager.bootedDevices = [replacement];
      await devicePool.addDevice(replacement, sourceImage);

      try {
        expect(devicePool.getDevice(replacement.deviceId)?.incarnation).not.toBe(originalIncarnation);
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "competing-session",
            replacement.deviceId,
            "android",
            sourceImage,
          ),
        ).rejects.toThrow("not available");
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "recovery-session",
            replacement.deviceId,
            "android",
            sourceImage,
            undefined,
            undefined,
            false,
            new Set([reservation.owner]),
          ),
        ).resolves.toBe("recovery-session");
        expect(sessionManager.getSession("competing-session")).toBeNull();
        expect(sessionManager.getSession("recovery-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await reservation();
      }
    });

    test("allows concurrent readiness owners to reuse their exact same AVD", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.addDevice(device, sourceImage);
      const firstReservation = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );
      const secondReservation = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );

      try {
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "first-session",
            device.deviceId,
            "android",
            undefined,
            undefined,
            device,
            false,
            new Set([firstReservation.owner]),
          ),
        ).resolves.toBe("first-session");
        await expect(
          devicePool.bindOrReuseDeviceSession(
            "second-session",
            device.deviceId,
            "android",
            undefined,
            undefined,
            device,
            false,
            new Set([secondReservation.owner]),
          ),
        ).resolves.toBe("first-session");
      } finally {
        await firstReservation();
        await secondReservation();
      }
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

    test("defers refresh eviction while a shutdown reservation owns the incarnation", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await devicePool.initializeWithDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const reservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }
      fakeDeviceManager.bootedDevices = [];

      try {
        await devicePool.refreshDevices();
        await devicePool.refreshDevices();

        expect(devicePool.getDevice(captured.id)).toBe(captured);
      } finally {
        await reservation.release();
      }

      await devicePool.refreshDevices();
      expect(devicePool.getDevice(captured.id)).toBeNull();
    });

    test("keeps the existing session through a System UI recovery handoff", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected recovery device to be pooled");
      }
      const readinessRelease = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        expect(devicePool.getDevice(device.deviceId)).toBe(captured);
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);

        const replacement = {
          ...device,
          deviceId: "emulator-5556",
        };
        const handoff = await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        expect(handoff.preservedSessionId).toBe("owner-session");
        expect(devicePool.getDevice(device.deviceId)).toBeNull();
        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "owner-session",
          status: "busy",
          avdName: sourceImage.name,
        });
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
        expect(devicePool.getIdleDevices()).toEqual([]);
      } finally {
        await shutdownReservation.release();
        await readinessRelease();
      }
    });

    test("carries the autolock owner onto the System UI recovery replacement", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected recovery device to be pooled");
      }
      // Simulate an autolocked device so recovery must preserve exclusivity; an
      // unset autolockSessionId on the replacement would let any session drive it.
      captured.autolockSessionId = "owner-session";
      const readinessRelease = await devicePool.reserveDeviceForReadiness(
        device.deviceId,
        device,
        sourceImage.name,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };
        await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "owner-session",
          autolockSessionId: "owner-session",
        });
      } finally {
        await shutdownReservation.release();
        await readinessRelease();
      }
    });

    test("resets device-scoped session state when recovery reuses the serial", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      const unboundDevices: string[] = [];
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      sessionManager.setLastHierarchy("owner-session", { hierarchy: {} });
      sessionManager.setKeepScreenAwake("owner-session", { applied: true });
      sessionManager.onSessionDeviceUnbound((_sessionId, deviceId) => unboundDevices.push(deviceId));
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          device,
          sourceImage,
        );

        expect(sessionManager.getSession("owner-session")).toMatchObject({
          assignedDevice: device.deviceId,
          cacheData: {},
        });
        expect(unboundDevices).toEqual([device.deviceId]);
      } finally {
        await shutdownReservation.release();
      }
    });

    test("adopts a matching replacement that refresh already added before handoff", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device, replacement];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected recovery device to be pooled");
      }
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        // Discovery can add the booted replacement before the recovery handoff
        // observes it. The handoff must adopt this instance rather than deleting
        // the original first and then rejecting the already-pooled replacement.
        await devicePool.addDevice(replacement);
        await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        expect(devicePool.getDevice(device.deviceId)).toBeNull();
        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "owner-session",
          status: "busy",
          avdName: sourceImage.name,
        });
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await shutdownReservation.release();
      }
    });

    test("does not adopt a matching replacement that another session already owns", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device, replacement];
      await devicePool.initializeWithDevices([device, replacement]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      await devicePool.bindOrReuseDeviceSession(
        "competing-session",
        replacement.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        await expect(
          devicePool.replaceDeviceForSystemUiAnrRecovery(
            shutdownReservation.device,
            replacement,
            sourceImage,
          ),
        ).rejects.toThrow("already assigned to a session");
        expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);
        expect(sessionManager.getSession("competing-session")?.assignedDevice).toBe(
          replacement.deviceId,
        );
      } finally {
        await shutdownReservation.release();
      }
    });

    test("does not retire a same-serial successor while cleaning up a recovery replacement", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const replacement = createBootedDevice("emulator-5556", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const handoff = await devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
        );

        await sessionManager.releaseSession("owner-session", "test replacement exit");
        await devicePool.releaseDevice(replacement.deviceId, "owner-session");
        await devicePool.removeDevice(
          replacement.deviceId,
          false,
          handoff.replacementDevice,
        );
        fakeDeviceManager.bootedDevices = [replacement];
        await devicePool.addDevice(replacement, sourceImage);
        await devicePool.bindOrReuseDeviceSession(
          "successor-session",
          replacement.deviceId,
          "android",
          sourceImage,
        );

        await expect(handoff.validatePreservedSession()).rejects.toThrow(
          "was released while System UI recovery was becoming ready",
        );
        expect(
          await devicePool.retireDeviceAfterSystemUiAnrRecoveryFailure(
            handoff.replacementDevice,
          ),
        ).toBe(false);
        expect(devicePool.getDevice(replacement.deviceId)).toMatchObject({
          sessionId: "successor-session",
          status: "busy",
        });
      } finally {
        await shutdownReservation.release();
      }
    });

    test("rolls back the replacement when the recovery session rebind fails", async () => {
      sessionManager.stopCleanupTimer();
      const sessionPersistence = new FakeDeviceSessionPersistence();
      // The first upsert binds the owner session; the rebind onto the
      // replacement is the second, and it rejects here.
      sessionPersistence.createFailureOnAttempt = 2;
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      fakeDeviceManager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        fakeDeviceManager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };

        await expect(
          devicePool.replaceDeviceForSystemUiAnrRecovery(
            shutdownReservation.device,
            replacement,
            sourceImage,
          ),
        ).rejects.toThrow("persist create failed");

        // The failed rebind must not strand an idle, assignable replacement that
        // still maps to the stopped serial.
        expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
        expect(devicePool.getIdleDevices()).toEqual([]);
        expect(sessionManager.getSession("owner-session")).toBeNull();
      } finally {
        await shutdownReservation.release();
      }
    });

    test("rolls back when the replacement exits during recovery session persistence", async () => {
      const manager = new FakeDeviceManagerWithStartedProcess();
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      manager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);

      const binding = devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      await persistence.waitForUpsert();
      persistence.finishUpsert();
      await binding;
      persistence.deferNextUpsert();

      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };
        const handoff = devicePool.replaceDeviceForSystemUiAnrRecovery(
          shutdownReservation.device,
          replacement,
          sourceImage,
          manager.childProcess,
        );
        await persistence.waitForUpsert();
        manager.childProcess.emit("exit", 0, null);
        await new Promise((resolve) => setImmediate(resolve));
        persistence.finishUpsert();

        await expect(handoff).rejects.toThrow(
          "disconnected while its recovery session was being rebound",
        );
        expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
        expect(sessionManager.getSession("owner-session")).toBeNull();
        expect(sessionManager.getSessionForDevice(replacement.deviceId)).toBeNull();
      } finally {
        await shutdownReservation.release();
      }
    });

    test("rolls back when the replacement exited before process tracking", async () => {
      const manager = new FakeDeviceManagerWithStartedProcess();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const sourceImage: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        source: "local",
      };
      manager.bootedDevices = [device];
      await devicePool.initializeWithDevices([device]);
      await devicePool.bindOrReuseDeviceSession(
        "owner-session",
        device.deviceId,
        "android",
        sourceImage,
      );
      const shutdownReservation = await devicePool.reserveDeviceForShutdown(device.deviceId);
      if (!shutdownReservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        manager.bootedDevices = [];
        await devicePool.removeDisconnectedDevice(device.deviceId, false);
        const replacement = { ...device, deviceId: "emulator-5556" };
        manager.childProcess.exitCode = 1;
        manager.childProcess.signalCode = null;

        await expect(
          devicePool.replaceDeviceForSystemUiAnrRecovery(
            shutdownReservation.device,
            replacement,
            sourceImage,
            manager.childProcess,
          ),
        ).rejects.toThrow("exited before process tracking completed");

        expect(devicePool.getDevice(replacement.deviceId)).toBeNull();
        expect(sessionManager.getSession("owner-session")).toBeNull();
        expect(sessionManager.getSessionForDevice(device.deviceId)).toBeNull();
      } finally {
        await shutdownReservation.release();
      }
    });

    test("defers monitor loss recovery while System UI recovery owns the emulator", async () => {
      const originalRecoveryOnLoss = process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
      const restoreRecoveryOnLoss = () => {
        if (originalRecoveryOnLoss === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRecoveryOnLoss;
        }
      };

      try {
        process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = "1";
        const manager = new FakeDeviceManager();
        const pool = new DevicePool(
          sessionManager,
          "daemon-session",
          fakeTimer,
          fakeAppsRepo,
          manager,
          new DefaultRetryExecutor(fakeTimer),
        );
        const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
        const sourceImage: DeviceInfo = {
          name: "Pixel 8",
          platform: "android",
          isRunning: false,
          source: "local",
        };
        manager.bootedDevices = [device];
        await pool.initializeWithDevices([device]);
        await pool.bindOrReuseDeviceSession(
          "owner-session",
          device.deviceId,
          "android",
          sourceImage,
        );
        const captured = pool.getDevice(device.deviceId);
        if (!captured) {
          throw new Error("expected recovery device to be pooled");
        }
        const reservation = await pool.reserveDeviceForShutdown(captured.id);
        if (!reservation) {
          throw new Error("expected shutdown reservation");
        }

        try {
          manager.bootedDevices = [];
          await pool.removeDisconnectedDevice(device.deviceId, false);

          expect(pool.getDevice(device.deviceId)).toBe(captured);
          expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(device.deviceId);
          expect(manager.startedDevices).toEqual([]);
        } finally {
          await reservation.release();
        }
      } finally {
        restoreRecoveryOnLoss();
      }
    });

    test("does not hold the assignment mutex for replacement session tracking", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      const appsRepository = new DeferredSessionTrackingAppsRepository();
      const pool = new DevicePool(
        sessionManager,
        "daemon-session",
        fakeTimer,
        appsRepository,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await pool.initializeWithDevices([device]);
      const captured = pool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      appsRepository.deferNextTrackingWrite();

      const replacement = await pool.replaceDeviceForShutdown(captured, {
        ...device,
        name: "Pixel 8 replacement",
      });

      expect(replacement?.name).toBe("Pixel 8 replacement");
      appsRepository.finishDeferredTrackingWrite();
    });

    test("allows a replacement incarnation to acquire its own shutdown reservation", async () => {
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await devicePool.initializeWithDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const originalReservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!originalReservation) {
        throw new Error("expected original shutdown reservation");
      }

      const replacement = await devicePool.replaceDeviceForShutdown(captured, {
        ...device,
        name: "Pixel 8 replacement",
      });
      const replacementReservation = await devicePool.reserveDeviceForShutdown(captured.id);

      expect(replacementReservation?.device).toBe(replacement);
      await replacementReservation?.release();
      await originalReservation.release();
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

    test("restores the pooled device when session persistence rejects", async () => {
      sessionManager.stopCleanupTimer();
      const sessionPersistence = new FakeDeviceSessionPersistence();
      sessionPersistence.failure = "create";
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await initializeLiveDevices([createBootedDevice("emulator-5554")]);
      const before = devicePool.getDevice("emulator-5554");
      const previousAssignment = {
        sessionId: before?.sessionId,
        status: before?.status,
        assignmentCount: before?.assignmentCount,
        errorCount: before?.errorCount,
        lastUsedAt: before?.lastUsedAt,
      };

      await expect(devicePool.assignDeviceToSession("session-failure")).rejects.toThrow("persist create failed");

      expect(devicePool.getDevice("emulator-5554")).toMatchObject(previousAssignment);
      expect(sessionManager.getSession("session-failure")).toBeNull();
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
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

    test("keeps a shutdown reservation exclusive to direct binding and autolock", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const device = createBootedDevice("emulator-5554", "android", "Pixel 8");
      await initializeLiveDevices([device]);
      const captured = devicePool.getDevice(device.deviceId);
      if (!captured) {
        throw new Error("expected shutdown device to be pooled");
      }
      const reservation = await devicePool.reserveDeviceForShutdown(captured.id);
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        expect(devicePool.getAvailableDeviceCount()).toBe(0);
        devicePool.markIntentionalShutdown(captured.id);
        await devicePool.removeDisconnectedDevice(captured.id, false);
        expect(devicePool.getDevice(captured.id)).toBe(captured);
        await expect(
          devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform),
        ).rejects.toThrow(/shutting down/);

        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await expect(
          devicePool.autolockDevice(device.deviceId, device.platform, "mcp-session-1"),
        ).rejects.toThrow(/shutting down/);
      } finally {
        await reservation.release();
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }

      expect(devicePool.getAvailableDeviceCount()).toBe(1);
      await expect(
        devicePool.bindOrReuseDeviceSession("session-1", device.deviceId, device.platform),
      ).resolves.toBe("session-1");
    });

    test("releases the old pooled device after rebinding an existing session", async () => {
      await initializeLiveDevices([
        createBootedDevice("emulator-old"),
        createBootedDevice("emulator-new"),
      ]);
      await devicePool.bindOrReuseDeviceSession("session-1", "emulator-old", "android");

      await devicePool.bindOrReuseDeviceSession(
        "session-1",
        "emulator-new",
        "android",
        undefined,
        undefined,
        undefined,
        true,
      );

      expect(devicePool.getDevice("emulator-old")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("emulator-new")).toMatchObject({ sessionId: "session-1", status: "busy" });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-new");
    });

    test("binds a same-serial transport reconnect without requiring a retry", async () => {
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      await initializeLiveDevices([firstConnection]);
      fakeDeviceManager.bootedDevices = [reconnected];

      await expect(
        devicePool.bindOrReuseDeviceSession("session-1", reconnected.deviceId, "android"),
      ).resolves.toBe("session-1");

      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        transportId: "2",
        sessionId: "session-1",
        status: "busy",
      });
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe(reconnected.deviceId);
    });

    test("autolocks a same-serial transport reconnect without reacquiring the assignment mutex", async () => {
      const originalAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      try {
        process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
        await initializeLiveDevices([firstConnection]);
        fakeDeviceManager.bootedDevices = [reconnected];

        await expect(
          devicePool.autolockDevice(reconnected.deviceId, "android", "mcp-session-1"),
        ).resolves.toBeDefined();

        expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
          transportId: "2",
          status: "busy",
        });
      } finally {
        if (originalAutolock === undefined) {
          delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
        } else {
          process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
        }
      }
    });

    test("assigns the current replacement after liveness discovery supersedes a captured device", async () => {
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      const manager = new DeferredReconnectionDiscoveryFakeDeviceManager(
        [reconnected],
        [reconnected],
      );
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await devicePool.addDevice(firstConnection);

      const assignment = devicePool.assignDeviceToSession("session-1", "android");
      await manager.waitForDiscoveryStart();
      await devicePool.removeDevice(firstConnection.deviceId);
      await devicePool.addDevice(reconnected);

      manager.releaseDiscovery();

      await expect(assignment).resolves.toBe(reconnected.deviceId);
      expect(devicePool.getDevice(reconnected.deviceId)).toMatchObject({
        transportId: "2",
        sessionId: "session-1",
        status: "busy",
      });
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
    test("does not evict a session claimed while preflight reconnect discovery is pending", async () => {
      const firstConnection = {
        ...createBootedDevice("emulator-5554", "android", "Pixel 8"),
        transportId: "1",
      };
      const reconnected = { ...firstConnection, transportId: "2" };
      const deferredDeviceManager = new DeferredReconnectionDiscoveryFakeDeviceManager(
        [reconnected],
        [firstConnection],
      );
      fakeDeviceManager = deferredDeviceManager;
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await initializeLiveDevices([firstConnection]);

      const preflightAllocation = devicePool.assignMultipleDevices(
        ["preflight-session"],
        1000,
        "android",
      );
      await deferredDeviceManager.waitForDiscoveryStart();

      await devicePool.assignDeviceToSession("concurrent-session", "android");
      await devicePool.addDevice(createBootedDevice("R5CT654321", "android", "Pixel 9"));
      deferredDeviceManager.releaseDiscovery();
      await preflightAllocation;

      expect(sessionManager.getSession("concurrent-session")?.assignedDevice).toBe(
        firstConnection.deviceId,
      );
      expect(devicePool.getDevice(firstConnection.deviceId)).toMatchObject({
        sessionId: "concurrent-session",
        status: "busy",
        transportId: "1",
      });
    });

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

    test("releases a partial device claim when the session was already bound elsewhere", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);
      await sessionManager.createSession("session-a", "existing-device", "ios");
      failIosLivenessAfterFirstSession();

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toMatchObject({
        assignedDevice: "existing-device",
      });
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: null, status: "idle" });
      expect(devicePool.getDevice("sim-2")).toMatchObject({ sessionId: null, status: "idle" });
    });

    test("preserves a replacement session that reuses a UUID during rollback", async () => {
      await initializeLiveDevices([
        createBootedDevice("sim-1", "ios", "iPhone 15"),
        createBootedDevice("sim-2", "ios", "iPhone 16"),
      ]);
      const createSession = sessionManager.createSession.bind(sessionManager);
      const releaseSession = sessionManager.releaseSession.bind(sessionManager);
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
          await releaseSession(sessionId);
          await createSession(sessionId, deviceId, platform, timeoutMs, heartbeatTimeoutMs);
          fakeDeviceManager.failedPlatforms.add("ios");
        }
        return session;
      };

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1000, "ios"),
      ).rejects.toThrow(/Unable to verify iOS simulator liveness/);

      expect(sessionManager.getSession("session-a")).toMatchObject({ assignedDevice: "sim-1" });
      expect(devicePool.getDevice("sim-1")).toMatchObject({ sessionId: "session-a", status: "busy" });
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

    test("releases earlier session ownership when a later persistence write rejects", async () => {
      sessionManager.stopCleanupTimer();
      const sessionPersistence = new FakeDeviceSessionPersistence();
      sessionPersistence.createFailureOnAttempt = 2;
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
      ]);

      await expect(
        devicePool.assignMultipleDevices(["session-a", "session-b"], 1_000, "android"),
      ).rejects.toThrow("persist create failed");

      expect(sessionManager.getSession("session-a")).toBeNull();
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
      expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
    });

    test("releases the old device without rolling back a replacement session with the same UUID", async () => {
      const secondWriteStarted = Promise.withResolvers<void>();
      const secondWriteFinished = Promise.withResolvers<void>();
      let writeCount = 0;
      const sessionPersistence: DeviceSessionPersistence = {
        async upsertActiveSession(): Promise<void> {
          writeCount++;
          if (writeCount === 2) {
            secondWriteStarted.resolve();
            await secondWriteFinished.promise;
            throw new Error("persist create failed");
          }
        },
        async recordActivity(): Promise<void> {},
        async markReleased(): Promise<void> {},
      };
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, sessionPersistence);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        fakeDeviceManager,
        new DefaultRetryExecutor(fakeTimer),
      );
      await initializeLiveDevices([
        createBootedDevice("emulator-5554"),
        createBootedDevice("emulator-5556"),
        createBootedDevice("emulator-5558"),
      ]);

      const allocation = devicePool.assignMultipleDevices(["session-a", "session-b"], 1_000, "android");
      await secondWriteStarted.promise;

      await sessionManager.releaseSession("session-a");
      await sessionManager.createSession("session-a", "emulator-5558", "android");
      secondWriteFinished.resolve();

      await expect(allocation).rejects.toThrow("persist create failed");
      expect(sessionManager.getSession("session-a")?.assignedDevice).toBe("emulator-5558");
      expect(devicePool.getDevice("emulator-5554")?.status).toBe("idle");
    });
  });

  describe("assignMultipleDevices", () => {
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

      expect(releaseCalls).toHaveLength(1);
      expect(releaseCalls[0]).toEqual({
        sessionId: "session-1",
        deviceId: "emulator-5554",
        reason: expect.stringMatching(
          /^device-disconnected:emulator-5554;incident=emulator-loss-/,
        ),
      });
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
    });

    test("defers a started emulator's process-exit cleanup while shutdown is reserved", async () => {
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

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const reservation = await devicePool.reserveDeviceForShutdown("emulator-5554");
      if (!reservation) {
        throw new Error("expected shutdown reservation");
      }

      try {
        manager.childProcess.emit("exit", 0, null);
        await new Promise((resolve) => setImmediate(resolve));

        expect(releaseCalls).toEqual([]);
        expect(devicePool.getDevice("emulator-5554")).toBe(reservation.device);
        expect(sessionManager.getSessionForDevice("emulator-5554")).toBe("session-1");
      } finally {
        await reservation.release();
      }
    });

    test("does not publish a session when its started emulator exits during persistence", async () => {
      const images: DeviceInfo[] = [{
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      }];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const persistence = new DeferredDeviceSessionPersistence();
      sessionManager.stopCleanupTimer();
      sessionManager = new SessionManager(fakeTimer, persistence);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );

      const assignment = devicePool.assignMultipleDevices(["session-1"], 1000, "android");
      await persistence.waitForUpsert();
      manager.childProcess.emit("exit", 0, null);
      await new Promise(resolve => setImmediate(resolve));
      persistence.finishUpsert();

      await expect(assignment).rejects.toThrow("disconnected while its session was being created");
      expect(devicePool.getDevice("emulator-5554")).toBeNull();
      expect(sessionManager.getSession("session-1")).toBeNull();
      expect(sessionManager.getSessionForDevice("emulator-5554")).toBeNull();
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
        const incidents = new InMemoryEmulatorLossIncidentStore(
          fakeTimer,
          new CountingIdGenerator("incident"),
        );
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
          undefined,
          { onLoss: true, maxAttempts: 2 },
          undefined,
          incidents,
        );

        await devicePool.assignMultipleDevices(["session-1"], 1000, "android");
        manager.bootedDevices = [];

        manager.childProcess.emit("exit", 1, null);
        await new Promise((resolve) => setImmediate(resolve));

        expect(manager.startedDevices.map((device) => device.name)).toEqual(["Pixel 8", "Pixel 8"]);
        expect(devicePool.getDevice("emulator-5554")).toBeNull();
        expect(devicePool.getDevice("Pixel 8")).toMatchObject({
          avdName: "Pixel 8",
          sessionId: "session-1",
          status: "busy",
        });
        expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("Pixel 8");
        await expect(incidents.list()).resolves.toMatchObject([
          {
            deviceId: "emulator-5554",
            replacementDeviceId: "Pixel 8",
            session: {
              sessionUuid: "session-1",
              state: "active",
            },
            recovery: {
              outcome: "recovered",
              attempts: [{ attempt: 1, outcome: "succeeded" }],
            },
          },
        ]);
      } finally {
        if (originalRebootOnDeath === undefined) {
          delete process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH;
        } else {
          process.env.AUTOMOBILE_ANDROID_REBOOT_ON_DEATH = originalRebootOnDeath;
        }
      }
    });

    test("quarantines a process-exit session before incident persistence completes", async () => {
      const images: DeviceInfo[] = [{
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      }];
      const manager = new FakeDeviceManagerWithStartedProcess(images);
      const backingStore = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      const openStarted = Promise.withResolvers<void>();
      const releaseOpen = Promise.withResolvers<void>();
      const incidents: EmulatorLossIncidentStore = {
        async open(input) {
          openStarted.resolve();
          await releaseOpen.promise;
          return await backingStore.open(input);
        },
        async recordRecoveryAttempt(incidentId, attempt) {
          await backingStore.recordRecoveryAttempt(incidentId, attempt);
        },
        async completeRecovery(incidentId, outcome, settlement) {
          await backingStore.completeRecovery(incidentId, outcome, settlement);
        },
        async get(incidentId) {
          return await backingStore.get(incidentId);
        },
        async list(limit) {
          return await backingStore.list(limit);
        },
      };
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
        undefined,
        { onLoss: true, maxAttempts: 1 },
        undefined,
        incidents,
      );

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      manager.bootedDevices = [];
      manager.childProcess.emit("exit", 1, null);
      await openStarted.promise;

      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => devicePool.assertSessionReadyForAutomation("session-1")).toThrow(
        "device-disconnected:emulator-5554",
      );

      await sessionManager.releaseSession("session-1", "explicit-release");
      await devicePool.releaseDevice("emulator-5554", "session-1");
      manager.bootedDevices = [{
        name: "Pixel 8",
        platform: "android",
        deviceId: "emulator-5554",
      }];
      await devicePool.bindOrReuseDeviceSession(
        "session-2",
        "emulator-5554",
        "android",
        images[0],
      );
      releaseOpen.resolve();
      for (let attempt = 0; attempt < 10 && (await backingStore.list()).length === 0; attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(false);
      expect(sessionManager.getSession("session-2")?.assignedDevice).toBe("emulator-5554");
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: "session-2",
        status: "busy",
      });
      const recordedIncidents = await backingStore.list();
      expect(recordedIncidents).toMatchObject([
        { recovery: { outcome: "not-attempted" } },
      ]);
      const settlement = devicePool.waitForEmulatorLossIncident(recordedIncidents[0]!.id);
      let settlementResolved = false;
      void settlement.then(() => {
        settlementResolved = true;
      });
      for (let attempt = 0; attempt < 10 && !settlementResolved; attempt++) {
        await Promise.resolve();
      }
      expect(settlementResolved).toBe(true);
      await settlement;
    });

    test("coalesces concurrent loss signals into one session-preserving recovery", async () => {
      const manager = new DeferredRecoveryDeviceManager();
      const incidents = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      const images: DeviceInfo[] = [{
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      }];
      manager.deviceImages = images;
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
        undefined,
        { onLoss: true, maxAttempts: 1 },
        undefined,
        incidents,
      );

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      const disconnected = devicePool.getDevice("emulator-5554")!;
      manager.bootedDevices = [];
      const firstIncident = await devicePool.recordEmulatorLossIncident(
        disconnected.id,
        "watched-process-exit",
      );
      const duplicateIncident = await devicePool.recordEmulatorLossIncident(
        disconnected.id,
        "device-discovery-miss",
      );
      const first = devicePool.recoverSessionBoundAndroidDeviceAfterLoss(
        disconnected.id,
        firstIncident,
        disconnected,
      );
      await manager.waitForRecoveryStart();

      const duplicate = devicePool.recoverSessionBoundAndroidDeviceAfterLoss(
        disconnected.id,
        duplicateIncident,
        disconnected,
      );
      expect(devicePool.isSessionRecoveryInFlight("session-1")).toBe(true);
      expect(() => devicePool.assertSessionReadyForAutomation("session-1")).toThrow(
        `device-disconnected:emulator-5554;incident=${firstIncident}`,
      );
      manager.releaseRecovery();

      await expect(Promise.all([first, duplicate])).resolves.toEqual([
        "recovered",
        "recovered",
      ]);
      expect(manager.childProcesses).toHaveLength(2);
      expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5554");
      expect(devicePool.getDevice("emulator-5554")).toMatchObject({
        sessionId: "session-1",
        status: "busy",
      });
      await expect(incidents.get(duplicateIncident!)).resolves.toMatchObject({
        recovery: { outcome: "recovered" },
        session: { state: "active" },
      });
    });

    test("records failed recovery spawn attempts", async () => {
      const images: DeviceInfo[] = [{
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      }];
      const manager = new FakeDeviceManagerWithFailingRecoveryStart(images);
      const incidents = new InMemoryEmulatorLossIncidentStore(
        fakeTimer,
        new CountingIdGenerator("incident"),
      );
      const twoFailedAttempts = {
        async run(_target: DeviceInfo, reboot: () => Promise<void>): Promise<boolean> {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await reboot();
            } catch {
              // The retry policy intentionally continues after each failed start.
            }
          }
          return false;
        },
      };
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
        twoFailedAttempts,
        { onLoss: true, maxAttempts: 2 },
        undefined,
        incidents,
      );

      await devicePool.assignMultipleDevices(["session-1"], 1_000, "android");
      manager.bootedDevices = [];
      manager.childProcesses[0]!.emit("exit", 1, null);
      await new Promise((resolve) => setImmediate(resolve));

      const [incident] = await incidents.list();
      expect(incident?.recovery).toEqual({
        policy: { onLoss: true, maxAttempts: 2 },
        attempts: [
          { attempt: 1, outcome: "failed" },
          { attempt: 2, outcome: "failed" },
        ],
        outcome: "exhausted",
      });
      expect(sessionManager.getSession("session-1")).toBeNull();
      await expect(
        sessionManager.getOrCreateSession("session-1", devicePool, "android"),
      ).rejects.toThrow("terminal");
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

        await expect(fakeTimer.resolvePromise(allocation, 100)).rejects.toThrow(
          "Timed out allocating devices",
        );
        expect(sessionManager.getSession("session-1")?.assignedDevice).toBe("emulator-5554");
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

    test("bounds a pending pool cold-boot readiness wait by the allocation deadline", async () => {
      const image: DeviceInfo = {
        name: "Pixel 8",
        platform: "android",
        isRunning: false,
        deviceId: "emulator-5554",
        source: "local",
      };
      const manager = new FakeDeviceManagerWithPendingReadiness([image]);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );

      const allocation = devicePool.assignMultipleDevices(["session-1"], 1_000, "android");

      await expect(fakeTimer.resolvePromise(allocation, 100)).rejects.toThrow();
      expect(fakeTimer.now()).toBe(1_000);
      expect(manager.childProcess.killCount).toBe(1);
    });

    test("aborts a pending pool cold-boot start at the allocation deadline", async () => {
      const image: DeviceInfo = {
        name: "Pixel 8",
        platform: "ios",
        isRunning: false,
        deviceId: "sim-1234",
        source: "local",
      };
      const manager = new FakeDeviceManagerWithPendingStart([image]);
      devicePool = new DevicePool(
        sessionManager,
        "test-daemon-session-id",
        fakeTimer,
        fakeAppsRepo,
        manager,
        new DefaultRetryExecutor(fakeTimer),
      );

      const allocation = devicePool.assignMultipleDevices(["session-1"], 1_000, "ios");

      await expect(fakeTimer.resolvePromise(allocation, 100)).rejects.toThrow();
      expect(manager.startObservedAbort).toBe(true);
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
        1000,
        1000,
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
      expect(fakeDeviceManager.startDeviceTimeouts).toEqual([1000]);
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
      await devicePool.releaseDevice(deviceId, "session-a");
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
