import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
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

  test("matches the direct constructor with only required dependencies", async () => {
    const factoryTimer = new FakeTimer();
    const directTimer = new FakeTimer();
    const factoryPool = DevicePool.create({
      sessionManager: makeSessionManager(factoryTimer),
      daemonSessionId: "minimal-daemon",
    });
    const directPool = new DevicePool(
      createDevicePoolDependencies(makeSessionManager(directTimer), "minimal-daemon"),
    );

    await Promise.all([
      factoryPool.initializeWithDevices([]),
      directPool.initializeWithDevices([]),
    ]);

    expect(factoryPool.getTotalDeviceCount()).toBe(directPool.getTotalDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(directPool.getAvailableDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(0);
  });

  test("matches the direct constructor with all dependencies specified", async () => {
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
    const directPool = new DevicePool(deps);
    const factoryInternals = factoryPool as unknown as {
      timer: FakeTimer;
      installedAppsRepository: FakeInstalledAppsRepository;
      deviceManager: FakeDeviceManager;
      retryExecutor: DefaultRetryExecutor;
      criteriaMatcher: DeviceCriteriaMatcher;
      onDeviceReady: typeof onDeviceReady;
    };
    const directInternals = directPool as unknown as typeof factoryInternals;

    expect(factoryInternals.timer).toBe(deps.timer);
    expect(factoryInternals.installedAppsRepository).toBe(deps.installedAppsRepository);
    expect(factoryInternals.deviceManager).toBe(deps.deviceManager);
    expect(factoryInternals.retryExecutor).toBe(deps.retryExecutor);
    expect(factoryInternals.criteriaMatcher).toBe(deps.criteriaMatcher);
    expect(factoryInternals.onDeviceReady).toBe(deps.onDeviceReady);
    expect(directInternals.timer).toBe(factoryInternals.timer);
    expect(directInternals.installedAppsRepository).toBe(factoryInternals.installedAppsRepository);
    expect(directInternals.deviceManager).toBe(factoryInternals.deviceManager);
    expect(directInternals.retryExecutor).toBe(factoryInternals.retryExecutor);
    expect(directInternals.criteriaMatcher).toBe(factoryInternals.criteriaMatcher);
    expect(directInternals.onDeviceReady).toBe(factoryInternals.onDeviceReady);

    await Promise.all([
      factoryPool.initializeWithDevices([bootedDevice]),
      directPool.initializeWithDevices([bootedDevice]),
    ]);

    expect(factoryPool.getTotalDeviceCount()).toBe(directPool.getTotalDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(directPool.getAvailableDeviceCount());
    expect(factoryPool.getAvailableDeviceCount()).toBe(1);
    expect(factoryPool.getErrorDevices()).toEqual(directPool.getErrorDevices());
  });
});
