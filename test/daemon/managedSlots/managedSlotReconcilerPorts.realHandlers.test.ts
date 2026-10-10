import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test";
import { defaultManagedSlotToolInvoker } from "../../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import { ToolManagedSlotProvisioner } from "../../../src/daemon/managedSlots/managedSlotReconcilerPorts";
import { DaemonState } from "../../../src/daemon/daemonState";
import type { ExactProvisionedDevice } from "../../../src/devices/exactDeviceProvisioning";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../src/devices/virtualDeviceLifecycleCoordinator";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { WorkflowManagedSlotDeviceDeleter } from "../../../src/server/managedSlotDeviceDeleter";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../../src/server/videoRecordingManager";
import { classifyDisplayCutout } from "../../../src/utils/displayCutout";
import { resetProvisionedDeviceTransportFenceForTests } from "../../../src/utils/provisionedDeviceTransportFence";
import { FakeDeviceResourceObserver } from "../../fakes/FakeDeviceResourceObserver";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { warmedTests } from "../../helpers/warmedTests";

// #11266: the managed-slot reconciler ports drive the REAL provisionDevice handler through
// `ToolRegistry.callInternal` (which stamps `__internalNoDiff`) and the REAL deleteDevice workflow,
// over a fake platform. The unit tests of the ports inject a fake invoker, which is how a strict
// re-parse rejecting the internal marker shipped with every acquisition failing.

isolateToolRegistry();

const AVD = "amslot-test-0-g1-a";
const SPEC = {
  runtime: "system-images;android-36;google_apis;x86_64",
  deviceType: "pixel_9",
};

function provisionedAvd(): ExactProvisionedDevice {
  return {
    created: true,
    device: {
      name: AVD,
      platform: "android",
      isRunning: false,
      runtime: SPEC.runtime,
      deviceType: SPEC.deviceType,
    },
    resolvedSpec: { ...SPEC, displayCutout: classifyDisplayCutout("android", SPEC.deviceType) },
  };
}

/** Boot resolves to emulator-5554; a kill drops it from the booted list. */
function fakeAndroidPlatform(manager: FakeDeviceUtils): void {
  let exitListener: (() => void) | undefined;
  const processHandle: any = {
    exitCode: null,
    signalCode: null,
    once: (event: string, listener: () => void) => {
      if (event === "exit") {
        exitListener = listener;
      }
      return processHandle;
    },
    kill: () => {
      processHandle.exitCode = 0;
      manager.setBootedDevices("android", []);
      exitListener?.();
      return true;
    },
  };
  manager.setMockChildProcess(AVD, processHandle);
  const waitForDeviceReady = manager.waitForDeviceReady.bind(manager);
  manager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
    const booted = await waitForDeviceReady(device, timeoutMs, childProcess, signal);
    const resolved = { ...booted, deviceId: "emulator-5554" };
    manager.setBootedDevices("android", [resolved]);
    return resolved;
  };
  const killDevice = manager.killDevice.bind(manager);
  manager.killDevice = async (device) => {
    await killDevice(device);
    manager.setBootedDevices("android", []);
  };
}

describe("managed-slot reconciler ports over the real device tool handlers", () => {
  let timer: FakeTimer;
  let deviceManager: FakeDeviceUtils;
  let restorePipelineOverrides: (() => void) | undefined;

  const setup = async () => {
    // Teardown lists active recordings; keep that read off getDatabase().
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    deviceManager = new FakeDeviceUtils();
    fakeAndroidPlatform(deviceManager);
    const resourceObserver = new FakeDeviceResourceObserver();
    resourceObserver.result.resources.wallpaperRendering = {
      state: "unknown",
      reason: "Not verified in fake",
    };
    setDeviceToolsDependencies({
      env,
      timer,
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      deviceResourceObserverFactory: () => resourceObserver,
      deviceManagerFactory: () => deviceManager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          const provisioned = provisionedAvd();
          deviceManager.setDeviceImages("android", [provisioned.device]);
          return provisioned;
        },
      }),
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    registerDeviceTools();
  };

  const cleanup = () => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    resetDeviceToolsDependencies();
    resetProvisionedDeviceTransportFenceForTests();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
  };

  const reset = async () => {
    cleanup();
    await setup();
  };
  const test = warmedTests(reset);
  beforeEach(reset);
  afterEach(cleanup);
  afterAll(cleanup);

  test("creates through the internal-call seam, then deletes and verifies absence", async () => {
    const provisioner = new ToolManagedSlotProvisioner({
      invokeTool: defaultManagedSlotToolInvoker,
      deviceManager,
      androidConfigReader: { readConfig: async () => null },
      timer,
      releaseSession: async () => {},
    });

    const provisioned = await provisioner.provision({
      platform: "android",
      name: AVD,
      spec: SPEC,
      mode: "create",
      deadlineMs: timer.now() + 120_000,
    });

    expect(provisioned).toMatchObject({
      device: { stableId: AVD, transportId: "emulator-5554", name: AVD },
      created: true,
      readiness: { mode: "automation", status: "automation_ready" },
    });

    const deleted = await new WorkflowManagedSlotDeviceDeleter(timer).deleteAndVerifyAbsence({
      platform: "android",
      stableId: provisioned.device.stableId,
      name: provisioned.device.name,
      deadlineMs: timer.now() + 60_000,
    });

    expect(deleted.kind).toBe("absent");
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
  });
});
