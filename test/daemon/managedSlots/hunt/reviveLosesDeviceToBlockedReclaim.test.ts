import { beforeEach, describe, expect, test } from "bun:test";
import { AbandonedScopeReclaimer } from "../../../../src/daemon/managedSlots/abandonedScopeReclaimer";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  type ManagedSlotReconcileRequest,
  type ManagedSlotReconcileResult,
} from "../../../../src/daemon/managedSlots/reconciler";
import {
  MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS,
  type SlotKey,
} from "../../../../src/daemon/managedSlots/slotRegistry";
import type { ExactDeviceSpecification } from "../../../../src/devices/exactDeviceProvisioning";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeSlotRegistry } from "../../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../fixtures/reconcilerFakes";

// Hunt (managed slots, second pass). Owner decision 2026-10-09: the same incarnation returning
// after abandonment REVIVES its scope and reuses the devices that still exist; only deleted ones
// are recreated. The abandoned-scope sweep fences a slot `replacing` and journals a delete-only
// entry before it can tell whether the device is deletable. When that first step is merely
// blocked (the device is held, its running state is unknown, or discovery is incomplete), nothing
// destructive has happened: the device exists and matches. If the incarnation returns now, the
// revive does not roll the entry back (the sweep only checks for a revive right after fencing),
// so the slot's next acquisition, or the 5 s journal redrive loop (#11480), deletes the revived
// scope's intact device and the acquisition creates a new one.

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const SPEC: ExactDeviceSpecification = { runtime: IOS_18, deviceType: IPHONE_16 };
const SCOPE = { managedHostScope: "host-a", runnerNamespace: "ns", runnerIncarnation: "inc-1" };

describe("hunt: revive after a blocked abandoned-scope reclaim", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let claims: FakeClaims;
  let reconciler: ManagedSlotReconciler;
  let sweeper: AbandonedScopeReclaimer;
  let key: SlotKey;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    // No execution is recorded on the slot; nothing is live.
    registry = new FakeSlotRegistry(timer, () => false);
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    claims = new FakeClaims();
    reconciler = new ManagedSlotReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims,
      capacity: new FakeCapacity(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
      journal: { owner: { daemonId: "daemon-1", pid: 1001, processGenerationToken: "t" } },
    });
    // The daemon's wiring: the sweep deletes through the acquisition reconciler's own journal.
    sweeper = new AbandonedScopeReclaimer({
      registry: async () => registry,
      journal: () => reconciler.journal,
      timer,
    });
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  });

  function request(): ManagedSlotReconcileRequest {
    return {
      key,
      role: "app",
      platform: "ios",
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    };
  }

  function expectReady(result: ManagedSlotReconcileResult) {
    if (result.outcome !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
    }
    return result;
  }

  test("the returning incarnation reuses the device the sweep never got to delete", async () => {
    const first = expectReady(await reconciler.reconcile(request()));
    const deviceId = first.device.stableId;

    // An hour idle: the sweep marks the scope abandoned and fences the slot, but the device
    // cannot be deleted right now (a session still holds it), so the entry only backs off.
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
    claims.claims.set(deviceId, { kind: "held", reason: "session leftover holds it" });
    const sweep = await sweeper.sweep();
    expect(sweep.marked).toEqual([key.scopeKey]);
    expect(sweep.blocked).toMatchObject([{ ...key, reason: "device_busy" }]);
    expect(deleter.calls).toEqual([]);
    expect(inventory.has(deviceId)).toBe(true);

    // The same incarnation returns: the scope is revived, and the blocker is gone by then.
    expect(await registry.ensureScope(SCOPE)).toMatchObject({ kind: "ready", revived: true });
    claims.claims.clear();
    timer.advanceTime(60_000);
    provisioner.calls.length = 0;

    const again = expectReady(await reconciler.reconcile(request()));

    // Actual: the acquisition's redrive deletes the device, then creates a replacement.
    expect(deleter.stableIds()).toEqual([]);
    expect(inventory.has(deviceId)).toBe(true);
    expect(again.device.stableId).toBe(deviceId);
    expect(again.disposition).toBe("reused");
    expect(provisioner.created()).toHaveLength(0);
  });
});
