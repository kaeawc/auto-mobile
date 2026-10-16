import { createDevicePoolDependencies } from "./devicePoolDependencies";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice, DeviceInfo, Platform, SomePlatform } from "../../src/models";
import { EmulatorLaunchCancelledError } from "../../src/models/EmulatorLaunchCancelledError";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { getAbortSignal } from "../../src/utils/AbortContext";

export async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
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

export const createBootedDevice = (
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

export class FakeDeviceManagerWithMinimalReadyDevice extends FakeDeviceManager {
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

export class CountingFakeDeviceManager extends FakeDeviceManager {
  detailedBootedCalls = 0;

  async getBootedDevicesDetailed(platform: "android" | "ios" | "either") {
    this.detailedBootedCalls++;
    return super.getBootedDevicesDetailed(platform);
  }
}

export class RunningProbeCountingFakeDeviceManager extends FakeDeviceManager {
  runningProbeCalls = 0;

  override async isDeviceImageRunning(device: DeviceInfo): Promise<boolean> {
    this.runningProbeCalls++;
    return await super.isDeviceImageRunning(device);
  }
}

export class TransportAwareFakeDeviceManager extends FakeDeviceManager {
  discoveryOptions: Array<
    | {
        bypassAndroidDeviceListCache?: boolean;
        bypassIosDeviceListCache?: boolean;
      }
    | undefined
  > = [];

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options?: {
      bypassAndroidDeviceListCache?: boolean;
      bypassIosDeviceListCache?: boolean;
    },
  ) {
    this.discoveryOptions.push(options);
    return await super.getBootedDevicesDetailed(platform);
  }
}

export class OutOfOrderRefreshFakeDeviceManager extends FakeDeviceManager {
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

export class DeferredDiscoveryFakeDeviceManager extends FakeDeviceManager {
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

export class DeferredSessionTrackingAppsRepository extends FakeInstalledAppsRepository {
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
      await new Promise<void>((resolve) => {
        this.resolveDeferredTracking = resolve;
      });
    }
    await super.setSessionTracking(daemonSessionId, deviceId, deviceSessionStart);
  }
}

export class DeferredReconnectionDiscoveryFakeDeviceManager extends FakeDeviceManager {
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

  addToConcurrentSnapshot(device: BootedDevice): void {
    this.concurrentSnapshot.push(device);
  }

  private discoveryFor(devices: BootedDevice[], platform: SomePlatform) {
    const platforms: Platform[] = platform === "either" ? ["android", "ios"] : [platform];
    return {
      devices: devices.filter((device) => platforms.includes(device.platform)),
      succeededPlatforms: new Set(platforms),
    };
  }
}

export class ThrowingDiscoveryFakeDeviceManager extends FakeDeviceManager {
  override async getBootedDevicesDetailed(): Promise<never> {
    throw new Error("adb discovery crashed");
  }
}

export class FakeChildProcess extends EventEmitter {
  pid = 12345;
  exitCode: number | null | undefined = undefined;
  signalCode: NodeJS.Signals | null | undefined = undefined;
  killCount = 0;
  kill(): boolean {
    this.killCount++;
    return true;
  }
}

export class DeferredDeviceSessionPersistence extends FakeDeviceSessionPersistence {
  async recordLivenessOwnership(): Promise<void> {}

  async replaceLivenessOwnership(): Promise<void> {}

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

  failUpsert(error: Error): void {
    this.writeFinished.reject(error);
  }

  async upsertActiveSession(): Promise<number> {
    if (!this.deferWrite) {
      return 0;
    }
    this.deferWrite = false;
    this.writeStarted.resolve();
    await this.writeFinished.promise;
    return 0;
  }

  async recordActivity(): Promise<void> {}

  async markReleased(): Promise<void> {}
}

export class FakeDeviceManagerWithStartedProcess extends FakeDeviceManagerWithMinimalReadyDevice {
  readonly childProcess = new FakeChildProcess();

  async startDevice(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<FakeChildProcess> {
    await super.startDevice(device, timeoutMs);
    return this.childProcess;
  }
}

export class FakeDeviceManagerWithDistinctStartedProcesses extends FakeDeviceManager {
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

export class FakeDeviceManagerWithExitedRecoveryProcess extends FakeDeviceManagerWithDistinctStartedProcesses {
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

export class FakeDeviceManagerWithExitedInitialProcess extends FakeDeviceManagerWithDistinctStartedProcesses {
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

export class FakeDeviceManagerWithFailingRecoveryStart extends FakeDeviceManagerWithDistinctStartedProcesses {
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

export class StubbornChildProcess extends EventEmitter {
  readonly pid = 12345;
  readonly exitCode = null;
  readonly signalCode = null;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
}

export class FakeDeviceManagerWithStubbornProcess extends FakeDeviceManager {
  readonly childProcess = new StubbornChildProcess();

  override async startDevice(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess> {
    await super.startDevice(device, timeoutMs);
    return this.childProcess as unknown as ChildProcess;
  }
}

export class FakeDeviceManagerWithStubbornFailingReadiness extends FakeDeviceManagerWithStubbornProcess {
  override async waitForDeviceReady(): Promise<BootedDevice> {
    throw new Error("readiness timeout");
  }
}

/** Like the real client, a launch cancelled after the spawn rejects carrying its child (#10075). */
export class FakeDeviceManagerWithCancelledLaunch extends FakeDeviceManagerWithStubbornProcess {
  override async startDevice(
    device: DeviceInfo,
    timeoutMs: number = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  ): Promise<ChildProcess> {
    const childProcess = await super.startDevice(device, timeoutMs);
    throw new EmulatorLaunchCancelledError(device.name, childProcess);
  }
}

export class DeferredRecoveryDeviceManager extends FakeDeviceManager {
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

export class StubbornRecoveryChildProcess extends FakeChildProcess {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  readonly sigtermSent = Promise.withResolvers<void>();
  readonly sigkillSent = Promise.withResolvers<void>();

  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.killCount++;
    this.signals.push(signal);
    if (signal === "SIGTERM") {
      this.sigtermSent.resolve();
    } else if (signal === "SIGKILL") {
      this.sigkillSent.resolve();
    }
    return true;
  }
}

export class DeferredRecoveryDeviceManagerWithStubbornChild extends DeferredRecoveryDeviceManager {
  readonly recoveryChild = new StubbornRecoveryChildProcess();

  protected override createRecoveryChild(): FakeChildProcess {
    return this.recoveryChild;
  }
}

export class DeferredRecoveryDeviceManagerWithStubbornFailingReadiness extends DeferredRecoveryDeviceManagerWithStubbornChild {
  override async waitForDeviceReady(device: DeviceInfo): Promise<BootedDevice> {
    const ready = await super.waitForDeviceReady(device);
    if (this.childProcesses.length === 2) {
      throw new Error("recovery readiness rejected");
    }
    return ready;
  }
}

export class DeferredLivenessRecoveryDeviceManager extends FakeDeviceManager {
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
export class KillTrackingChildProcess extends FakeChildProcess {
  killCount = 0;
  override kill(): boolean {
    this.killCount++;
    return true;
  }
}

export class FakeDeviceManagerWithFailingReadiness extends FakeDeviceManager {
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

export class FakeDeviceManagerWithPendingReadiness extends FakeDeviceManager {
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

export class FakeDeviceManagerWithPendingStart extends FakeDeviceManager {
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

export class GatedSnapshotDeviceManager extends FakeDeviceManager {
  readonly snapshotTaken = Promise.withResolvers<void>();
  readonly resumeDiscovery = Promise.withResolvers<void>();
  gateDiscovery = false;

  override async getBootedDevicesDetailed(platform: SomePlatform) {
    const snapshot = await super.getBootedDevicesDetailed(platform);
    if (this.gateDiscovery) {
      this.snapshotTaken.resolve();
      await this.resumeDiscovery.promise;
    }
    return snapshot;
  }
}

type DevicePoolOverrides = Partial<
  Omit<DevicePoolDependencies, "sessionManager" | "daemonSessionId">
>;

interface DevicePoolSuiteState {
  devicePool: DevicePool;
  sessionManager: SessionManager;
  fakeTimer: FakeTimer;
  fakeAppsRepo: FakeInstalledAppsRepository;
  fakeDeviceManager: FakeDeviceManager;
}

type DevicePoolSuiteContext = () => DevicePoolSuiteState;

/**
 * Build a pool over the suite's session manager, timer, apps repository and device manager.
 * `overrides` replace any of those defaults (a different `deviceManager`, `recoveryPolicy`, ...).
 */
export function createDevicePoolFor(
  suite: Pick<
    DevicePoolSuiteState,
    "sessionManager" | "fakeTimer" | "fakeAppsRepo" | "fakeDeviceManager"
  >,
  overrides: DevicePoolOverrides = {},
): DevicePool {
  return new DevicePool(
    createDevicePoolDependencies(suite.sessionManager, "test-daemon-session-id", {
      timer: suite.fakeTimer,
      installedAppsRepository: suite.fakeAppsRepo,
      deviceManager: suite.fakeDeviceManager,
      retryExecutor: new DefaultRetryExecutor(suite.fakeTimer),
      ...overrides,
    }),
  );
}

/** Arrange helpers over the per-test pool, resolved lazily because `beforeEach` replaces it. */
export function devicePoolSuiteActions(context: DevicePoolSuiteContext) {
  const initializeLiveDevices = async (devices: BootedDevice[]): Promise<void> => {
    context().fakeDeviceManager.bootedDevices = [...devices];
    await context().devicePool.initializeWithDevices(devices);
  };

  const configureAfterFirstSession = (configure: () => void): void => {
    const { sessionManager } = context();
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
    configureAfterFirstSession(() => context().fakeDeviceManager.failedPlatforms.add("ios"));
  };

  /** A pool over the current per-test objects, for tests that replace the pool mid-test. */
  const makePool = (overrides: DevicePoolOverrides = {}): DevicePool =>
    createDevicePoolFor(context(), overrides);

  return {
    initializeLiveDevices,
    configureAfterFirstSession,
    failIosLivenessAfterFirstSession,
    makePool,
  };
}

/** The pool, session manager, timer and fakes every DevicePool suite starts each test with. */
export function createDevicePoolSuite() {
  const fakeTimer = new FakeTimer();
  const sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
  const fakeAppsRepo = new FakeInstalledAppsRepository();
  const fakeDeviceManager = new FakeDeviceManager();
  const devicePool = createDevicePoolFor({
    sessionManager,
    fakeTimer,
    fakeAppsRepo,
    fakeDeviceManager,
  });
  return { devicePool, sessionManager, fakeTimer, fakeAppsRepo, fakeDeviceManager };
}
