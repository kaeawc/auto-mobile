import { afterEach, describe, expect, test } from "bun:test";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  RegistryBindingExclusion,
  runAsBindingReconciler,
} from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { DEVICE_ASSIGNED_TO_BINDING_CODE } from "../../src/daemon/sessionBroker/provisioning/refusal";
import type { DeviceInfo } from "../../src/models";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();

/**
 * #11648 item 2, pinned rather than fixed: provisionDevice names its target under
 * `device.{name,deviceId}`, which startDevice's pre-boot broker-binding check never reads. The exact
 * provisioner's adoption guard (#11174) is what refuses a slot's stopped device before it is
 * booted or prepared, so these run the real provisioner wiring, not a stand-in for it.
 */
describe("provisionDevice naming a binding's stopped device", () => {
  const AVD = "phone-api-36-a";
  const SLOT_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
  const ANDROID_SPEC = {
    runtime: "system-images;android-36;google_apis;x86_64",
    deviceType: "pixel_9",
  };
  const IOS_SPEC = {
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  };

  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: FakeDeviceUtils;
  let registry: FakeBindingRegistry;
  let readinessDeviceIds: string[];
  let existing: DeviceInfo;

  function arrangeHarness(): void {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    timer = new FakeTimer();
    devices = new FakeDeviceUtils();
    registry = new FakeBindingRegistry(timer);
    readinessDeviceIds = [];
    const idGenerator = new CountingIdGenerator("provision-managed");
    setDeviceToolsDependencies({
      env: { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" },
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      checkBootCapacity: async () => {},
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      clearInstalledAppsForDevice: async () => {},
      ensureCtrlProxyReady: async (request) => {
        readinessDeviceIds.push(request.device.deviceId);
      },
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "provision-managed-daemon", {
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  }

  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer.reset();
  });

  const provision = async (device: Record<string, unknown>): Promise<Record<string, any>> => {
    const result = (await ToolRegistry.getTool("provisionDevice")!.handler({
      device,
      boot: true,
      readiness: "automation",
    })) as { content: Array<{ text: string }> };
    return JSON.parse(result.content[0].text);
  };
  const boots = (): string[] =>
    devices.getExecutedOperations().filter((operation) => operation.startsWith("startDevice:"));

  const iosSlotSimulator = (): DeviceInfo => ({
    name: "iPhone 17",
    platform: "ios",
    deviceId: SLOT_UDID,
    isRunning: false,
    source: "local",
    osVersion: "26.0",
    iosVersion: "26.0",
    formFactor: "phone",
    runtime: IOS_SPEC.runtime,
    deviceType: IOS_SPEC.deviceType,
  });

  arranged("Android: refused before the binding's AVD is booted or prepared", async () => {
    await assignBindingDevice(registry, "android", AVD);
    existing = {
      name: AVD,
      platform: "android",
      isRunning: false,
      source: "local",
      osVersion: "16",
      formFactor: "phone",
    };
    devices.setBootedDevices("android", []);
    devices.setDeviceImages("android", [existing]);

    const response = await provision({ platform: "android", name: AVD, spec: ANDROID_SPEC });

    expect(JSON.stringify(response)).toContain(DEVICE_ASSIGNED_TO_BINDING_CODE);
    expect({ boots: boots(), readiness: readinessDeviceIds }).toEqual({ boots: [], readiness: [] });
  });

  arranged("iOS: refused before the binding's simulator is booted or prepared", async () => {
    await assignBindingDevice(registry, "ios", SLOT_UDID);
    existing = iosSlotSimulator();
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("ios", [existing]);

    const response = await provision({ platform: "ios", name: "iPhone 17", spec: IOS_SPEC });

    expect(JSON.stringify(response)).toContain(DEVICE_ASSIGNED_TO_BINDING_CODE);
    expect({ boots: boots(), readiness: readinessDeviceIds }).toEqual({ boots: [], readiness: [] });
  });

  arranged("iOS: the binding's own reconciler still boots and prepares its simulator", async () => {
    const binding = await assignBindingDevice(registry, "ios", SLOT_UDID);
    existing = iosSlotSimulator();
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("ios", [existing]);

    const response = await runAsBindingReconciler(binding, () =>
      provision({ platform: "ios", name: "iPhone 17", spec: IOS_SPEC }),
    );

    expect(JSON.stringify(response)).not.toContain(DEVICE_ASSIGNED_TO_BINDING_CODE);
    expect({ boots: boots().length, readiness: readinessDeviceIds }).toEqual({
      boots: 1,
      readiness: [SLOT_UDID],
    });
  });

  arranged(
    "iOS: another binding's reconciler is refused before the simulator is booted",
    async () => {
      await assignBindingDevice(registry, "ios", SLOT_UDID);
      const other = await assignBindingDevice(
        registry,
        "ios",
        "BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB",
        "runner-b",
      );
      existing = iosSlotSimulator();
      devices.setBootedDevices("ios", []);
      devices.setDeviceImages("ios", [existing]);

      const response = await runAsBindingReconciler(other, () =>
        provision({ platform: "ios", name: "iPhone 17", spec: IOS_SPEC }),
      );

      expect(JSON.stringify(response)).toContain(DEVICE_ASSIGNED_TO_BINDING_CODE);
      expect({ boots: boots(), readiness: readinessDeviceIds }).toEqual({
        boots: [],
        readiness: [],
      });
    },
  );
});
