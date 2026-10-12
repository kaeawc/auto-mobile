import { describe, expect, test } from "bun:test";
import { createDaemonManagedSlotAcquisition } from "../../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import type { ManagedSlotAcquisitionSessions } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import type { ManagedSlotToolInvoker } from "../../../src/daemon/managedSlots/managedSlotReconcilerPorts";
import { SlotJournalInFlight } from "../../../src/daemon/managedSlots/slotJournal";
import { AndroidBootAdmissionGate } from "../../../src/features/bootAdmission/AndroidBootAdmissionGate";
import { assertBootCapacityAvailable } from "../../../src/features/bootAdmission/sharedBootAdmissionGates";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { IosSimCapacityGate } from "../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../src/features/iosSimFleet/FleetCostCollector";
import type { DeviceInfo } from "../../../src/models";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import { FakeAndroidCapacitySource } from "../../fakes/FakeAndroidCapacitySource";
import { FakeFleetHostSource } from "../../fakes/FakeFleetHostSource";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// The daemon's production wiring over the REAL Android and iOS boot gates (fake adb/ps and simctl
// samples), with every platform at its boot limit of one. Booting a device that already exists is
// the provision path's decision, with its own-target exemption, so the slot's own device is handed
// to provisionDevice however the listing reports it; only a device that must be created is refused
// by the reconciler's pre-check. provisionDevice is a recording fake here.

const GIB = 1024 ** 3;
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };
const ANDROID_RUNTIME = "system-images;android-36;google_apis;x86_64";
const IOS_RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const OWN_AVD = "amslot-own-0-g1-a";
const OWN_UDID = "UDID-OWN";
const SPECS = {
  android: { runtime: ANDROID_RUNTIME, deviceType: "pixel_9" },
  ios: { runtime: IOS_RUNTIME, deviceType: IPHONE },
} as const;

class NoSessions implements ManagedSlotAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}

function ownAvd(overrides: Partial<DeviceInfo>): DeviceInfo {
  return { name: OWN_AVD, platform: "android", isRunning: false, ...overrides };
}

function ownSimulator(state: string): DeviceInfo {
  return {
    name: "amslot-own",
    platform: "ios",
    deviceId: OWN_UDID,
    isRunning: state === "Booted",
    state,
    isAvailable: true,
    runtime: IOS_RUNTIME,
    deviceType: IPHONE,
  };
}

interface Host {
  /** Devices the inventory lists. */
  images: DeviceInfo[];
  /** adb serials of running emulators. */
  emulators: string[];
  /** simctl state per simulator UDID. */
  simulators: Record<string, string>;
}

