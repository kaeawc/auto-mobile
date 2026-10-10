import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import {
  DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
  DeviceAssignedToManagedSlotError,
  ManagedSlotDiscoveryIncompleteError,
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { assignManagedSlotDevice } from "./managedSlots/managedSlotFixtures";

// #11174 part b / #11178 part a: a device a managed slot holds is never generic capacity, even
// while idle with no session. Every case below has no live session on the assigned device.

const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });
const android = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});

describe("DevicePool managed-slot exclusion", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let manager: FakeDeviceManager;
  let registry: FakeSlotRegistry;
  let pool: DevicePool;

  const setUp = async (devices: BootedDevice[]) => {
    manager.bootedDevices = devices;
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "managed-slot-exclusion", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices(devices);
  };

  const settle = (result: Promise<unknown>) =>
    settleWithFakeTime(
      timer,
      result.then(
        (value) => value,
        (error: unknown) => error,
      ),
      { stepMs: 1_000, maxSteps: 70, description: "allocation outcome" },
    );

  const assignOne = (sessionId: string, platform: "ios" | "android") =>
    settle(
      runWithAbortSignal(new AbortController().signal, () =>
        pool.assignDeviceToSession(sessionId, platform),
      ),
    );

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager = new FakeDeviceManager();
    registry = new FakeSlotRegistry(timer);
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("generic single-device allocation skips an idle device a managed slot holds", async () => {
    await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT"), ios("SIM-FREE")]);

    expect(await assignOne("generic-1", "ios")).toBe("SIM-FREE");
    const second = await assignOne("generic-2", "ios");

    expect(second).toBeInstanceOf(Error);
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();
    expect(sessions.getSession("generic-2")).toBeNull();
  });

  test("multi-device criteria allocation never lends the assigned device", async () => {
    await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT"), ios("SIM-FREE")]);

    const allocate = (sessionIds: string[]) =>
      settle(
        runWithAbortSignal(new AbortController().signal, () =>
          pool.assignMultipleDevicesByCriteria(
            sessionIds.map((sessionId) => ({ sessionId, criteria: { platform: "ios" as const } })),
            4_000,
          ),
        ),
      );

    const refused = await allocate(["a", "b"]);
    expect(refused).toBeInstanceOf(Error);
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();

    const granted = (await allocate(["c"])) as Map<string, string>;
    expect(granted.get("c")).toBe("SIM-FREE");
  });

  test("an explicit bind of the assigned idle device is refused, typed and non-retryable", async () => {
    const slot = await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT")]);

    const error = await pool
      .bindOrReuseDeviceSession("generic", "SIM-SLOT", "ios")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeviceAssignedToManagedSlotError);
    expect((error as DeviceAssignedToManagedSlotError).toPayload()).toMatchObject({
      code: DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
      scopeKey: slot.scopeKey,
      declaredSlot: 0,
      stableId: "SIM-SLOT",
      retryable: false,
    });
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();
  });

  test("the slot's own execution session may bind its device", async () => {
    await assignManagedSlotDevice(registry, "ios", "SIM-SLOT", "runner-a", "slot-exec");
    await setUp([ios("SIM-SLOT")]);

    await pool.bindOrReuseDeviceSession("slot-exec", "SIM-SLOT", "ios");

    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBe("slot-exec");
  });

  test("an explicit bind names the AVD the caller resolved for a pooled serial", async () => {
    await assignManagedSlotDevice(registry, "android", "slot-avd");
    await setUp([android("emulator-5554")]);

    const error = await pool
      .bindOrReuseDeviceSession("generic", "emulator-5554", "android", {
        name: "slot-avd",
        platform: "android",
        source: "local",
      })
      .catch((caught: unknown) => caught);

    expect((error as DeviceAssignedToManagedSlotError).code).toBe(
      DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
    );
  });

  test("a device a reset scope parked in the managed free pool is still excluded", async () => {
    const slot = await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");
    await registry.beginScopeInvalidation(slot.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(slot.scopeKey);
    await setUp([ios("SIM-SLOT")]);

    expect(await assignOne("generic", "ios")).toBeInstanceOf(Error);
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();
  });

  test("auto-start never boots a stopped AVD a managed slot holds", async () => {
    await assignManagedSlotDevice(registry, "android", "slot-avd");
    await setUp([android("d1")]);
    await pool.bindOrReuseDeviceSession("base", "d1", "android");
    manager.deviceImages = [
      { name: "slot-avd", platform: "android", isRunning: false },
      { name: "spare-avd", platform: "android", isRunning: false },
    ];

    const result = (await settle(
      runWithAbortSignal(new AbortController().signal, () =>
        pool.assignMultipleDevicesByCriteria(
          ["base", "base:B"].map((sessionId) => ({
            sessionId,
            criteria: { platform: "android" as const },
          })),
          4_000,
        ),
      ),
    )) as Map<string, string>;

    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
    expect(result.get("base:B")).toBe("spare-avd");
  });

  test("a registry that was never readable refuses allocation instead of treating devices as free", async () => {
    await setUp([ios("SIM-FREE")]);
    registry.snapshotManagedDevices = async () => {
      throw new Error("disk I/O error");
    };

    const error = await assignOne("generic", "ios");

    expect(error).toBeInstanceOf(ManagedSlotDiscoveryIncompleteError);
    expect(pool.getDevice("SIM-FREE")?.sessionId).toBeNull();
  });
});
