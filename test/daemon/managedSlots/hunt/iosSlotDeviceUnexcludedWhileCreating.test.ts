import { describe, expect, test } from "bun:test";
import { DevicePool } from "../../../../src/daemon/devicePool";
import {
  RegistryManagedSlotExclusion,
  managedSlotRefusal,
} from "../../../../src/daemon/managedSlots/managedSlotExclusion";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  type ManagedSlotRequestedSpec,
} from "../../../../src/daemon/managedSlots/reconciler";
import type { SlotPlatform, SlotRegistry } from "../../../../src/daemon/managedSlots/slotRegistry";
import { openSqliteSlotRegistry } from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../../helpers/devicePoolDependencies";
import { settleWithFakeTime } from "../../../helpers/fakeTimerStepping";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../fixtures/reconcilerFakes";

/**
 * Hunt (managed slots 4, 2026-10-11), cells "exclusion while not yet acquired" and "a peer
 * daemon's view while the swap is in flight".
 *
 * The slot registry is host-wide so that every daemon sees one set of assignments, and it lists a
 * device an open journal entry is still creating, "so a device mid-creation is never handed to
 * another client before the slot commits it" (`journalTargetEntries`). That holds for Android,
 * whose stable id is the generated AVD name recorded when the entry enters `creating`. An iOS
 * simulator's stable id is its UDID, which the entry only learns when the whole provision call
 * returns (create, boot and automation readiness: about 38 s in the acceptance run). For all of
 * that time the simulator exists and is booted but no daemon's exclusion snapshot holds it, so
 * another daemon on the host treats it as free capacity and can lend it to a generic session.
 * The provisioning daemon's own readiness reservation is process-local and does not reach a peer.
 *
 * Contract: control and lifecycle on another slot's device are refused, and a slot wins the device
 * it is about to claim.
 */
const IOS_SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const ANDROID_SPEC = {
  runtime: "system-images;android-35;google_apis;arm64-v8a",
  deviceType: "pixel_8",
};

const REGISTRIES: Array<[string, (timer: FakeTimer) => Promise<SlotRegistry>]> = [
  ["in-memory registry", async (timer) => new FakeSlotRegistry(timer, () => false)],
  [
    "SQLite registry",
    (timer) => openSqliteSlotRegistry({ dbPath: ":memory:", timer, isExecOwnerLive: () => false }),
  ],
];

interface MidCreation {
  registry: SlotRegistry;
  /** The device as it is listed while the slot's provision call is still running. */
  stableId: string;
}

/**
 * Create a slot's first device with the real reconciler and stop inside the provision call, once
 * the device exists and is booted but before the call returns: `whileCreating` sees what every
 * other actor on the host sees at that moment.
 */
async function createSlotDevice(
  open: (timer: FakeTimer) => Promise<SlotRegistry>,
  platform: SlotPlatform,
  requestedSpec: ManagedSlotRequestedSpec,
  whileCreating: (state: MidCreation) => Promise<void>,
): Promise<void> {
  const timer = new FakeTimer();
  const registry = await open(timer);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  provisioner.beforeReturn = async (request) => {
    const listed = inventory.devices.find((device) => device.name === request.name)!;
    await whileCreating({ registry, stableId: listed.deviceId ?? listed.name });
  };
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
  const result = await reconciler.reconcile({
    key: { scopeKey: scope.scope.scopeKey, slotIndex: 0 },
    role: "app",
    platform,
    requestedSpec,
    deadlineMs: timer.now() + 60_000,
  });
  await registry.close();
  // Control: the creation itself succeeds; only the view during it is under test.
  expect(result.outcome).toBe("ready");
}

/** What a generic caller of any daemon is told when it tries to take `stableId`. */
async function strangerRefusal(state: MidCreation, platform: SlotPlatform): Promise<unknown> {
  const exclusion = new RegistryManagedSlotExclusion(async () => state.registry, new FakeTimer());
  await exclusion.refresh();
  return managedSlotRefusal(exclusion, {
    action: "killDevice",
    deviceId: state.stableId,
    device: { platform, stableIds: [state.stableId] },
    requesterSessionUuid: "generic-session",
  });
}

describe.each(REGISTRIES)("a slot device that is still being created (%s)", (_name, open) => {
  test("control: an Android device is refused to a generic caller while it is created", async () => {
    let refusal: unknown;
    await createSlotDevice(open, "android", ANDROID_SPEC, async (state) => {
      refusal = await strangerRefusal(state, "android");
    });

    expect(refusal).toMatchObject({ code: "device_assigned_to_managed_slot" });
  });

  test("an iOS simulator is refused to a generic caller while it is created", async () => {
    let refusal: unknown;
    await createSlotDevice(open, "ios", IOS_SPEC, async (state) => {
      refusal = await strangerRefusal(state, "ios");
    });

    // Bug: undefined. killDevice, deleteDevice and setActiveDevice pass the managed-slot guard.
    expect(refusal).toMatchObject({ code: "device_assigned_to_managed_slot" });
  });
});

describe("a peer daemon's generic allocation while a slot creates its iOS simulator", () => {
  test("never lends the simulator the slot is about to claim", async () => {
    let lent: unknown;
    await createSlotDevice(
      async (timer) => new FakeSlotRegistry(timer, () => false),
      "ios",
      IOS_SPEC,
      async ({ registry, stableId }) => {
        // Another daemon on the host: its own clock, pool and sessions, the same registry.
        const peerTimer = new FakeTimer();
        const sessions = new SessionManager(peerTimer, new FakeDeviceSessionPersistence());
        const manager = new FakeDeviceManager();
        const booted = [{ deviceId: stableId, name: stableId, platform: "ios" as const }];
        manager.bootedDevices = booted;
        const pool = new DevicePool(
          createDevicePoolDependencies(sessions, "hunt-peer-daemon", {
            timer: peerTimer,
            deviceManager: manager,
            retryExecutor: new DefaultRetryExecutor(peerTimer),
            installedAppsRepository: new FakeInstalledAppsRepository(),
            managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, peerTimer),
          }),
        );
        await pool.initializeWithDevices(booted);
        lent = await settleWithFakeTime(
          peerTimer,
          runWithAbortSignal(new AbortController().signal, () =>
            pool.assignDeviceToSession("generic-1", "ios"),
          ).then(
            (value) => value,
            (error: unknown) => error,
          ),
          { stepMs: 1_000, maxSteps: 70, description: "peer allocation outcome" },
        );
        sessions.stopCleanupTimer();
        peerTimer.reset();
      },
    );

    // Bug: the peer answers with the simulator's UDID, bound to session generic-1.
    expect(lent).toBeInstanceOf(Error);
  });
});
