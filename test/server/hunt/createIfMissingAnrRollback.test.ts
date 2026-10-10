import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
import {
  setDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  registerDeviceTools,
  startDeviceSchema,
} from "../../../src/server/deviceTools";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDeviceMatcher } from "../../fakes/FakeDeviceMatcher";
import { FakeDeviceCreationGate } from "../../fakes/FakeDeviceCreationGate";
import { FakeDeviceProvisioner } from "../../fakes/FakeDeviceProvisioner";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DaemonState } from "../../../src/daemon/daemonState";
import { SystemUiAnrRecoveryRequiredError } from "../../../src/ctrlProxy/RunnerReadinessService";

import { clearDirectSessionDevices } from "../../../src/server/directSessionDeviceRegistry";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { setDeviceManager } from "../../../src/server/bootedDeviceResources";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../../src/server/videoRecordingManager";

isolateToolRegistry();

describe("hunt: createIfMissing rollback after System UI recovery", () => {
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeMatcher: FakeDeviceMatcher;
  let fakeGate: FakeDeviceCreationGate;
  let fakeProvisioner: FakeDeviceProvisioner;
  let sessionManager: SessionManager;

  beforeEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeMatcher = new FakeDeviceMatcher();
    fakeGate = new FakeDeviceCreationGate(false);
    fakeProvisioner = new FakeDeviceProvisioner();

    // Nothing booted, nothing to match: every run reaches the "no match" branch.
    fakeDeviceUtils.setBootedDevices("ios", []);
    fakeDeviceUtils.setDeviceImages("ios", []);
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", []);
    fakeMatcher.setBootedResult(null);
    fakeMatcher.setImageResult(null);

    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
      deviceMatcherFactory: () => fakeMatcher,
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
      deviceCreationGateFactory: () => fakeGate,
      deviceProvisionerFactory: () => fakeProvisioner,
    });

    const timer = new FakeTimer();
    const idGenerator = new CountingIdGenerator("creation-test");
    setDeviceToolsDependencies({ timer, idGenerator });
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
    setDeviceManager(fakeDeviceUtils);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "creation-test-daemon", {
        timer,
        idGenerator,
        deviceManager: fakeDeviceUtils,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    // Assignment rechecks iOS liveness through the POOL's manager, independently
    // of the tool's discovery manager. FakeDeviceUtils records booted creations.
    DaemonState.getInstance().initialize(
      sessionManager,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
    clearDirectSessionDevices();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    resetVideoRecordingManagerDependencies();
  });

  async function callStartDevice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = ToolRegistry.getTool("startDevice");
    if (!tool) {
      throw new Error("startDevice not registered");
    }
    const result = await tool.handler(args);
    return JSON.parse(
      typeof result === "string" ? result : ((result as any).content?.[0]?.text ?? "{}"),
    );
  }
  /** Teardown dependencies the rollback reaches; without them it falls through to real I/O. */
  async function useFakeTeardown(platform: "android" | "ios"): Promise<void> {
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    setDeviceToolsDependencies({
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      clearInstalledAppsForDevice: async () => {},
    });
    stopKilledDevices(platform);
  }

  function stopKilledDevices(platform: "android" | "ios"): void {
    const originalKillDevice = fakeDeviceUtils.killDevice.bind(fakeDeviceUtils);
    fakeDeviceUtils.killDevice = async (device) => {
      await originalKillDevice(device);
      fakeDeviceUtils.setBootedDevices(platform, []);
    };
  }

  it("deletes the AVD it created when binding fails after a System UI ANR replacement boot", async () => {
    fakeGate.setAllowed(true);
    const created = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    };
    let readinessAttempts = 0;
    setDeviceToolsDependencies({
      deviceProvisionerFactory: () => ({
        provision: async (criteria, _signal, identityHooks) => {
          fakeProvisioner.requests.push(criteria);
          await identityHooks?.reserveBeforeCreate(created);
          fakeDeviceUtils.setDeviceImages("android", [
            { name: created.name, platform: "android", isRunning: false },
          ]);
          await identityHooks?.bindAfterCreate(created);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        readinessAttempts++;
        // The first runner check on the freshly created AVD hits a System UI ANR;
        // the replacement boot of the SAME AVD then passes.
        if (readinessAttempts === 1) {
          throw new SystemUiAnrRecoveryRequiredError("System UI ANR persisted after Wait");
        }
      },
    });
    await useFakeTeardown("android");
    const bind = spyOn(DevicePool.prototype, "bindOrReuseDeviceSession").mockRejectedValue(
      new Error("session bind failed"),
    );

    try {
      await expect(callStartDevice({ platform: "android", createIfMissing: true })).rejects.toThrow(
        /session bind failed/,
      );
    } finally {
      bind.mockRestore();
    }

    expect(readinessAttempts).toBe(2);
    // The AVD was created by THIS call; a failed call must not leave it behind.
    expect(fakeDeviceUtils.getExecutedOperations()).toContain(
      `destroyDevice:android:${created.name}`,
    );
    expect(await fakeDeviceUtils.listDeviceImages("android")).toEqual([]);
  });
});
