import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../../src/daemon/devicePool";
import { MANAGED_SLOT_INPUT_SNAPSHOT_MAX_AGE_MS } from "../../../src/daemon/inputDeviceOwnership";
import {
  RegistryManagedSlotExclusion,
  runAsManagedSlotReconciler,
} from "../../../src/daemon/managedSlots/managedSlotExclusion";
import type { SlotKey, SlotRegistry } from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

/**
 * Hunt (managed slots, 2026-10-12): the fail-closed exclusion snapshot (#12094) judges a failed
 * registry read by the snapshot it retained. Acquisition reads that snapshot while it provisions
 * the slot device and claims the slot for the new session only afterwards (#11457), so the retained
 * snapshot names the previous execution, or none. When the execution's first control call meets an
 * unreadable registry, the forced re-read fails and the retained verdict refuses the slot's own
 * live execution with the NON-retryable `device_assigned_to_managed_slot`, although this daemon's
 * pool has the device bound to that very session.
 */
describe("a slot's own execution while the registry is briefly unreadable", () => {
  const DEVICE = { name: "iPhone", deviceId: "IOS-SLOT", platform: "ios" as const };
  const PREVIOUS = "exec-previous";
  const EXECUTION = "exec-new";
  const DAEMON = { daemonId: "daemon", pid: 1 };
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) {
      await close();
    }
  });

  async function harness() {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const registry = new FakeSlotRegistry(timer, () => true);
    closers.push(() => registry.close());
    const outage = { unreadable: false };
    const daemonView: SlotRegistry = new Proxy(registry, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]): unknown => {
          if (property === "snapshotManagedDevices" && outage.unreadable) {
            return Promise.reject(new Error("SQLITE_BUSY: database is locked"));
          }
          return Reflect.apply(value, target, args);
        };
      },
    });
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("ios", [DEVICE]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "slots-hunt-own-execution-outage", {
        timer,
        deviceManager,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => daemonView, timer),
      }),
    );
    await pool.initializeWithDevices([DEVICE]);

    /** The reconciler's provision step: the bind's fresh read, taken before the slot is claimed. */
    const bindAsReconciler = async (key: SlotKey, sessionUuid: string) => {
      await runAsManagedSlotReconciler(key, () =>
        pool.assertNotAssignedToManagedSlot({
          action: "acquire",
          deviceId: DEVICE.deviceId,
          platform: "ios",
          requesterSessionUuid: sessionUuid,
        }),
      );
      await sessionManager.createSession(sessionUuid, DEVICE.deviceId, "ios");
      const pooled = pool.getDevice(DEVICE.deviceId)!;
      pooled.sessionId = sessionUuid;
      pooled.status = "assigned";
    };
    /** The reconciler's `claimAndReady`: the slot now names the provisioned session. */
    const claim = async (key: SlotKey, sessionUuid: string) => {
      const assignment = (await registry.getAssignment(key))!;
      const claimed = await registry.claimExecution(
        key,
        { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
        { ...DAEMON, sessionUuid },
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
          () => ({ outcome: "allowed" }),
          (error: unknown) => ({
            outcome: "refused",
            code: (error as { code?: string }).code,
            retryable: (error as { retryable?: boolean }).retryable,
          }),
        );
    return { timer, registry, pool, outage, bindAsReconciler, claim, control };
  }

  test("its first control call is not refused for good when the forced re-read fails", async () => {
    const h = await harness();
    const key = await assignManagedSlotDevice(h.registry, "ios", DEVICE.deviceId);

    await h.bindAsReconciler(key, EXECUTION);
    await h.claim(key, EXECUTION);
    // The registry is locked for the next read only (a peer daemon's write, a checkpoint).
    h.outage.unreadable = true;

    expect(h.pool.getDevice(DEVICE.deviceId)?.sessionId).toBe(EXECUTION);
    expect(await h.control(EXECUTION)).toEqual({ outcome: "allowed" });
  });

  test("a later control call is not refused for good when it follows an earlier execution", async () => {
    const h = await harness();
    const key = await assignManagedSlotDevice(
      h.registry,
      "ios",
      DEVICE.deviceId,
      "runner-b",
      PREVIOUS,
    );
    // The previous execution drove the device (snapshot names it), then ended.
    expect(
      await h.pool
        .assertNotAssignedToManagedSlot({
          action: "tapOn",
          deviceId: DEVICE.deviceId,
          platform: "ios",
          requesterSessionUuid: PREVIOUS,
        })
        .then(() => "allowed"),
    ).toBe("allowed");
    await h.registry.releaseExecution(key, PREVIOUS);
    await h.bindAsReconciler(key, EXECUTION);
    await h.claim(key, EXECUTION);
    // Well past the one-second snapshot age: this is not the #11457 young-snapshot window.
    h.timer.advanceTime(60_000);
    h.outage.unreadable = true;

    expect(await h.control(EXECUTION)).toEqual({ outcome: "allowed" });
  });
});
