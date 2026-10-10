import { beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../../src/daemon/devicePool";
import { MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS } from "../../../src/daemon/inputDeviceOwnership";
import {
  RegistryManagedSlotExclusion,
  runAsManagedSlotReconciler,
} from "../../../src/daemon/managedSlots/managedSlotExclusion";
import type { SlotKey } from "../../../src/daemon/managedSlots/slotRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

/**
 * Hunt (managed slots, 2026-10-10): "control on another slot's device is refused" — but a slot's
 * own execution must always pass. The device-driving gates (`ToolRegistry` control calls, socket
 * input) share one registry read per second (`MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS`), and the
 * snapshot records the slot's execution session as it was when read.
 *
 * Slot acquisition reads the snapshot fresh while it provisions the slot device (the bind's
 * `assertNotAssignedToManagedSlot`, as the slot's reconciler) and only afterwards claims the slot
 * for the session that provisioning produced (`claimExecution`). Nothing refreshes the snapshot
 * after that claim, so for up to a second the snapshot still names no execution (or the previous
 * one), and the new execution's first control call on its own slot device is refused with the
 * non-retryable `device_assigned_to_managed_slot`.
 */
describe("a slot's own execution right after its acquisition", () => {
  const DEVICE = { name: "iPhone", deviceId: "IOS-SLOT", platform: "ios" as const };
  const PREVIOUS = "exec-previous";
  const EXECUTION = "exec-new";

  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let pool: DevicePool;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    registry = new FakeSlotRegistry(timer);
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("ios", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "slots-hunt-stale-own-execution", {
        timer,
        deviceManager,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([DEVICE]);
  });

  /** What the reconciler's provision step does when it binds the slot device to a new session. */
  const bindAsReconciler = (key: SlotKey, sessionUuid: string) =>
    runAsManagedSlotReconciler(key, () =>
      pool.assertNotAssignedToManagedSlot({
        action: "acquire",
        deviceId: DEVICE.deviceId,
        platform: "ios",
        requesterSessionUuid: sessionUuid,
      }),
    );

  /** The reconciler's `claimAndReady`: the slot now names the provisioned session. */
  const claim = async (key: SlotKey, sessionUuid: string) => {
    const assignment = (await registry.getAssignment(key))!;
    const claimed = await registry.claimExecution(
      key,
      { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
      { daemonId: "daemon", pid: 1, sessionUuid },
    );
    expect(claimed.kind).toBe("claimed");
  };

  /** A device-driving call (tapOn, socket input) from the execution, with the shared max age. */
  const control = (sessionUuid: string) =>
    pool
      .assertNotAssignedToManagedSlot({
        action: "tapOn",
        deviceId: DEVICE.deviceId,
        platform: "ios",
        requesterSessionUuid: sessionUuid,
        maxAgeMs: MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS,
      })
      .then(
        () => "allowed",
        (error: unknown) => (error as { code?: string }).code ?? String(error),
      );

  test("its first control call is allowed on an idle slot it just claimed", async () => {
    const key = await assignManagedSlotDevice(registry, "ios", DEVICE.deviceId);

    await bindAsReconciler(key, EXECUTION);
    await claim(key, EXECUTION);

    expect(await control(EXECUTION)).toBe("allowed");
  });

  test("its first control call is allowed when it follows an earlier execution of the slot", async () => {
    const key = await assignManagedSlotDevice(
      registry,
      "ios",
      DEVICE.deviceId,
      "runner-a",
      PREVIOUS,
    );
    expect(await control(PREVIOUS)).toBe("allowed");
    await registry.releaseExecution(key, PREVIOUS);

    await bindAsReconciler(key, EXECUTION);
    await claim(key, EXECUTION);

    expect(await control(EXECUTION)).toBe("allowed");
    // The ended execution no longer owns the device.
    expect(await control(PREVIOUS)).toBe("device_assigned_to_managed_slot");
  });
});
