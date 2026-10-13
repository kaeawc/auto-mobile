import { describe, expect, spyOn } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleCallerNotOnForeignManagedSlot,
} from "../../src/server/lifecycleDeviceOwnership";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { restartStopHarness } from "../helpers/restartStopHarness";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";

const DEVICE = { name: "iPhone", deviceId: "IOS-SLOT", platform: "ios" as const };
const EXECUTION = "exec-new";

describe("lifecycle retained managed-slot snapshot", () => {
  // Reuse the lifecycle harness's singleton reset and its uninitialized-state assertion.
  const { test, cleanups } = restartStopHarness();

  async function fixture() {
    const timer = new FakeTimer();
    const registry = new FakeSlotRegistry(timer, () => true);
    const outage = { unreadable: false };
    const snapshot = registry.snapshotManagedDevices.bind(registry);
    const read = spyOn(registry, "snapshotManagedDevices").mockImplementation(async () => {
      if (outage.unreadable) {
        throw new Error("SQLITE_BUSY");
      }
      return snapshot();
    });
    cleanups.push(() => read.mockRestore());
    const exclusion = new RegistryManagedSlotExclusion(async () => registry, timer);
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "lifecycle-retained", {
        timer,
        deviceManager: new FakeDeviceUtils(),
        managedSlotExclusion: exclusion,
      }),
    );
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
    await pool.initializeWithDevices([DEVICE]);
    await assignManagedSlotDevice(registry, "ios", DEVICE.deviceId, "runner-b", "exec-previous");
    await sessions.createSession(EXECUTION, DEVICE.deviceId, "ios");
    pool.getDevice(DEVICE.deviceId)!.sessionId = EXECUTION;
    pool.getDevice(DEVICE.deviceId)!.status = "assigned";
    DaemonState.getInstance().initialize(sessions, pool);
    const input = (sessionUuid: string | undefined = EXECUTION) => ({
      toolName: "killDevice",
      device: DEVICE,
      requester: { sessionUuid, mcpSessionId: undefined },
      force: false,
    });
    return { exclusion, outage, input };
  }

  test("the failed-read entry admission survives the synchronous holder re-check", async () => {
    const h = await fixture();
    await h.exclusion.refresh();
    h.outage.unreadable = true;
    await expect(assertLifecycleCallerNotOnForeignManagedSlot(h.input())).resolves.toBeUndefined();
    expect(() => assertLifecycleCallerHoldsDevice(h.input())).not.toThrow();
  });

  test.each([undefined, "exec-other"])(
    "retained snapshot still refuses a caller without the pool binding: %s",
    async (sessionUuid) => {
      const h = await fixture();
      await h.exclusion.refresh();
      h.outage.unreadable = true;
      await h.exclusion.refresh();
      const input = h.input();
      input.requester.sessionUuid = sessionUuid;
      expect(() => assertLifecycleCallerHoldsDevice(input)).toThrow(
        expect.objectContaining({ code: "device_assigned_to_managed_slot" }),
      );
    },
  );

  test("a current snapshot still refuses the bound requester naming another execution", async () => {
    const h = await fixture();
    await h.exclusion.refresh();
    expect(() => assertLifecycleCallerHoldsDevice(h.input())).toThrow(
      expect.objectContaining({ code: "device_assigned_to_managed_slot" }),
    );
  });

  test("lastReadFailed tracks a failed retained read and clears after recovery", async () => {
    const h = await fixture();
    expect(h.exclusion.lastReadFailed()).toBe(false);
    await h.exclusion.refresh();
    expect(h.exclusion.lastReadFailed()).toBe(false);
    h.outage.unreadable = true;
    await h.exclusion.refresh();
    expect(h.exclusion.lastReadFailed()).toBe(true);
    h.outage.unreadable = false;
    await h.exclusion.refresh();
    expect(h.exclusion.lastReadFailed()).toBe(false);
  });
});
