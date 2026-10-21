import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  BindingReconciler,
  type BindingReconcileRequest,
  type BindingReconcileResult,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type {
  BindingKey,
  BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

/**
 * Hunt (bindings, 2026-10-10): "platform change in a binding replaces the device" (#11232). The
 * replace entry records the platform it creates on in its journal target (`newPlatform`), and the
 * deletion step moves the emptied binding there with `journalCreationPlatform(entry)`. The SQLite
 * registry writes `newPlatform` into `target_json` but `parseJournalTarget` never reads it back, so
 * every entry it returns (including the one `openBindingJournal` hands the reconciler) creates on the
 * OLD platform. The in-memory fake keeps the field, which is why `reconciler.test.ts` passes.
 *
 * Result on the real registry: the iOS simulator is deleted, an Android AVD is created, and the
 * binding is committed `ready` as platform `ios` holding the AVD name. The AVD is then not a managed
 * Android device for any reader (`findDeviceHolder("android", …)`, the generic-pool exclusion
 * snapshot), and the same request again sees a "platform change", finds no such iOS device, and
 * creates a second AVD while the first one leaks.
 */
describe("cross-platform binding replacement on the SQLite registry", () => {
  const IOS_SPEC = {
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  };
  const ANDROID_SPEC = {
    runtime: "system-images;android-35;google_apis;arm64-v8a",
    deviceType: "pixel_8",
  };

  let timer: FakeTimer;
  let registry: BindingRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let reconciler: BindingReconciler;
  let key: BindingKey;

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => false,
    });
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    reconciler = new BindingReconciler({
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
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  });

  afterEach(async () => {
    await registry.close();
  });

  function request(overrides: Partial<BindingReconcileRequest>): BindingReconcileRequest {
    return {
      key,
      role: "app",
      platform: "ios",
      requestedSpec: IOS_SPEC,
      deadlineMs: timer.now() + 60_000,
      ...overrides,
    };
  }

  function expectReady(result: BindingReconcileResult) {
    if (result.outcome !== "ready") {
      throw new Error(`expected ready, got ${JSON.stringify(result.failure)}`);
    }
    return result;
  }

  const toAndroid = () => request({ platform: "android", requestedSpec: ANDROID_SPEC });

  test("the journal entry read back from SQLite keeps the platform it creates on", async () => {
    expectReady(await reconciler.reconcile(request({})));

    const result = expectReady(await reconciler.reconcile(toAndroid()));

    const entry = await registry.getBindingJournal(result.evidence.journal!.entryId);
    expect(entry).toMatchObject({
      kind: "replace",
      platform: "ios",
      target: { newPlatform: "android" },
    });
  });

  test("the binding ends on the requested platform and holds its new device there", async () => {
    expectReady(await reconciler.reconcile(request({})));

    const result = expectReady(await reconciler.reconcile(toAndroid()));

    expect(provisioner.created().map((call) => call.platform)).toEqual(["ios", "android"]);
    // The created AVD is the binding's device: it must be recorded as an Android device.
    expect(result.assignment).toMatchObject({
      platform: "android",
      stableDeviceId: result.device.stableId,
      state: "ready",
    });
    expect(await registry.findDeviceHolder("android", result.device.stableId)).toMatchObject({
      kind: "binding",
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
    // Nothing the binding created is left behind unassigned.
    expect(inventory.devices.map((device) => device.name)).toEqual([first.device.name]);
  });
});
