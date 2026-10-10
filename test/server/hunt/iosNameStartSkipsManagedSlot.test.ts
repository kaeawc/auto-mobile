import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { RegistryManagedSlotExclusion } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import type { DeviceInfo } from "../../../src/models";
import { clearDirectSessionDevices } from "../../../src/server/directSessionDeviceRegistry";
import { setDeviceManager } from "../../../src/server/bootedDeviceResources";
import { DefaultDeviceMatcher } from "../../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { assignManagedSlotDevice } from "../../daemon/managedSlots/managedSlotFixtures";

isolateToolRegistry();

// Hunt (provisioning-concurrency-4, cell 3): a NAME on iOS is a selector, not an identity —
// simulator display names are not unique. `startMatchExclusions` hands the boot the managed
// slots' UDIDs so a selector-based start skips them (#11174), but the lifecycle-lease resolution
// that runs first matches the name against EVERY image and refuses outright when its best match
// happens to be the slot's simulator.

const SLOT_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
const FREE_UDID = "BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB";

const simulator = (deviceId: string, osVersion: string): DeviceInfo => ({
  name: "iPhone 16",
  platform: "ios",
  deviceId,
  isRunning: false,
  source: "local",
  osVersion,
  iosVersion: osVersion,
  formFactor: "phone",
});

describe("startDevice by iOS name with a managed-slot simulator of the same name", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: FakeDeviceUtils;
  let registry: FakeSlotRegistry;

  beforeEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    timer = new FakeTimer();
    devices = new FakeDeviceUtils();
    registry = new FakeSlotRegistry(timer);
    const idGenerator = new CountingIdGenerator("hunt-ios-name");
    setDeviceToolsDependencies({
      env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" },
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-ios-name-daemon", {
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer.reset();
  });

  const startByName = async (): Promise<Record<string, any>> => {
    const result = await ToolRegistry.getTool("startDevice")!.handler({
      platform: "ios",
      name: "iPhone 16",
    });
    return JSON.parse((result as any).content[0].text);
  };

  // Control: the boot's own exclusion works when the slot's simulator is not the matcher's pick.
  test("boots the free simulator when the slot holds the older one", async () => {
    await assignManagedSlotDevice(registry, "ios", SLOT_UDID);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("ios", [simulator(SLOT_UDID, "18.0"), simulator(FREE_UDID, "18.2")]);

    const result = await startByName();

    expect(result.runtime.deviceId).toBe(FREE_UDID);
  });

  test("boots the free simulator when the slot holds the newer one", async () => {
    await assignManagedSlotDevice(registry, "ios", SLOT_UDID);
    devices.setBootedDevices("ios", []);
    // Same request, same inventory; only which of the two same-named simulators the slot holds
    // differs. LATEST matching makes the slot's simulator the lifecycle-target pick.
    devices.setDeviceImages("ios", [simulator(SLOT_UDID, "18.2"), simulator(FREE_UDID, "18.0")]);

    const outcome = await startByName().catch((error: unknown) => error);

    expect((outcome as { code?: string }).code).not.toBe(DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE);
    expect(outcome).not.toBeInstanceOf(Error);
    expect((outcome as Record<string, any>).runtime.deviceId).toBe(FREE_UDID);
    expect(
      devices.getExecutedOperations().filter((operation) => operation.startsWith("startDevice:")),
    ).toEqual([expect.stringContaining("iPhone 16")]);
  });
});
