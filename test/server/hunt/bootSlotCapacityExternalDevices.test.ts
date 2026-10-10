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
} from "../../daemon/managedSlots/fixtures/reconcilerFakes";

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
  const reconciler = new ManagedSlotReconciler({
    registry,
    inventory,
    matcher: new FakeMatcher(),
    resolver: new DefaultManagedSpecResolver(),
    provisioner,
    deleter: new FakeDeleter(inventory),
    claims: new FakeClaims(),
    capacity: new FakeCapacity(),
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
  return { provisioner, reconcile };
}

// docs/using/managed-slots.md "Boot capacity": the error carries `externalDevices` when counted
// devices were not started by AutoMobile, "including a slot that must create or boot its device".
describe("managed slot capacity_exhausted keeps externalDevices (hunt)", () => {
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
});