async function harness(
  host: Host,
  bound: { platform: "android" | "ios"; stableId: string } | null,
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const androidSource = new FakeAndroidCapacitySource();
  androidSource.emulatorSerials = host.emulators;
  androidSource.emulatorProcessRssBytes = host.emulators.map(() => 2 * GIB);
  const fleet = new FakeFleetHostSource();
  fleet.snapshot = {
    takenAtMs: 0,
    resources: {
      totalMemoryBytes: 64 * GIB,
      cpuCount: 16,
      freeMemoryBytes: 32 * GIB,
      memoryPressure: "normal",
    },
    processes: [],
  } as never;
  fleet.inventory = Object.entries(host.simulators).map(([udid, state]) => ({
    udid,
    name: udid,
    state,
    runtime: IOS_RUNTIME,
    isAvailable: true,
  }));
  const gates = {
    android: new AndroidBootAdmissionGate(androidSource, timer, {
      env: { AUTOMOBILE_ANDROID_MAX_BOOTED: "1" },
    }),
    ios: new IosSimCapacityGate(
      new IosSimFleetCostCollector(fleet, new InMemoryBootDurationHistory(), timer),
      timer,
      { env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "1" } },
    ),
  };

  const registry = new FakeSlotRegistry(timer);
  const scope = await registry.ensureScope(SCOPE);
  if (scope.kind !== "ready") {
    throw new Error(`scope not ready: ${scope.kind}`);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  if (bound) {
    await registry.initSlot(key, {
      role: "app",
      platform: bound.platform,
      requestedSpec: SPECS[bound.platform],
    });
    const committed = await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: bound.stableId,
        deviceName: bound.stableId,
        resolvedSpec: { ...SPECS[bound.platform], displayCutout: "unknown" },
        specFingerprint: "v1:own",
        state: "ready",
      },
    );
    if (committed.kind !== "committed") {
      throw new Error(`binding not committed: ${committed.kind}`);
    }
  }

  const provisioned: Array<Record<string, unknown>> = [];
  const invokeTool: ManagedSlotToolInvoker = async (_name, args) => {
    const device = args.device as { name: string; deviceId?: string };
    provisioned.push(device);
    const stableId = device.deviceId ?? device.name;
    return {
      structuredContent: {
        created: false,
        sessionId: "session-1",
        device: { name: device.name, identity: { stableId }, runtime: { deviceId: stableId } },
        readiness: { mode: "automation", status: "automation_ready" },
      },
    };
  };
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
    invokeTool,
    tooling: {
      deviceManager: {
        listDeviceImages: async (platform) =>
          host.images.filter((image) => image.platform === platform),
      },
      androidConfigReader: {
        readConfig: async () => ({
          systemImagePackage: ANDROID_RUNTIME,
          apiLevel: 36,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_9",
        }),
      },
      androidImageCatalog: { listInstalledPackages: async () => [ANDROID_RUNTIME] },
      iosRuntimeCatalog: {
        getRuntimesChecked: async () => {
          throw new Error("catalog not scripted");
        },
        getDeviceTypesChecked: async () => {
          throw new Error("catalog not scripted");
        },
      },
      checkBootCapacity: (platform, signal) =>
        assertBootCapacityAvailable(platform, { signal }, gates),
    },
  });
  const acquire = async (platform: "android" | "ios") =>
    await acquisition.acquire(
      parseManagedSlotConfig({
        contractVersion: 1,
        ...SCOPE,
        localSlotCapacity: 1,
        requests: [{ slotIndex: 0, role: "app", platform, requestedSpec: SPECS[platform] }],
      }),
      { livenessOwnerToken: "token" },
    );
  return { acquire, provisioned };
}

describe("daemon managed-slot wiring: the slot's own device at the boot limit", () => {
  test.each([
    ["Booted", ownSimulator("Booted")],
    ["Booting", ownSimulator("Booting")],
  ])("iOS: its own %s simulator is reused, not refused", async (state, simulator) => {
    const { acquire, provisioned } = await harness(
      { images: [simulator], emulators: [], simulators: { [OWN_UDID]: state } },
      { platform: "ios", stableId: OWN_UDID },
    );

    const result = await acquire("ios");

    expect(result.failure).toBeUndefined();
    expect(result.slots[0]).toMatchObject({ disposition: "reused", sessionUuid: "session-1" });
    expect(provisioned).toEqual([expect.objectContaining({ deviceId: OWN_UDID })]);
  });

  test.each([
    ["running", ownAvd({ isRunning: true })],
    ["running with an unknown listed state", ownAvd({ isRunningStateKnown: false })],
  ])("Android: its own %s emulator is reused, not refused", async (_state, avd) => {
    const { acquire, provisioned } = await harness(
      { images: [avd], emulators: ["emulator-5554"], simulators: {} },
      { platform: "android", stableId: OWN_AVD },
    );

    const result = await acquire("android");

    expect(result.failure).toBeUndefined();
    expect(result.slots[0]).toMatchObject({ disposition: "reused", sessionUuid: "session-1" });
    expect(provisioned).toEqual([expect.objectContaining({ name: OWN_AVD })]);
  });

  test("iOS: a device that must be created is refused while another simulator holds the slot", async () => {
    const { acquire, provisioned } = await harness(
      { images: [], emulators: [], simulators: { "UDID-OTHER": "Booting" } },
      null,
    );

    const result = await acquire("ios");

    expect(result.failure).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
      capacity: { limit: 1, booted: 1, externalDevices: ["UDID-OTHER"] },
    });
    expect(provisioned).toEqual([]);
  });

  test("Android: a device that must be created is refused while another emulator holds the slot", async () => {
    const { acquire, provisioned } = await harness(
      { images: [], emulators: ["emulator-5556"], simulators: {} },
      null,
    );

    const result = await acquire("android");

    expect(result.failure).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
      capacity: { limit: 1, booted: 1, externalDevices: ["emulator-5556"] },
    });
    expect(provisioned).toEqual([]);
  });
});
