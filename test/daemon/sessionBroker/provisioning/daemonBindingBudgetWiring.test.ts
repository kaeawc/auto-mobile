import { warmedTests } from "../../../helpers/warmedTests";
import { describe, expect } from "bun:test";
import { createDaemonBrokerDeviceAcquisition } from "../../../../src/daemon/sessionBroker/provisioning/daemonDeviceAcquisition";
import type { BindingResourceBudgetPolicy } from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import { parseSessionBrokerHostConfig } from "../../../../src/daemon/sessionBroker/hostConfig";
import { selectAdmission } from "../../../../src/daemon/sessionBroker/admission";
import { buildBrokerProvisionRequest } from "../../../helpers/provisionRequestFixture";
import { BindingJournalInFlight } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import type { BrokerDeviceAcquisitionSessions } from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import { androidDefaults } from "../../../devices/sessionRequirements/fixtures";
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
function wiring(resourceBudgetPolicy?: BindingResourceBudgetPolicy) {
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
    resourceBudgetPolicy,
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
  const acquire = (runnerNamespace = "new") =>
    handle.acquisition.acquire(
      buildBrokerProvisionRequest({
        contractVersion: 1,
        managedHostScope: "host",
        runnerNamespace,
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
  const test = warmedTests(() => {});
  test.each([undefined, { limit: () => null }])(
    "an absent or unlimited policy %s adds no ledger reads during creation",
    async (policy) => {
      const h = wiring(policy);
      expect((await h.acquire()).outcome).toBe("ready");
      expect(h.reads()).toBe(0);
      expect(h.provisioner.calls).toHaveLength(1);
    },
  );
  test("the injected limit is enforced and budget evidence reaches acquisition", async () => {
    const h = wiring({ limit: () => 1 });
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
  test.each([0, 1, 2, undefined])(
    "broker cap %s also bounds native creation without double charging",
    async (totalDeviceCap) => {
      const config = parseSessionBrokerHostConfig({
        contractVersion: 1,
        limits: { totalDeviceCap },
        defaults: { android: androidDefaults() },
      });
      const h = wiring({ limit: () => config.limits.totalDeviceCap ?? null });
      expect(
        selectAdmission({ activeOrAcquiringSessions: 0, resources: [] }, config.limits).kind,
      ).toBe(totalDeviceCap === 0 ? "refuse" : "create");
      const result = await h.acquire();
      expect(result.outcome).toBe(totalDeviceCap === 0 ? "failed" : "ready");
      expect(h.provisioner.calls).toHaveLength(totalDeviceCap === 0 ? 0 : 1);
      if (totalDeviceCap === 0) {
        expect(result.bindings[0]?.failure).toMatchObject({
          code: "binding_budget_exhausted",
          budget: { limit: 0, usage: { total: 1, preparing: 1 } },
        });
      }
    },
  );
  test("the policy is consulted after wiring, before native creation", async () => {
    let limit: number | null = null;
    const h = wiring({ limit: () => limit });
    expect((await h.acquire()).outcome).toBe("ready");
    limit = 0;
    expect((await h.acquire("another")).outcome).toBe("failed");
    expect(h.provisioner.calls).toHaveLength(1);
  });
  test("native orphans can refuse creation even when broker admission has room", async () => {
    const limits = { totalDeviceCap: 1 };
    const h = wiring({ limit: () => limits.totalDeviceCap });
    h.inventory.devices = [
      { platform: "android", name: "ambroker-orphan-0-g1-nonce", isRunning: false },
    ];
    expect(selectAdmission({ activeOrAcquiringSessions: 0, resources: [] }, limits)).toEqual({
      kind: "create",
    });
    expect(await h.acquire()).toMatchObject({
      outcome: "failed",
      bindings: [
        {
          failure: {
            code: "binding_budget_exhausted",
            budget: { limit: 1, usage: { total: 2, preparing: 1, orphaned: 1 } },
          },
        },
      ],
    });
    expect(h.provisioner.calls).toEqual([]);
    expect(h.deleter.calls).toEqual([]);
  });
});
