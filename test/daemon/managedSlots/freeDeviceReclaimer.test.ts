import { beforeEach, describe, expect, test } from "bun:test";
import type { DeviceInfo } from "../../../src/models";
import {
  FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS,
  FreeDeviceReclaimer,
  type FreeDeviceReclaimerOptions,
  type ManagedSlotDeviceStopper,
  type ManagedSlotStopResult,
  type ManagedSlotStopTarget,
} from "../../../src/daemon/managedSlots/freeDeviceReclaimer";
import {
  MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS,
  type SlotKey,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeClaims, FakeInventory } from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

// #11337: a free-pool device unadopted for an hour is shut down (not deleted) and its image kept,
// so a later matching slot adopts it. Safety conditions are each pinned here through fakes.

class FakeStopper implements ManagedSlotDeviceStopper {
  readonly calls: ManagedSlotStopTarget[] = [];
  results: ManagedSlotStopResult[] = [];
  beforeStop: (() => Promise<void>) | undefined;
  async stopAndVerifyOffline(target: ManagedSlotStopTarget): Promise<ManagedSlotStopResult> {
    this.calls.push(target);
    await this.beforeStop?.();
    return this.results.shift() ?? { kind: "stopped" };
  }
}

/** Let every queued microtask (the fire-and-forget sweep) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function avd(name: string, over: Partial<DeviceInfo> = {}): DeviceInfo {
  return { name, deviceId: name, platform: "android", isRunning: true, ...over };
}

describe("FreeDeviceReclaimer", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let claims: FakeClaims;
  let stopper: FakeStopper;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    registry = new FakeSlotRegistry(timer, () => false);
    inventory = new FakeInventory();
    claims = new FakeClaims();
    stopper = new FakeStopper();
  });

  function reclaimer(over: Partial<FreeDeviceReclaimerOptions> = {}) {
    return new FreeDeviceReclaimer({
      registry: async () => registry,
      inventory,
      claims,
      stopper,
      timer,
      ...over,
    });
  }

  /** A running device bound to a slot of `namespace`, then freed by an operator reset. */
  async function freeDevice(name: string, namespace = "runner-a"): Promise<void> {
    inventory.devices.push(avd(name));
    const key = await assignManagedSlotDevice(registry, "android", name, namespace);
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
  }

  function pastThreshold(): void {
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
  }

  test("shuts down a device unadopted for an hour and keeps its row as stopped", async () => {
    await freeDevice("amslot-a");
    pastThreshold();

    const report = await reclaimer().sweep();

    expect(report.stopped).toEqual([{ platform: "android", stableDeviceId: "amslot-a" }]);
    expect(stopper.calls).toHaveLength(1);
    expect(stopper.calls[0]).toMatchObject({ stableId: "amslot-a", name: "amslot-a" });
    // Shut down, not deleted: the image is still in the inventory and the row is still excluded.
    expect(inventory.has("amslot-a")).toBe(true);
    expect(await registry.listFreeDevices()).toMatchObject([
      { stableDeviceId: "amslot-a", state: "stopped" },
    ]);
    expect(await registry.snapshotManagedDevices()).toMatchObject([
      { stableDeviceId: "amslot-a", holder: "free" },
    ]);

    // Idempotent: a stopped device is never re-examined.
    expect((await reclaimer().sweep()).stopped).toEqual([]);
    expect(stopper.calls).toHaveLength(1);
  });

  test("leaves a device alone until the threshold has passed", async () => {
    await freeDevice("amslot-a");
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS - 1);

    const report = await reclaimer().sweep();

    expect(report).toEqual({ stopped: [], failed: [], skipped: [] });
    expect(stopper.calls).toEqual([]);
  });

  test("a device already reported offline is only recorded as stopped", async () => {
    inventory.devices.push(avd("amslot-a", { isRunning: false }));
    const key = await assignManagedSlotDevice(registry, "android", "amslot-a");
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    pastThreshold();

    const report = await reclaimer().sweep();

    expect(report.stopped).toHaveLength(1);
    expect(stopper.calls).toEqual([]);
    expect((await registry.listFreeDevices())[0]?.state).toBe("stopped");
  });

  describe("never touches", () => {
    async function dueDevice(): Promise<void> {
      await freeDevice("amslot-a");
      pastThreshold();
    }

    async function expectUntouched(reason: string): Promise<void> {
      const report = await reclaimer().sweep();
      expect(report.skipped).toEqual([{ platform: "android", stableDeviceId: "amslot-a", reason }]);
      expect(stopper.calls).toEqual([]);
      expect((await registry.listFreeDevices())[0]?.state).toBe("free");
    }

    test("a device a session holds", async () => {
      await dueDevice();
      claims.sessions.set("amslot-a", ["session-1"]);
      await expectUntouched("session_holds_device");
    });

    test("a device another daemon claims", async () => {
      await dueDevice();
      claims.claims.set("amslot-a", { kind: "held", reason: "daemon-2 claims it" });
      await expectUntouched("held");
    });

    test("a device whose claim state is unknown", async () => {
      await dueDevice();
      claims.claims.set("amslot-a", { kind: "unknown", reason: "state unreadable" });
      await expectUntouched("claim_unknown");
    });

    test("an external device the daemon did not create", async () => {
      inventory.devices.push(avd("my-own-avd"));
      const key = await assignManagedSlotDevice(registry, "android", "my-own-avd");
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
      pastThreshold();

      const report = await reclaimer().sweep();

      expect(report.skipped).toEqual([
        { platform: "android", stableDeviceId: "my-own-avd", reason: "not_daemon_created" },
      ]);
      expect(stopper.calls).toEqual([]);
    });

    test("a device not in a complete inventory", async () => {
      await dueDevice();
      inventory.complete = false;
      await expectUntouched("discovery_incomplete");
      inventory.complete = true;
      inventory.remove("amslot-a");
      await expectUntouched("not_in_inventory");
    });

    test("a device assigned to a slot of any scope", async () => {
      await freeDevice("amslot-a");
      pastThreshold();
      // A later slot adopts it before the sweep claims it: the row is gone, nothing is stopped.
      claims.beforeDescribe = async () => {
        const slot: SlotKey = await assignManagedSlotDevice(registry, "android", "amslot-b", "x");
        await registry.commitBinding(
          slot,
          { generation: 1, stableDeviceId: "amslot-b" },
          {
            stableDeviceId: "amslot-a",
            deviceName: "amslot-a",
            resolvedSpec: {},
            specFingerprint: "fp",
            state: "ready",
          },
        );
      };

      const report = await reclaimer().sweep();

      expect(report.skipped).toEqual([
        { platform: "android", stableDeviceId: "amslot-a", reason: "not_reclaimable" },
      ]);
      expect(stopper.calls).toEqual([]);
      expect(await registry.listFreeDevices()).toEqual([]);
    });
  });

  test("a busy device (in-flight boot or lifecycle lease) is left alone", async () => {
    await freeDevice("amslot-a");
    pastThreshold();

    const report = await reclaimer({ isBusy: () => "booting" }).sweep();

    expect(report.skipped).toEqual([
      { platform: "android", stableDeviceId: "amslot-a", reason: "busy" },
    ]);
    expect(stopper.calls).toEqual([]);
  });

  test("an adoption landing while the device is shutting down is refused until stopped", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    let refusal: unknown;
    stopper.beforeStop = async () => {
      const slot = await assignManagedSlotDevice(registry, "android", "amslot-b", "x");
      refusal = await registry.commitBinding(
        slot,
        { generation: 1, stableDeviceId: "amslot-b" },
        {
          stableDeviceId: "amslot-a",
          deviceName: "amslot-a",
          resolvedSpec: {},
          specFingerprint: "fp",
          state: "ready",
        },
      );
    };

    const report = await reclaimer().sweep();

    expect(refusal).toEqual({ kind: "free_device_stopping" });
    expect(report.stopped).toHaveLength(1);
    expect((await registry.listFreeDevices())[0]?.state).toBe("stopped");
  });

  describe("a failed shutdown", () => {
    test("is logged, retried with backoff, and never loops hot", async () => {
      await freeDevice("amslot-a");
      pastThreshold();
      stopper.results = [
        { kind: "failed", message: "emulator refused" },
        { kind: "failed", message: "emulator refused again" },
        { kind: "stopped" },
      ];
      const sweeper = reclaimer({ backoff: [1_000, 4_000] });

      const first = await sweeper.sweep();
      expect(first.failed).toEqual([
        { platform: "android", stableDeviceId: "amslot-a", message: "emulator refused" },
      ]);
      // The claim stays `stopping` so the interrupted shutdown is retried, never abandoned.
      expect((await registry.listFreeDevices())[0]?.state).toBe("stopping");

      // Immediately again: backed off, the stopper is not called.
      expect((await sweeper.sweep()).skipped[0]?.reason).toBe("backoff");
      expect(stopper.calls).toHaveLength(1);

      timer.advanceTime(1_000);
      expect((await sweeper.sweep()).failed).toHaveLength(1);
      expect(stopper.calls).toHaveLength(2);

      // The second failure waits the longer step.
      timer.advanceTime(1_000);
      expect((await sweeper.sweep()).skipped[0]?.reason).toBe("backoff");
      timer.advanceTime(3_000);
      const third = await sweeper.sweep();
      expect(third.stopped).toHaveLength(1);
      expect(stopper.calls).toHaveLength(3);
      expect((await registry.listFreeDevices())[0]?.state).toBe("stopped");
    });

    test("a stopper that throws is a failure, not a crash", async () => {
      await freeDevice("amslot-a");
      pastThreshold();
      stopper.beforeStop = async () => {
        throw new Error("boom");
      };

      const report = await reclaimer().sweep();

      expect(report.failed).toEqual([
        { platform: "android", stableDeviceId: "amslot-a", message: "boom" },
      ]);
    });
  });

  test("a daemon restart resumes a device left stopping", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    stopper.results = [{ kind: "failed", message: "daemon died mid-stop" }];
    await reclaimer().sweep();

    // A new daemon has no backoff memory and retries the interrupted shutdown at once.
    const restarted = await reclaimer().sweep();

    expect(restarted.stopped).toHaveLength(1);
    expect((await registry.listFreeDevices())[0]?.state).toBe("stopped");
  });

  test("sweeps are single-flight", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    let release!: () => void;
    stopper.beforeStop = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const sweeper = reclaimer();

    const first = sweeper.sweep();
    const second = sweeper.sweep();
    expect(second).toBe(first);
    await flush();
    release();
    await first;

    expect(stopper.calls).toHaveLength(1);
  });

  test("does not open a registry that does not exist", async () => {
    let opened = 0;
    const sweeper = reclaimer({
      registry: async () => {
        opened += 1;
        return registry;
      },
      registryExists: () => false,
    });

    expect(await sweeper.sweep()).toEqual({ stopped: [], failed: [], skipped: [] });
    expect(opened).toBe(0);
  });

  test("runs on the injected timer until stopped", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    const sweeper = reclaimer();

    sweeper.start();
    sweeper.start();
    timer.advanceTime(FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS);
    await flush();
    expect(stopper.calls).toHaveLength(1);

    sweeper.stop();
    await freeDevice("amslot-b", "runner-b");
    pastThreshold();
    timer.advanceTime(FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS * 2);
    await flush();
    expect(stopper.calls).toHaveLength(1);
  });
});
