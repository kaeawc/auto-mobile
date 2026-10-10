import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test";
import { createDaemonManagedSlotAcquisition } from "../../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import type { ManagedSlotAcquisitionSessions } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import { SlotJournalInFlight } from "../../../src/daemon/managedSlots/slotJournal";
import { DaemonState } from "../../../src/daemon/daemonState";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../src/devices/virtualDeviceLifecycleCoordinator";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import type { AndroidCapacitySample } from "../../../src/features/bootAdmission/AndroidCapacitySource";
import { assertBootCapacityAvailable } from "../../../src/features/bootAdmission/sharedBootAdmissionGates";
import type { DeviceInfo } from "../../../src/models";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import type { Platform } from "../../../src/models/Platform";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
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
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../../fakes/FakeVideoRecordingRepository";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import { warmedTests } from "../../helpers/warmedTests";

// The daemon's production wiring (`createDaemonManagedSlotAcquisition`) over the REAL provisionDevice
// handler, the REAL deleteDevice workflow and the REAL Android boot admission gate, with fakes only
// for the host tooling (device manager, AVD config, SDK image list, adb/ps capacity sample).
// docs/using/managed-slots.md: a boot at the limit fails at once with retryable `capacity_exhausted`
// and an unknown count never fails open; a replacement must learn that BEFORE deleting the device it
// could not replace.

isolateToolRegistry();

const RUNTIME = "system-images;android-36;google_apis;x86_64";
const OLD_AVD = "amslot-old-0-g1-a";
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };
const EXTERNAL_EMULATOR = "emulator-5556";
const HOST = { totalMemoryBytes: 64 * 1024 ** 3, cpuCount: 16 };

const AT_LIMIT: AndroidCapacitySample = {
  emulatorSerials: [EXTERNAL_EMULATOR],
  emulatorProcessRssBytes: [2 * 1024 ** 3],
  host: HOST,
  errors: [],
};
const UNKNOWN_COUNT: AndroidCapacitySample = {
  emulatorSerials: [],
  host: HOST,
  errors: ["adb: daemon not running", "ps: unavailable"],
  serialListingFailed: true,
};

function stoppedAvd(name: string, deviceType: string): DeviceInfo {
  return { name, platform: "android", isRunning: false, runtimeId: RUNTIME, deviceType };
}

class NoSessions implements ManagedSlotAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}

