import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/utils/virtualDeviceLifecycleCoordinator";
import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeEmulatorConsoleBusyRegistry } from "../fakes/FakeEmulatorConsoleBusyRegistry";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { AndroidDeviceReboot } from "../../src/utils/androidDeviceReboot";
import type { DeviceRecoveryPolicy } from "../../src/daemon/poolConfig";
import type { BootedDevice } from "../../src/models";

describe("DevicePool.create", () => {
  const sessionManagers: SessionManager[] = [];

  afterEach(() => {
    for (const sessionManager of sessionManagers.splice(0)) {
      sessionManager.stopCleanupTimer();
    }
  });

  const makeSessionManager = (timer: FakeTimer): SessionManager => {
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManagers.push(sessionManager);
    return sessionManager;
  };

  const bootedDevice: BootedDevice = {
    name: "Pixel_8_API_35",
    platform: "android",
    deviceId: "emulator-5554",
  };

  test("matches the positional constructor with only required dependencies", async () => {
    const factoryTimer = new FakeTimer();
    const positionalTimer = new FakeTimer();
    const factoryPool = DevicePool.create({
      sessionManager: makeSessionManager(factoryTimer),
      daemonSessionId: "minimal-daemon",
    });
    const positionalPool = new DevicePool(makeSessionManager(positionalTimer), "minimal-daemon");

    await Promise.all([
      factoryPool.initializeWithDevices([]),
      positionalPool.initializeWithDevices([]),
    ]);

    expect(factoryPool.getTotalDeviceCount()).toBe(positionalPool.getTotalDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(positionalPool.getAvailableDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(0);
  });

  test("matches the positional constructor with all dependencies specified", async () => {
    const timer = new FakeTimer();
    const sessionManager = makeSessionManager(timer);
    const installedAppsRepository = new FakeInstalledAppsRepository();
    const deviceManager = new FakeDeviceManager();
    const retryExecutor = new DefaultRetryExecutor(timer);
    const deviceSessionRepository = {
      markAutolockSession: async () => {},
    };
    const criteriaMatcher = new DeviceCriteriaMatcher();
    const releaseSessionForDisconnectedDevice = async () => true;
    const onDeviceReady = (_deviceId: string): void => {};
    const androidDeviceReboot: AndroidDeviceReboot = {
      run: async (_target, reboot) => {
        await reboot();
        return true;
      },
      clear: (_target) => {},
    };
    const recoveryPolicy: DeviceRecoveryPolicy = {
      onLoss: true,
      maxAttempts: 2,
    };
    const onDeviceRemoved = (_deviceId: string, _platform: "android" | "ios"): void => {};
    const emulatorLossIncidentStore = new InMemoryEmulatorLossIncidentStore(timer);
    const cancelDeviceSessionExecutions = async () => 0;
    const idGenerator = new CountingIdGenerator("create-test");
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const consoleBusyRegistry = new FakeEmulatorConsoleBusyRegistry();
    const deps: DevicePoolDependencies = {
      sessionManager,
      daemonSessionId: "full-daemon",
      timer,
      installedAppsRepository,
      deviceManager,
      retryExecutor,
      deviceSessionRepository,
      criteriaMatcher,
      releaseSessionForDisconnectedDevice,
      onDeviceReady,
      androidDeviceReboot,
      recoveryPolicy,
      onDeviceRemoved,
      emulatorLossIncidentStore,
      cancelDeviceSessionExecutions,
      idGenerator,
      lifecycleCoordinator,
      consoleBusyRegistry,
      deviceSessionContinuityEnabled: false,
    };
    const factoryPool = DevicePool.create(deps);
    const positionalPool = new DevicePool(
      deps.sessionManager,
      deps.daemonSessionId,
      deps.timer,
      deps.installedAppsRepository,
      deps.deviceManager,
      deps.retryExecutor,
      deps.deviceSessionRepository,
      deps.criteriaMatcher,
      deps.releaseSessionForDisconnectedDevice,
      deps.onDeviceReady,
      deps.androidDeviceReboot,
      deps.recoveryPolicy,
      deps.onDeviceRemoved,
      deps.emulatorLossIncidentStore,
      deps.cancelDeviceSessionExecutions,
      deps.idGenerator,
      deps.lifecycleCoordinator,
      deps.consoleBusyRegistry,
      deps.deviceSessionContinuityEnabled,
    );
    const factoryInternals = factoryPool as unknown as {
      timer: FakeTimer;
      installedAppsRepository: FakeInstalledAppsRepository;
      deviceManager: FakeDeviceManager;
      retryExecutor: DefaultRetryExecutor;
      criteriaMatcher: DeviceCriteriaMatcher;
      onDeviceReady: typeof onDeviceReady;
    };
    const positionalInternals = positionalPool as unknown as typeof factoryInternals;

    expect(factoryInternals.timer).toBe(deps.timer);
    expect(factoryInternals.installedAppsRepository).toBe(deps.installedAppsRepository);
    expect(factoryInternals.deviceManager).toBe(deps.deviceManager);
    expect(factoryInternals.retryExecutor).toBe(deps.retryExecutor);
    expect(factoryInternals.criteriaMatcher).toBe(deps.criteriaMatcher);
    expect(factoryInternals.onDeviceReady).toBe(deps.onDeviceReady);
    expect(positionalInternals.timer).toBe(factoryInternals.timer);
    expect(positionalInternals.installedAppsRepository).toBe(
      factoryInternals.installedAppsRepository,
    );
    expect(positionalInternals.deviceManager).toBe(factoryInternals.deviceManager);
    expect(positionalInternals.retryExecutor).toBe(factoryInternals.retryExecutor);
    expect(positionalInternals.criteriaMatcher).toBe(factoryInternals.criteriaMatcher);
    expect(positionalInternals.onDeviceReady).toBe(factoryInternals.onDeviceReady);

    await Promise.all([
      factoryPool.initializeWithDevices([bootedDevice]),
      positionalPool.initializeWithDevices([bootedDevice]),
    ]);

    expect(factoryPool.getTotalDeviceCount()).toBe(positionalPool.getTotalDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(positionalPool.getAvailableDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(1);
    expect(factoryPool.getErrorDevices()).toEqual(positionalPool.getErrorDevices());
  });
});
