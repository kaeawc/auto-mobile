import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../../src/daemon/devicePool";
import { MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS } from "../../../src/daemon/inputDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

/**
 * Hunt (managed slots, 2026-10-10): "control/lifecycle on another slot's device is refused", and
 * the pool's own rule for a running emulator whose AVD name could not be read: "it cannot be proven
 * free while any Android device is managed, so it is excluded too: unknown identity never frees an
 * assignment" (`DevicePool.isManagedSlotDevice`).
 *
 * Only allocation and the availability surfaces apply that rule. The gates that stop a generic
 * caller from driving a slot device (`assertNotAssignedToManagedSlot` / `managedSlotRefusalFor`:
 * MCP control calls, socket input, lifecycle re-checks) look the device up by the identities the
 * pool knows and treat "no AVD name" as "not managed". While the slot's emulator is listed without
 * its AVD name (the console query failed), the pool reports it `managed_slot` yet the input gate
 * lets any generic caller drive it (an idle slot device has no session to stop them).
 */
describe("a slot's emulator whose AVD name the pool could not read", () => {
  // The listing could not name the AVD: the pool sees only the serial.
  const SLOT_EMULATOR: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Unknown (emulator-5554)",
    platform: "android",
  };

  let timer: FakeTimer;
  let sessions: SessionManager;
  let pool: DevicePool;

  beforeEach(async () => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const registry = new FakeSlotRegistry(timer);
    // A managed slot holds an Android AVD; its emulator is the one running.
    await assignManagedSlotDevice(registry, "android", "amslot-avd", "runner-a", "slot-exec");
    const manager = new FakeDeviceManager();
    manager.bootedDevices = [SLOT_EMULATOR];
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "slots-hunt-unresolved-identity", {
        timer,
        deviceManager: manager,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([SLOT_EMULATOR]);
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => "allowed",
      (error: unknown) => (error as { code?: string }).code ?? "refused",
    );

  test("the availability surface and the input gate agree that it is not a free device", async () => {
    await pool.managedSlotStableIds("android");
    // What listDevices / pool stats report for it.
    expect(pool.genericAvailability(SLOT_EMULATOR.deviceId)).toBe("managed_slot");

    // A generic caller's device-driving frame (socket input, an MCP control call).
    const input = await refusal(
      pool.assertNotAssignedToManagedSlot({
        action: "input",
        deviceId: SLOT_EMULATOR.deviceId,
        platform: "android",
        requesterSessionUuid: "generic-session",
        maxAgeMs: MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS,
      }),
    );

    expect(input).not.toBe("allowed");
  });
});
