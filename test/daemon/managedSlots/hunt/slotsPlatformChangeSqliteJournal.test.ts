import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  type ManagedSlotReconcileRequest,
  type ManagedSlotReconcileResult,
} from "../../../../src/daemon/managedSlots/reconciler";
import type { SlotKey, SlotRegistry } from "../../../../src/daemon/managedSlots/slotRegistry";
import { openSqliteSlotRegistry } from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../fixtures/reconcilerFakes";

/**
 * Hunt (managed slots, 2026-10-10): "platform change in a slot replaces the device" (#11232). The
 * replace entry records the platform it creates on in its journal target (`newPlatform`), and the
 * deletion step moves the emptied slot there with `journalCreationPlatform(entry)`. The SQLite
 * registry writes `newPlatform` into `target_json` but `parseJournalTarget` never reads it back, so
 * every entry it returns (including the one `openSlotJournal` hands the reconciler) creates on the
 * OLD platform. The in-memory fake keeps the field, which is why `reconciler.test.ts` passes.
 *
 * Result on the real registry: the iOS simulator is deleted, an Android AVD is created, and the
 * slot is committed `ready` as platform `ios` holding the AVD name. The AVD is then not a managed
 * Android device for any reader (`findDeviceHolder("android", …)`, the generic-pool exclusion
 * snapshot), and the same request again sees a "platform change", finds no such iOS device, and
 * creates a second AVD while the first one leaks.
 */
describe("hunt: cross-platform slot replacement on the SQLite registry", () => {
  const IOS_SPEC = {
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  };
  const ANDROID_SPEC = {
    runtime: "system-images;android-35;google_apis;arm64-v8a",
    deviceType: "pixel_8",
  };

  let timer: FakeTimer;
  let registry: SlotRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let reconciler: ManagedSlotReconciler;
  let key: SlotKey;

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => false,
    });
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    reconciler = new ManagedSlotReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims: new FakeClaims(),
      capacity: new FakeCapacity(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
    });
    const scope = await registry.ensureScope({
      managedHostScope: "host-a",
      runnerNamespace: "ns",
      runnerIncarnation: "inc-1",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  });

  afterEach(async () => {
    await registry.close();
  });

  function request(overrides: Partial<ManagedSlotReconcileRequest>): ManagedSlotReconcileRequest {
    return {
      key,
      role: "app",
      platform: "ios",
      requestedSpec: IOS_SPEC,
      deadlineMs: timer.now() + 60_000,
      ...overrides,
    };
  }

  function expectReady(result: ManagedSlotReconcileResult) {
    if (result.outcome !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
    }
    return result;
  }

  const toAndroid = () => request({ platform: "android", requestedSpec: ANDROID_SPEC });

  test("the journal entry read back from SQLite keeps the platform it creates on", async () => {
    expectReady(await reconciler.reconcile(request({})));

    const result = expectReady(await reconciler.reconcile(toAndroid()));

    const entry = await registry.getSlotJournal(result.evidence.journal!.entryId);
    expect(entry).toMatchObject({
      kind: "replace",
      platform: "ios",
      target: { newPlatform: "android" },
    });
  });

  test("the slot ends on the requested platform and holds its new device there", async () => {
    expectReady(await reconciler.reconcile(request({})));

    const result = expectReady(await reconciler.reconcile(toAndroid()));

    expect(provisioner.created().map((call) => call.platform)).toEqual(["ios", "android"]);
    // The created AVD is the slot's device: it must be recorded as an Android device.
    expect(result.assignment).toMatchObject({
      platform: "android",
      stableDeviceId: result.device.stableId,
      state: "ready",
    });
    expect(await registry.findDeviceHolder("android", result.device.stableId)).toMatchObject({
      kind: "slot",
    });
    expect(await registry.snapshotManagedDevices()).toEqual([
      expect.objectContaining({ platform: "android", stableDeviceId: result.device.stableId }),
    ]);
  });

  test("asking for the same Android spec again reuses the device instead of creating another", async () => {
    expectReady(await reconciler.reconcile(request({})));
    const first = expectReady(await reconciler.reconcile(toAndroid()));
    await registry.releaseExecution(key, first.sessionUuid);

    const second = expectReady(await reconciler.reconcile(toAndroid()));

    expect(second.disposition).toBe("reused");
    expect(second.device.stableId).toBe(first.device.stableId);
    expect(provisioner.created().map((call) => call.platform)).toEqual(["ios", "android"]);
    // Nothing the slot created is left behind unassigned.
    expect(inventory.devices.map((device) => device.name)).toEqual([first.device.name]);
  });
});
