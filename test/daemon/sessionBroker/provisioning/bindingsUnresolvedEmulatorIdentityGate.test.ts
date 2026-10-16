import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../../../src/daemon/devicePool";
import { BINDING_INPUT_SNAPSHOT_MAX_AGE_MS } from "../../../../src/daemon/inputDeviceOwnership";
import { RegistryBindingExclusion } from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../../src/models/index";
import { FakeDeviceManager } from "../../../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../../helpers/devicePoolDependencies";
import { assignBindingDevice } from "./bindingFixtures";

/**
 * Hunt (bindings, 2026-10-10): "control/lifecycle on another binding's device is refused", and
 * the pool's own rule for a running emulator whose AVD name could not be read: "it cannot be proven
 * free while any Android device is managed, so it is excluded too: unknown identity never frees an
 * assignment" (`DevicePool.isBindingDevice`).
 *
 * Only allocation and the availability surfaces apply that rule. The gates that stop a generic
 * caller from driving a binding device (`assertNotAssignedToBinding` / `managedBindingRefusalFor`:
 * MCP control calls, socket input, lifecycle re-checks) look the device up by the identities the
 * pool knows and treat "no AVD name" as "not managed". While the binding's emulator is listed without
 * its AVD name (the console query failed), the pool reports it `binding` yet the input gate
 * lets any generic caller drive it (an idle binding device has no session to stop them).
 */
describe("a binding's emulator whose AVD name the pool could not read", () => {
  // The listing could not name the AVD: the pool sees only the serial.
  const BINDING_EMULATOR: BootedDevice = {
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
    const registry = new FakeBindingRegistry(timer);
    // A binding holds an Android AVD; its emulator is the one running.
    await assignBindingDevice(registry, "android", "amslot-avd", "runner-a", "binding-exec");
    const manager = new FakeDeviceManager();
    manager.bootedDevices = [BINDING_EMULATOR];
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "bindings-hunt-unresolved-identity", {
        timer,
        deviceManager: manager,
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([BINDING_EMULATOR]);
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
    await pool.bindingStableIds("android");
    // What listDevices / pool stats report for it.
    expect(pool.genericAvailability(BINDING_EMULATOR.deviceId)).toBe("session_broker");

    // A generic caller's device-driving frame (socket input, an MCP control call).
    const input = await refusal(
      pool.assertNotAssignedToBinding({
        action: "input",
        deviceId: BINDING_EMULATOR.deviceId,
        platform: "android",
        requesterSessionUuid: "generic-session",
        maxAgeMs: BINDING_INPUT_SNAPSHOT_MAX_AGE_MS,
      }),
    );

    expect(input).not.toBe("allowed");
  });

  const gate = (extra: Record<string, unknown>) =>
    refusal(
      pool.assertNotAssignedToBinding({
        action: "input",
        deviceId: BINDING_EMULATOR.deviceId,
        platform: "android",
        requesterSessionUuid: "generic-session",
        maxAgeMs: BINDING_INPUT_SNAPSHOT_MAX_AGE_MS,
        ...extra,
      }),
    );

  test("acquire with a verified non-managed AVD name passes", async () => {
    expect(await gate({ action: "acquire", stableIds: ["generic-avd"] })).toBe("allowed");
  });

  test("acquire with a managed AVD name is refused", async () => {
    expect(await gate({ action: "acquire", stableIds: ["amslot-avd"] })).toBe(
      "device_assigned_to_binding",
    );
  });

  test("a deviceGestureRecording gate with no identity at all is refused", async () => {
    expect(await gate({ action: "deviceGestureRecording" })).toBe("device_assigned_to_binding");
  });

  test("an input gate with only undefined identities is refused", async () => {
    expect(await gate({ stableIds: [undefined] })).toBe("device_assigned_to_binding");
  });
});