describe("daemon managed-slot wiring: replacing a slot's device against boot capacity", () => {
  let timer: FakeTimer;
  let deviceManager: FakeDeviceUtils;
  let registry: FakeSlotRegistry;
  let sample: AndroidCapacitySample;
  let created: string[];
  let checkBootCapacity: (platform: Platform, signal?: AbortSignal) => Promise<void>;
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
    deviceManager.setDeviceImages("android", [stoppedAvd(OLD_AVD, "pixel_8")]);
    sample = AT_LIMIT;
    created = [];
    // The process-wide gate the provision path and the reconciler both consult in production.
    const gate = new AndroidBootAdmissionGate({ sample: async () => sample }, timer, {
      env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "1" },
    });
    checkBootCapacity = (platform, signal) =>
      assertBootCapacityAvailable(platform, { signal }, { android: gate, ios: undefined });
    const resourceObserver = new FakeDeviceResourceObserver();
    setDeviceToolsDependencies({
      env,
      timer,
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      deviceResourceObserverFactory: () => resourceObserver,
      deviceManagerFactory: () => deviceManager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      checkBootCapacity,
      // The order of DefaultExactDeviceProvisioner for an absent device: capacity, then create.
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          await request.assertCapacityBeforeCreate?.(request.signal);
          request.onBeforeCreate?.();
          created.push(request.name);
          const device = stoppedAvd(request.name, request.spec.deviceType);
          deviceManager.setDeviceImages("android", [
            ...(await deviceManager.listDeviceImages("android")),
            device,
          ]);
          return {
            created: true,
            device,
            resolvedSpec: {
              ...request.spec,
              displayCutout: classifyDisplayCutout("android", request.spec.deviceType),
            } as never,
          };
        },
      }),
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    registerDeviceTools();

    registry = new FakeSlotRegistry(timer);
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await registry.initSlot(key, {
      role: "app",
      platform: "android",
      requestedSpec: { runtime: RUNTIME, deviceType: "pixel_8" },
    });
    const bound = await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: OLD_AVD,
        deviceName: OLD_AVD,
        resolvedSpec: { runtime: RUNTIME, deviceType: "pixel_8", displayCutout: "unknown" },
        specFingerprint: "v1:old",
        state: "ready",
      },
    );
    if (bound.kind !== "committed") {
      throw new Error(`binding not committed: ${bound.kind}`);
    }
    return key;
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

  /** Acquire slot 0 with a spec its stopped device (a pixel_8) does not satisfy. */
  async function acquireReplacement() {
    const { acquisition } = createDaemonManagedSlotAcquisition({
      registry: async () => registry,
      sessions: new NoSessions(),
      pool: { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} },
      owner: () => ({ daemonId: "daemon-1", pid: 1 }),
      timer,
      journal: {
        owner: { daemonId: "daemon-1", pid: 1, processGeneration: "gen-1" },
        inFlight: new SlotJournalInFlight(),
      },
      tooling: {
        deviceManager,
        androidConfigReader: {
          readConfig: async (name) => ({
            systemImagePackage: RUNTIME,
            deviceName: name === OLD_AVD ? "pixel_8" : "pixel_9",
          }),
        },
        androidImageCatalog: { listInstalledPackages: async () => [RUNTIME] },
        checkBootCapacity,
      },
    });
    const config = parseManagedSlotConfig({
      contractVersion: 1,
      ...SCOPE,
      localSlotCapacity: 1,
      requests: [
        {
          slotIndex: 0,
          role: "app",
          platform: "android",
          requestedSpec: { runtime: RUNTIME, deviceType: "pixel_9" },
        },
      ],
    });
    const result = await acquisition.acquire(config, { livenessOwnerToken: "token" });
    const scopeKey = result.scope.scopeKey!;
    return {
      result,
      assignment: await registry.getAssignment({ scopeKey, slotIndex: 0 }),
      avds: (await deviceManager.listDeviceImages("android")).map((device) => device.name),
    };
  }

  test("at the boot limit it refuses capacity_exhausted and keeps the slot's device", async () => {
    const { result, assignment, avds } = await acquireReplacement();

    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
      capacity: { limit: 1, booted: 1, retryAfterMs: 5_000, externalDevices: [EXTERNAL_EMULATOR] },
    });
    expect(avds).toEqual([OLD_AVD]);
    expect(created).toEqual([]);
    expect(assignment).toMatchObject({ stableDeviceId: OLD_AVD, generation: 1, state: "ready" });
  });

  test("with a free boot slot the old device is deleted and its replacement created", async () => {
    sample = { emulatorSerials: [], emulatorProcessRssBytes: [], host: HOST, errors: [] };

    const { result, assignment, avds } = await acquireReplacement();

    expect(result.outcome).toBe("ready");
    expect(result.slots[0]).toMatchObject({ disposition: "replaced" });
    expect(avds).toEqual(created);
    expect(created).toHaveLength(1);
    expect(assignment).toMatchObject({ stableDeviceId: created[0], state: "ready" });
  });

  test("with an unknown booted count it refuses discovery_incomplete and keeps the slot's device", async () => {
    sample = UNKNOWN_COUNT;

    const { result, assignment, avds } = await acquireReplacement();

    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ code: "discovery_incomplete", retryable: true });
    expect(avds).toEqual([OLD_AVD]);
    expect(created).toEqual([]);
    expect(assignment).toMatchObject({ stableDeviceId: OLD_AVD, generation: 1, state: "ready" });
  });
});
