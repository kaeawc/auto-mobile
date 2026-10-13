import { warmedTests } from "../../helpers/warmedTests";
import { describe, expect, spyOn } from "bun:test";
import { createDaemonManagedSlotAcquisition } from "../../../src/daemon/managedSlots/daemonManagedSlotAcquisition";
import {
  MANAGED_SLOT_MAX_DEVICES_ENV,
  parseManagedSlotMaxDevices,
} from "../../../src/daemon/managedSlots/managedSlotResourceBudget";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import { SlotJournalInFlight } from "../../../src/daemon/managedSlots/slotJournal";
import type { ManagedSlotAcquisitionSessions } from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeInventory, FakeProvisioner, FakeDeleter } from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

const SPEC = { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" };
const OWNER = { daemonId: "wire", pid: 101 };
class NoSessions implements ManagedSlotAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}
function wiring(env: NodeJS.ProcessEnv) {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer, () => false);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const deleter = new FakeDeleter(inventory);
  const reserved = new Set<string>();
  let reads = 0;
  const snapshot = registry.snapshotManagedSlotResources.bind(registry);
  registry.snapshotManagedSlotResources = async () => {
    reads += 1;
    return snapshot();
  };
  const handle = createDaemonManagedSlotAcquisition({
    registry: async () => registry,
    env,
    sessions: new NoSessions(),
    owner: () => OWNER,
    timer,
    journal: { owner: OWNER, inFlight: new SlotJournalInFlight() },
    pool: {
      getAllDevices: () => [],
      assertNotClaimedByForeignDaemon: async () => {},
      isUnderShutdownReservation: () => false,
      isDeviceLeasedForAndroidStartup: () => false,
      restartReservationExclusions: () => ({ names: reserved, ids: reserved, resumeTargets: [] }),
    },
    tooling: {
      deviceManager: {
        listDeviceImages: async (platform) =>
          (await inventory.list(platform as "android" | "ios", {})).devices,
      },
      provisioner,
      deleter,
      checkBootCapacity: async () => {},
      androidImageCatalog: { listInstalledPackages: async () => [SPEC.runtime] },
      androidProfileCatalog: { listProfileIds: async () => [SPEC.deviceType] },
      androidConfigReader: {
        readConfig: async () =>
          ({ deviceName: SPEC.deviceType, systemImagePackage: SPEC.runtime }) as never,
      },
    },
  });
  const acquire = () =>
    handle.acquisition.acquire(
      parseManagedSlotConfig({
        contractVersion: 1,
        managedHostScope: "host",
        runnerNamespace: "new",
        runnerIncarnation: "inc",
        localSlotCapacity: 1,
        requests: [{ slotIndex: 0, role: "primary", platform: "android", requestedSpec: SPEC }],
      }),
      { livenessOwnerToken: "token" },
    );
  return {
    registry,
    timer,
    inventory,
    provisioner,
    deleter,
    reserved,
    handle,
    acquire,
    reads: () => reads,
  };
}

describe("host total-resource limit wiring", () => {
  let warn: ReturnType<typeof spyOn> | undefined;
  const test = warmedTests(() => {
    warn?.mockRestore();
    warn = undefined;
  });
  test.each([undefined, ""])(
    "unset or empty limit %s adds no ledger reads during creation",
    async (value) => {
      const h = wiring(value === undefined ? {} : { [MANAGED_SLOT_MAX_DEVICES_ENV]: value });
      expect((await h.acquire()).outcome).toBe("ready");
      expect(h.reads()).toBe(0);
      expect(h.provisioner.calls).toHaveLength(1);
    },
  );
  test.each(["1.5", "0", "-2", "bad", "9007199254740992", " "])(
    "invalid limit %s warns once and does not enforce",
    async (value) => {
      warn = spyOn(logger, "warn").mockImplementation(() => {});
      const h = wiring({ [MANAGED_SLOT_MAX_DEVICES_ENV]: value });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(MANAGED_SLOT_MAX_DEVICES_ENV);
      expect(warn.mock.calls[0][0]).toContain(JSON.stringify(value));
      expect((await h.acquire()).outcome).toBe("ready");
      expect((await h.acquire()).outcome).toBe("ready");
      expect(h.reads()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
  test("a configured limit is read once, enforced and budget evidence reaches acquisition", async () => {
    const env = { [MANAGED_SLOT_MAX_DEVICES_ENV]: "1" };
    const h = wiring(env);
    env[MANAGED_SLOT_MAX_DEVICES_ENV] = "100";
    await assignManagedSlotDevice(h.registry, "android", "amslot-assigned", "assigned");
    expect(await h.acquire()).toMatchObject({
      outcome: "failed",
      slots: [
        {
          failure: {
            code: "managed_slot_budget_exhausted",
            retryable: true,
            budget: { limit: 1, usage: { assignedIdle: 1, preparing: 1 } },
          },
        },
      ],
    });
    expect(h.provisioner.calls).toEqual([]);
    expect(h.reads()).toBe(2);
  });
  test("unset-limit production journal still redrives marked rows and honors restart reservations", async () => {
    const h = wiring({});
    const key = await assignManagedSlotDevice(h.registry, "android", "amslot-cache", "cache");
    await h.registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await h.registry.completeScopeInvalidation(key.scopeKey);
    const row = (await h.registry.listFreeDevices())[0];
    h.inventory.devices.push({
      platform: "android",
      name: row.stableDeviceId,
      deviceId: row.stableDeviceId,
    });
    await h.registry.beginFreeDeviceDeletion(row, OWNER);
    h.reserved.add(row.stableDeviceId);
    const journal = h.handle.journalFor(h.registry);
    expect((await journal.runPass()).freeDeviceDeletions).toMatchObject([
      { outcome: "blocked", message: "restart recovery reservation" },
    ]);
    expect(h.deleter.calls).toEqual([]);
    h.reserved.clear();
    h.timer.advanceTime(1_000);
    expect((await journal.runPass()).freeDeviceDeletions).toMatchObject([{ outcome: "absent" }]);
    expect(h.deleter.stableIds()).toEqual([row.stableDeviceId]);
  });
  test("positive safe integers are accepted without a warning", () => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    expect(parseManagedSlotMaxDevices({ [MANAGED_SLOT_MAX_DEVICES_ENV]: "12" })).toBe(12);
    expect(warn).not.toHaveBeenCalled();
  });
});
