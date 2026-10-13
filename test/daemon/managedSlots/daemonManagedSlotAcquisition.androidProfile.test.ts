import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createDaemonManagedSlotAcquisition } from "../../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import type { ManagedSlotAcquisitionSessions } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import { SlotJournalInFlight } from "../../../src/daemon/managedSlots/slotJournal";
import type { DeviceInfo } from "../../../src/models";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import { WorkflowManagedSlotDeviceDeleter } from "../../../src/server/managedSlotDeviceDeleter";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

const RUNTIME = "system-images;android-36;google_apis;x86_64";
const OLD = "usable-avd";
const UNKNOWN = "this_profile_does_not_exist";
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};

class NoSessions implements ManagedSlotAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}

async function harness(assigned = true) {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer);
  const images: DeviceInfo[] = assigned
    ? [{ name: OLD, platform: "android", isRunning: false }]
    : [];
  const key = assigned ? await assignManagedSlotDevice(registry, "android", OLD) : undefined;
  const before = key ? await registry.getAssignment(key) : null;
  const deleted = spyOn(
    WorkflowManagedSlotDeviceDeleter.prototype,
    "deleteAndVerifyAbsence",
  ).mockImplementation(async (target) => {
    const index = images.findIndex((image) => image.name === target.stableId);
    if (index >= 0) {
      images.splice(index, 1);
    }
    return { kind: "absent" };
  });
  const journal = spyOn(registry, "openSlotJournal");
  const provisioned: Array<{ name: string; spec: { deviceType: string } }> = [];
  let reads = 0;
  let unreadable = false;
  const androidProfileCatalog = {
    listProfileIds: async () => {
      reads += 1;
      if (unreadable) {
        throw new Error("catalog offline");
      }
      return ["pixel_9"];
    },
  };
  const { acquisition } = createDaemonManagedSlotAcquisition({
    registry: async () => registry,
    sessions: new NoSessions(),
    pool: {
      getAllDevices: () => [],
      assertNotClaimedByForeignDaemon: async () => {},
      isUnderShutdownReservation: () => false,
      isDeviceLeasedForAndroidStartup: () => false,
      restartReservationExclusions: () => ({
        names: new Set<string>(),
        ids: new Set<string>(),
        resumeTargets: [],
      }),
    },
    owner: () => ({ daemonId: "daemon", pid: 1 }),
    timer,
    journal: {
      owner: { daemonId: "daemon", pid: 1, processGeneration: "gen-1" },
      inFlight: new SlotJournalInFlight(),
    },
    invokeTool: async (_name, args) => {
      const device = args.device as { name: string; spec: { deviceType: string } };
      provisioned.push(device);
      const created = !images.some((image) => image.name === device.name);
      if (created) {
        images.push({ name: device.name, platform: "android", isRunning: true });
      }
      return {
        structuredContent: {
          created,
          sessionId: "session-1",
          device: {
            name: device.name,
            identity: { stableId: device.name },
            runtime: { deviceId: "fake-transport" },
          },
          readiness: { mode: "automation", status: "automation_ready" },
        },
      };
    },
    tooling: {
      deviceManager: { listDeviceImages: async () => images },
      androidConfigReader: {
        readConfig: async () => ({
          systemImagePackage: RUNTIME,
          apiLevel: 36,
          tag: "google_apis",
          architecture: "x86_64",
          deviceName: "pixel_8",
        }),
      },
      androidImageCatalog: { listInstalledPackages: async () => [RUNTIME] },
      androidProfileCatalog,
      checkBootCapacity: async () => {},
    },
  });
  const acquire = (deviceType?: string) =>
    acquisition.acquire(
      parseManagedSlotConfig({
        contractVersion: 1,
        ...SCOPE,
        localSlotCapacity: 1,
        requests: [
          {
            slotIndex: 0,
            role: "primary",
            platform: "android",
            requestedSpec: { runtime: RUNTIME, ...(deviceType ? { deviceType } : {}) },
          },
        ],
      }),
      { livenessOwnerToken: "token" },
    );
  const expectIntact = async () => {
    expect(deleted).not.toHaveBeenCalled();
    expect(journal).not.toHaveBeenCalled();
    expect(provisioned).toEqual([]);
    expect(images.map((image) => image.name)).toEqual([OLD]);
    expect(await registry.getAssignment(key!)).toEqual(before);
  };
  return {
    acquire,
    expectIntact,
    deleted,
    journal,
    provisioned,
    reads: () => reads,
    unreadable: () => {
      unreadable = true;
    },
  };
}

describe("daemon acquisition validates Android creation profiles", () => {
  afterEach(() => mock.restore());

  test("unsupported explicit profile refuses acquisition and preserves the assigned AVD", async () => {
    const h = await harness();
    const result = await h.acquire(UNKNOWN);
    expect(result.failure).toMatchObject({ code: "spec_unsupported", retryable: false });
    expect(h.reads()).toBe(1);
    await h.expectIntact();
  });

  test("valid installed profile still replaces through production composition", async () => {
    const h = await harness();
    const result = await h.acquire("pixel_9");
    expect(result.failure).toBeUndefined();
    expect(result.slots[0]).toMatchObject({ disposition: "replaced" });
    expect(h.deleted).toHaveBeenCalledTimes(1);
    expect(h.provisioned).toHaveLength(1);
    expect(h.provisioned[0]?.spec.deviceType).toBe("pixel_9");
    expect(h.reads()).toBe(1);
  });

  test("omitted model refuses creation when the production default is absent", async () => {
    const h = await harness(false);
    const result = await h.acquire();
    expect(result.failure).toMatchObject({ code: "spec_unsupported", retryable: false });
    expect(h.journal).not.toHaveBeenCalled();
    expect(h.provisioned).toEqual([]);
  });

  test("omitted-model reuse ignores an absent production default and unreadable catalog", async () => {
    const h = await harness();
    h.unreadable();
    const result = await h.acquire();
    expect(result.failure).toBeUndefined();
    expect(result.slots[0]).toMatchObject({ disposition: "reused" });
    expect(h.reads()).toBe(0);
    expect(h.deleted).not.toHaveBeenCalled();
  });

  test("unreadable catalog refuses replacement through production composition", async () => {
    const h = await harness();
    h.unreadable();
    const result = await h.acquire("pixel_9");
    expect(result.failure).toMatchObject({ code: "discovery_incomplete", retryable: true });
    await h.expectIntact();
  });
});
