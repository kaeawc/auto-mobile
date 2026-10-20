import { describe, expect, test } from "bun:test";
import { GateBindingBootCapacity } from "../../../../src/daemon/sessionBroker/provisioning/GateBindingBootCapacity";
import {
  BrokerDeviceAcquisition,
  type BrokerDeviceAcquisitionSessions,
} from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { provisionErrorFromPayload } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { IosSimCapacityGate } from "../../../../src/features/iosSimFleet/CapacityGate";
import { IosSimFleetCostCollector } from "../../../../src/features/iosSimFleet/FleetCostCollector";
import { InMemoryBootDurationHistory } from "../../../../src/features/iosSimFleet/BootDurationHistory";
import { provisionDeviceErrorResponse } from "../../../../src/server/provisioning/provisioningErrors";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeFleetHostSource } from "../../../fakes/FakeFleetHostSource";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { buildBrokerProvisionRequest } from "../../../helpers/provisionRequestFixture";
import { requireRecord, resultJson } from "../../helpers/refusalWireReaders";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const SCOPE = { managedHostScope: "host", runnerNamespace: "ns", runnerIncarnation: "inc" };

class NoSessions implements BrokerDeviceAcquisitionSessions {
  async claimLivenessOwnership(): Promise<"claimed"> {
    return "claimed";
  }
  async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
  async releaseSession(): Promise<void> {}
}

async function setup() {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const deleter = new FakeDeleter(inventory);
  const source = new FakeFleetHostSource();
  let refreshes = 0;
  let snapshot = new Set<string>();
  const gate = new IosSimCapacityGate(
    new IosSimFleetCostCollector(source, new InMemoryBootDurationHistory(), timer),
    timer,
    {
      env: { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "2" },
      ownership: {
        refresh: async () => {
          refreshes += 1;
          snapshot = new Set(["HELD", ...inventory.devices.map((device) => device.deviceId ?? "")]);
        },
        isAutoMobileOwned: (udid) => snapshot.has(udid),
      },
    },
  );
  const capacity = new GateBindingBootCapacity(
    timer,
    (_platform, signal) => gate.assertCapacityAvailable({ signal }),
    (_platform, options) => gate.reserveBoot(options),
  );
  const reconciler = new BindingReconciler({
    registry,
    inventory,
    provisioner,
    deleter,
    capacity,
    claims: new FakeClaims(),
    matcher: new FakeMatcher(),
    resolver: new DefaultManagedSpecResolver(),
    timer,
    idGenerator: new FakeIdGenerator(),
    isExecOwnerLive: () => true,
  });
  const acquisition = new BrokerDeviceAcquisition({
    registry: async () => registry,
    reconcile: (_registry, request) => reconciler.reconcile(request),
    sessions: new NoSessions(),
    owner: () => ({ daemonId: "daemon", pid: 1 }),
    timer,
  });
  const acquire = (deviceType = SPEC.deviceType) =>
    acquisition.acquire(
      buildBrokerProvisionRequest({
        contractVersion: 1,
        ...SCOPE,
        localBindingCapacity: 1,
        requests: [
          { bindingIndex: 0, role: "app", platform: "ios", requestedSpec: { ...SPEC, deviceType } },
        ],
      }),
      { livenessOwnerToken: "token" },
    );
  return { acquire, registry, source, inventory, provisioner, deleter, refreshes: () => refreshes };
}

describe("iOS binding refusal ownership end to end", () => {
  for (const path of ["precheck", "reservation"] as const) {
    test(`${path} preserves held and foreign UDIDs through acquisition and provisioning payloads`, async () => {
      const h = await setup();
      if (path === "reservation") {
        const seeded = await h.acquire("com.apple.CoreSimulator.SimDeviceType.iPhone-15");
        expect(seeded.outcome).toBe("ready");
        await h.registry.releaseExecution(
          { scopeKey: seeded.scope.scopeKey!, bindingIndex: 0 },
          seeded.bindings[0].sessionUuid!,
        );
      }
      const old = h.inventory.devices[0]?.deviceId;
      h.source.inventory = [...(old ? [old] : []), "HELD", "FOREIGN"].map((udid) => ({
        udid,
        name: udid,
        state: "Booted",
        runtime: SPEC.runtime,
        isAvailable: true,
      }));
      const reads = h.refreshes();
      const result = await h.acquire();
      expect(result.outcome).toBe("failed");
      const expected = {
        limit: 2,
        booted: 2,
        retryAfterMs: 5_000,
        externalDevices: ["FOREIGN"],
        heldDevices: ["HELD"],
      };
      expect(result.failure).toMatchObject({ code: "capacity_exhausted", capacity: expected });
      expect(result.bindings[0].failure?.capacity).toEqual(expected);
      expect(h.refreshes()).toBe(reads + 1);
      expect(h.deleter.calls).toHaveLength(0);
      expect(h.provisioner.calls).toHaveLength(path === "reservation" ? 1 : 0);
      // Acquisition serializes nested capacity; provisionDevice uses flat diagnostic fields.
      const wire = JSON.parse(JSON.stringify(result));
      const error = provisionErrorFromPayload(
        { error: { ...wire.failure, ...wire.failure.capacity } },
        "fallback",
      );
      expect(error.diagnostics.capacity).toEqual({
        limit: 2,
        booted: 2,
        externalDevices: ["FOREIGN"],
        heldDevices: ["HELD"],
      });
      expect(
        requireRecord(resultJson(provisionDeviceErrorResponse(error)), "provision payload").error,
      ).toMatchObject({
        code: "capacity_exhausted",
        retryable: true,
        ...expected,
      });
    });
  }
});
