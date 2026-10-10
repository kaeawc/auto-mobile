/**
 * Deterministic fixtures for the `listDevices` benchmark (#11332).
 *
 * The handler's real dependencies shell out to adb, `xcrun simctl`/devicectl and `ps`, so a
 * benchmark over them measures the host's tooling (and whether it is installed), not the handler.
 * These fixtures inject the repo's test fakes through the existing `DeviceToolsDependencies` and
 * `PlatformDeviceManagerFactory` seams, so no process is ever spawned and no database is opened.
 *
 * Two scenarios, because the handler does different work with and without a daemon:
 * - standalone: no `DaemonState`, so no `DevicePool` (direct mode, `pool === undefined`).
 * - daemon: `DaemonState` holds a real `DevicePool` over fakes, with one device held by a managed
 *   slot and one driven by another daemon, so `refreshInventoryOwnership` does real work.
 */
import { DaemonState } from "../src/daemon/daemonState";
import { DevicePool } from "../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../src/daemon/foreignDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../src/daemon/sessionManager";
import { AndroidBootAdmissionGate } from "../src/features/bootAdmission/AndroidBootAdmissionGate";
import type { BootedDevice } from "../src/models";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../src/server/deviceTools";
import { PlatformDeviceManagerFactory } from "../src/utils/factories/PlatformDeviceManagerFactory";
import { DefaultRetryExecutor } from "../src/utils/retry/RetryExecutor";
import { assignManagedSlotDevice } from "../test/daemon/managedSlots/managedSlotFixtures";
import { FakeAdbClientFactory } from "../test/fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../test/fakes/FakeAdbExecutor";
import { FakeAndroidCapacitySource } from "../test/fakes/FakeAndroidCapacitySource";
import { FakeDeviceSessionPersistence } from "../test/fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../test/fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../test/fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../test/fakes/FakeSlotRegistry";
import { FakeTimer } from "../test/fakes/FakeTimer";
import { createDevicePoolDependencies } from "../test/helpers/devicePoolDependencies";

export type ListDevicesScenario = "standalone" | "daemon";

const SLOT_DEVICE: BootedDevice = {
  platform: "android",
  name: "Pixel_9_API_36",
  deviceId: "emulator-5554",
  screenWidth: 1080,
  screenHeight: 2400,
};
const FOREIGN_DEVICE: BootedDevice = {
  platform: "android",
  name: "Pixel_8_API_35",
  deviceId: "emulator-5556",
  screenWidth: 1080,
  screenHeight: 2400,
};
const FREE_DEVICE: BootedDevice = {
  platform: "android",
  name: "Pixel_7_API_34",
  deviceId: "emulator-5558",
  screenWidth: 1080,
  screenHeight: 2400,
};
const FOREIGN_OWNER_PID = 4242;

export interface ListDevicesFixture {
  /** Restore the process-wide singletons the fixture replaced. */
  dispose(): void;
}

function installDeviceToolFakes(deviceManager: FakeDeviceUtils): void {
  const capacitySource = new FakeAndroidCapacitySource();
  capacitySource.emulatorSerials = [SLOT_DEVICE.deviceId, FOREIGN_DEVICE.deviceId];
  PlatformDeviceManagerFactory.setInstance(deviceManager);
  setDeviceToolsDependencies({
    deviceManagerFactory: () => deviceManager,
    androidAdbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
    avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
    bootCapacityReporters: {
      android: new AndroidBootAdmissionGate(capacitySource, new FakeTimer(), { env: {} }),
    },
  });
}

export async function installListDevicesFixture(
  scenario: ListDevicesScenario,
): Promise<ListDevicesFixture> {
  const devices = [SLOT_DEVICE, FOREIGN_DEVICE, FREE_DEVICE];
  const deviceManager = new FakeDeviceUtils();
  deviceManager.setBootedDevices("android", devices);
  deviceManager.setBootedDevices("ios", []);
  installDeviceToolFakes(deviceManager);
  if (scenario === "standalone") {
    return { dispose: disposeFixture(undefined) };
  }

  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const registry = new FakeSlotRegistry(timer);
  await assignManagedSlotDevice(registry, "android", SLOT_DEVICE.name);
  const foreignOwnership: ForeignDeviceOwnership = {
    async refresh() {},
    foreignOwnerPid: (deviceId) =>
      deviceId === FOREIGN_DEVICE.deviceId ? FOREIGN_OWNER_PID : undefined,
    claim: async () => true,
    release() {},
  };
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "benchmark-daemon", {
      timer,
      deviceManager,
      retryExecutor: new DefaultRetryExecutor(timer),
      installedAppsRepository: new FakeInstalledAppsRepository(),
      foreignDeviceOwnership: foreignOwnership,
      managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
    }),
  );
  await pool.initializeWithDevices(devices);
  DaemonState.getInstance().initialize(sessions, pool);
  return { dispose: disposeFixture(sessions) };
}

function disposeFixture(sessions: SessionManager | undefined): () => void {
  return () => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    PlatformDeviceManagerFactory.reset();
    resetDeviceToolsDependencies();
  };
}
