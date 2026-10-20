import { describe, expect, spyOn } from "bun:test";
import { bindDevice } from "../../src/daemon/deviceBinding";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleCallerNotOnForeignBinding,
} from "../../src/server/lifecycleDeviceOwnership";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { restartStopHarness } from "../helpers/restartStopHarness";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";

const DEVICE = { name: "iPhone", deviceId: "IOS-SLOT", platform: "ios" as const };
const EXECUTION = "exec-new";

describe("lifecycle retained binding snapshot", () => {
  const { test, cleanups } = restartStopHarness();

  async function fixture() {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer, () => true);
    const outage = { unreadable: false };
    const snapshot = registry.snapshotManagedDevices.bind(registry);
    const read = spyOn(registry, "snapshotManagedDevices").mockImplementation(async () => {
      if (outage.unreadable) {
        throw new Error("SQLITE_BUSY");
      }
      return snapshot();
    });
    cleanups.push(() => read.mockRestore());
    const exclusion = new RegistryBindingExclusion(async () => registry, timer);
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "lifecycle-retained", {
        timer,
        deviceManager: new FakeDeviceUtils(),
        bindingExclusion: exclusion,
      }),
    );
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    });
    await pool.initializeWithDevices([DEVICE]);
    await assignBindingDevice(registry, "ios", DEVICE.deviceId, "runner-b", "exec-previous");
    await sessions.createSession(EXECUTION, DEVICE.deviceId, "ios");
    bindDevice(pool.getDevice(DEVICE.deviceId)!, EXECUTION);
    DaemonState.getInstance().initialize(sessions, pool);
    cleanups.push(() => {
      DaemonState.getInstance().reset();
      expect(DaemonState.getInstance().isInitialized()).toBe(false);
    });
    const input = (
      sessionUuid: string | undefined = EXECUTION,
    ): Parameters<typeof assertLifecycleCallerHoldsDevice>[0] => ({
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
    await expect(assertLifecycleCallerNotOnForeignBinding(h.input())).resolves.toBeUndefined();
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
        expect.objectContaining({ code: "device_assigned_to_binding" }),
      );
    },
  );

  test("a current snapshot still refuses the bound requester naming another execution", async () => {
    const h = await fixture();
    await h.exclusion.refresh();
    expect(() => assertLifecycleCallerHoldsDevice(h.input())).toThrow(
      expect.objectContaining({ code: "device_assigned_to_binding" }),
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
