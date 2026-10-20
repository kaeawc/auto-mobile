import { describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  BindingReconciler,
  type BindingReconcileResult,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import {
  ProvisionDeviceError,
  type ExactDeviceSpecification,
} from "../../../../src/devices/exactDeviceProvisioning";
import { BootCapacityExhaustedError } from "../../../../src/models/BootCapacityExhaustedError";
import {
  BrokerDeviceAcquisition,
  type BrokerDeviceAcquisitionSessions,
} from "../../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import { provisionErrorFromPayload } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { buildBrokerProvisionRequest } from "../../../helpers/provisionRequestFixture";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };
const EXTERNAL = ["UDID-XCODE-1"];
const HELD = ["UDID-HELD-1"];

async function setup() {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const capacity = new FakeCapacity();
  const reconciler = new BindingReconciler({
    registry,
    inventory,
    matcher: new FakeMatcher(),
    resolver: new DefaultManagedSpecResolver(),
    provisioner,
    deleter: new FakeDeleter(inventory),
    claims: new FakeClaims(),
    capacity,
    timer,
    idGenerator: new FakeIdGenerator(),
    isExecOwnerLive: () => true,
  });
  const scope = await registry.ensureScope(SCOPE);
  if (scope.kind !== "ready") {
    throw new Error("scope setup failed");
  }
  const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  const reconcile = async (): Promise<BindingReconcileResult> =>
    await reconciler.reconcile({
      key,
      role: "app",
      platform: "ios",
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    });
  return { provisioner, reconcile, capacity, registry, reconciler, timer };
}

// docs/using/environment-variables.md "Boot capacity": the error carries `externalDevices` when counted
// devices were not started by AutoMobile, "including a binding that must create or boot its device".
describe("binding capacity_exhausted keeps externalDevices", () => {
  test("a gate refusal during binding provisioning names the external devices", async () => {
    const { provisioner, reconcile } = await setup();
    provisioner.failWith = () =>
      new BootCapacityExhaustedError(
        {
          platform: "ios",
          limit: 1,
          booted: 1,
          retryAfterMs: 1_000,
          externalDevices: EXTERNAL,
          heldDevices: HELD,
        },
        "full",
      );

    const result = await reconcile();

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" ? result.failure : undefined).toMatchObject({
      code: "capacity_exhausted",
      capacity: { externalDevices: EXTERNAL, heldDevices: HELD },
    });
  });

  test("a typed provision capacity_exhausted refusal names the external devices", async () => {
    const { provisioner, reconcile } = await setup();
    provisioner.failWith = () =>
      new ProvisionDeviceError("capacity_exhausted", "full", true, {
        retryAfterMs: 2_000,
        capacity: { limit: 1, booted: 1, externalDevices: EXTERNAL, heldDevices: HELD },
      });

    const result = await reconcile();

    expect(result.outcome === "failed" ? result.failure : undefined).toMatchObject({
      code: "capacity_exhausted",
      capacity: { externalDevices: EXTERNAL, heldDevices: HELD },
    });
  });

  test("the capacity probe's external and held devices reach the binding failure", async () => {
    const { capacity, reconcile } = await setup();
    capacity.result = {
      kind: "exhausted",
      limit: 1,
      booted: 1,
      retryAfterMs: 3_000,
      externalDevices: EXTERNAL,
      heldDevices: HELD,
    };

    const result = await reconcile();

    expect(result.outcome === "failed" ? result.failure : undefined).toMatchObject({
      code: "capacity_exhausted",
      capacity: {
        limit: 1,
        booted: 1,
        retryAfterMs: 3_000,
        externalDevices: EXTERNAL,
        heldDevices: HELD,
      },
    });
  });

  test("an empty external list is omitted, matching the non-binding refusal", async () => {
    const { provisioner, reconcile } = await setup();
    provisioner.failWith = () =>
      new BootCapacityExhaustedError(
        {
          platform: "ios",
          limit: 1,
          booted: 1,
          retryAfterMs: 1_000,
          externalDevices: [],
          heldDevices: [],
        },
        "full",
      );

    const result = await reconcile();

    const capacity = result.outcome === "failed" ? result.failure.capacity : undefined;
    expect(capacity).toEqual({ limit: 1, booted: 1, retryAfterMs: 1_000 });
  });
});

describe("externalDevices survives the provisionDevice wire payload", () => {
  test("provisionErrorFromPayload rebuilds capacity.externalDevices", () => {
    const error = provisionErrorFromPayload(
      {
        error: {
          code: "capacity_exhausted",
          retryable: true,
          retryAfterMs: 2_000,
          limit: 1,
          booted: 1,
          externalDevices: EXTERNAL,
          heldDevices: HELD,
        },
      },
      "fallback",
    );

    expect(error.diagnostics.capacity).toEqual({
      limit: 1,
      booted: 1,
      externalDevices: EXTERNAL,
      heldDevices: HELD,
    });
  });
});

describe("externalDevices reaches the acquisition result and its client serializations", () => {
  class NoSessions implements BrokerDeviceAcquisitionSessions {
    async claimLivenessOwnership(): Promise<"claimed"> {
      return "claimed";
    }
    async adoptManagedExecutionLivenessPolicy(): Promise<void> {}
    async releaseSession(): Promise<void> {}
  }

  async function failedAcquisition() {
    const { provisioner, registry, reconciler, timer } = await setup();
    provisioner.failWith = () =>
      new BootCapacityExhaustedError(
        {
          platform: "ios",
          limit: 1,
          booted: 1,
          retryAfterMs: 1_000,
          externalDevices: EXTERNAL,
          heldDevices: HELD,
        },
        "full",
      );
    const acquisition = new BrokerDeviceAcquisition({
      registry: async () => registry,
      reconcile: (_registry, request) => reconciler.reconcile(request),
      sessions: new NoSessions(),
      owner: () => ({ daemonId: "daemon-1", pid: 1 }),
      timer,
    });
    const config = buildBrokerProvisionRequest({
      contractVersion: 1,
      ...SCOPE,
      localBindingCapacity: 1,
      requests: [{ bindingIndex: 0, role: "app", platform: "ios", requestedSpec: SPEC }],
    });
    return await acquisition.acquire(config, { livenessOwnerToken: "t" });
  }

  test("the binding failure carries capacity.externalDevices through JSON (initialize/resource/socket)", async () => {
    const result = await failedAcquisition();

    expect(result.failure).toMatchObject({
      code: "capacity_exhausted",
      capacity: {
        limit: 1,
        booted: 1,
        retryAfterMs: 1_000,
        externalDevices: EXTERNAL,
        heldDevices: HELD,
      },
    });
    const wire = JSON.parse(JSON.stringify(result));
    expect(wire.failure.capacity.externalDevices).toEqual(EXTERNAL);
    expect(wire.failure.capacity.heldDevices).toEqual(HELD);
    expect(wire.bindings[0].failure.capacity.externalDevices).toEqual(EXTERNAL);
    expect(wire.bindings[0].failure.capacity.heldDevices).toEqual(HELD);
  });
});
