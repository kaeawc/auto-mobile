import { describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  type ManagedSlotReconcileResult,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  ProvisionDeviceError,
  type ExactDeviceSpecification,
} from "../../../src/devices/exactDeviceProvisioning";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import {
  ManagedSlotAcquisition,
  type ManagedSlotAcquisitionSessions,
} from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import { provisionErrorFromPayload } from "../../../src/daemon/managedSlots/managedSlotReconcilerPorts";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import { managedSlotsFailedToolResult } from "../../../src/server/proxyServer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };
const EXTERNAL = ["UDID-XCODE-1"];

async function setup() {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const capacity = new FakeCapacity();
  const reconciler = new ManagedSlotReconciler({
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
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  const reconcile = async (): Promise<ManagedSlotReconcileResult> =>
    await reconciler.reconcile({
      key,
      role: "app",
      platform: "ios",
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    });
  return { provisioner, reconcile, capacity, registry, reconciler, timer };
}

// docs/using/managed-slots.md "Boot capacity": the error carries `externalDevices` when counted
// devices were not started by AutoMobile, "including a slot that must create or boot its device".
describe("managed slot capacity_exhausted keeps externalDevices", () => {
  test("a gate refusal during slot provisioning names the external devices", async () => {
    const { provisioner, reconcile } = await setup();
    provisioner.failWith = () =>
      new BootCapacityExhaustedError(
        { platform: "ios", limit: 1, booted: 1, retryAfterMs: 1_000, externalDevices: EXTERNAL },
        "full",
      );

    const result = await reconcile();

    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" ? result.failure : undefined).toMatchObject({
      code: "capacity_exhausted",
      capacity: { externalDevices: EXTERNAL },
    });
  });

  test("a typed provision capacity_exhausted refusal names the external devices", async () => {
    const { provisioner, reconcile } = await setup();
    provisioner.failWith = () =>
      new ProvisionDeviceError("capacity_exhausted", "full", true, {
        retryAfterMs: 2_000,
        capacity: { limit: 1, booted: 1, externalDevices: EXTERNAL },
      });

    const result = await reconcile();

    expect(result.outcome === "failed" ? result.failure : undefined).toMatchObject({
      code: "capacity_exhausted",
      capacity: { externalDevices: EXTERNAL },
    });
  });

  test("the capacity probe's external devices reach the slot failure", async () => {
    const { capacity, reconcile } = await setup();
    capacity.result = {
      kind: "exhausted",
      limit: 1,
      booted: 1,
      retryAfterMs: 3_000,
      externalDevices: EXTERNAL,
    };

    const result = await reconcile();

    expect(result.outcome === "failed" ? result.failure : undefined).toMatchObject({
      code: "capacity_exhausted",
      capacity: { limit: 1, booted: 1, retryAfterMs: 3_000, externalDevices: EXTERNAL },
    });
  });

  test("an empty external list is omitted, matching the non-slot refusal", async () => {
    const { provisioner, reconcile } = await setup();
    provisioner.failWith = () =>
      new BootCapacityExhaustedError(
        { platform: "ios", limit: 1, booted: 1, retryAfterMs: 1_000, externalDevices: [] },
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
        },
      },
      "fallback",
    );

    expect(error.diagnostics.capacity).toEqual({ limit: 1, booted: 1, externalDevices: EXTERNAL });
  });
});

describe("externalDevices reaches the acquisition result and its client serializations", () => {
  class NoSessions implements ManagedSlotAcquisitionSessions {
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
        { platform: "ios", limit: 1, booted: 1, retryAfterMs: 1_000, externalDevices: EXTERNAL },
        "full",
      );
    const acquisition = new ManagedSlotAcquisition({
      registry: async () => registry,
      reconcile: (_registry, request) => reconciler.reconcile(request),
      sessions: new NoSessions(),
      owner: () => ({ daemonId: "daemon-1", pid: 1 }),
      timer,
    });
    const config = parseManagedSlotConfig({
      contractVersion: 1,
      ...SCOPE,
      localSlotCapacity: 1,
      requests: [{ slotIndex: 0, role: "app", platform: "ios", requestedSpec: SPEC }],
    });
    return await acquisition.acquire(config, { livenessOwnerToken: "t" });
  }

  test("the slot failure carries capacity.externalDevices through JSON (initialize/resource/socket)", async () => {
    const result = await failedAcquisition();

    expect(result.failure).toMatchObject({
      code: "capacity_exhausted",
      capacity: { limit: 1, booted: 1, retryAfterMs: 1_000, externalDevices: EXTERNAL },
    });
    const wire = JSON.parse(JSON.stringify(result));
    expect(wire.failure.capacity.externalDevices).toEqual(EXTERNAL);
    expect(wire.slots[0].failure.capacity.externalDevices).toEqual(EXTERNAL);
  });

  test("the refused tool call carries it in acquisitionFailure", async () => {
    const result = await failedAcquisition();

    const refused = managedSlotsFailedToolResult(result, "tapOn");
    const payload = JSON.parse(refused.content[0].text);

    expect(payload.error.acquisitionFailure.capacity.externalDevices).toEqual(EXTERNAL);
  });
});
