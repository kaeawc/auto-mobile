import { warmedTests } from "../../../helpers/warmedTests";
import { describe, expect, spyOn } from "bun:test";
import { createDaemonBrokerDeviceAcquisition } from "../../../../src/daemon/sessionBroker/provisioning/daemonDeviceAcquisition";
import {
  BINDING_MAX_DEVICES_ENV,
  parseBindingMaxDevices,
} from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import { buildBrokerProvisionRequest } from "../../../helpers/provisionRequestFixture";
import { BindingJournalInFlight } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import type { BrokerDeviceAcquisitionSessions } from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import { logger } from "../../../../src/utils/logger";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeInventory, FakeProvisioner, FakeDeleter } from "../registry/fixtures/reconcilerFakes";
import { assignBindingDevice } from "./bindingFixtures";

const SPEC = { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" };
const OWNER = { daemonId: "wire", pid: 101 };
class NoSessions implements BrokerDeviceAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}
function wiring(env: NodeJS.ProcessEnv) {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer, () => false);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const deleter = new FakeDeleter(inventory);
  const reserved = new Set<string>();
  let reads = 0;
  const snapshot = registry.snapshotBindingResources.bind(registry);
  registry.snapshotBindingResources = async () => {
    reads += 1;
    return snapshot();
  };
  const handle = createDaemonBrokerDeviceAcquisition({
    registry: async () => registry,
    env,
    sessions: new NoSessions(),
    owner: () => OWNER,
    timer,
    journal: { owner: OWNER, inFlight: new BindingJournalInFlight() },
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
      buildBrokerProvisionRequest({
        contractVersion: 1,
        managedHostScope: "host",
        runnerNamespace: "new",
        runnerIncarnation: "inc",
        localBindingCapacity: 1,
        requests: [{ bindingIndex: 0, role: "primary", platform: "android", requestedSpec: SPEC }],
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
      const h = wiring(value === undefined ? {} : { [BINDING_MAX_DEVICES_ENV]: value });
      expect((await h.acquire()).outcome).toBe("ready");
      expect(h.reads()).toBe(0);
      expect(h.provisioner.calls).toHaveLength(1);
    },
  );
  test.each(["1.5", "0", "-2", "bad", "9007199254740992", " "])(
    "invalid limit %s warns once and does not enforce",
    async (value) => {
      warn = spyOn(logger, "warn").mockImplementation(() => {});
      const h = wiring({ [BINDING_MAX_DEVICES_ENV]: value });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(BINDING_MAX_DEVICES_ENV);
      expect(warn.mock.calls[0][0]).toContain(JSON.stringify(value));
      expect((await h.acquire()).outcome).toBe("ready");
      expect((await h.acquire()).outcome).toBe("ready");
      expect(h.reads()).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );
  test("a configured limit is read once, enforced and budget evidence reaches acquisition", async () => {
    const env = { [BINDING_MAX_DEVICES_ENV]: "1" };
    const h = wiring(env);
    env[BINDING_MAX_DEVICES_ENV] = "100";
    await assignBindingDevice(h.registry, "android", "amslot-assigned", "assigned");
    expect(await h.acquire()).toMatchObject({
      outcome: "failed",
      bindings: [
        {
          failure: {
            code: "binding_budget_exhausted",
            retryable: true,
            budget: { limit: 1, usage: { assignedIdle: 1, preparing: 1 } },
          },
        },
      ],
    });
    expect(h.provisioner.calls).toEqual([]);
    expect(h.reads()).toBe(2);
  });
  test("positive safe integers are accepted without a warning", () => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    expect(parseBindingMaxDevices({ [BINDING_MAX_DEVICES_ENV]: "12" })).toBe(12);
    expect(warn).not.toHaveBeenCalled();
  });
});
