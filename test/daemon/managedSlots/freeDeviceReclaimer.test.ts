import type {
  ManagedSlotCacheEvictor,
  ManagedSlotEvictionCandidate,
  ManagedSlotEvictionResult,
} from "../../../src/daemon/managedSlots/managedSlotCacheEviction";
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
  FREE_DEVICE_STOP_CLAIM_STALE_MS,
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
      claimedBy: "daemon-1",
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

    expect(report).toEqual({ stopped: [], released: [], failed: [], skipped: [] });
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
      // The claim is reverted: the device is adoptable again, not left unadoptable.
      expect((await registry.listFreeDevices())[0]).toMatchObject({
        state: "free",
        stopClaimedBy: null,
      });

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

  test("a never-succeeding kill is bounded: backed off, and adoptable between attempts", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    stopper.results = Array.from({ length: 50 }, () => ({
      kind: "failed" as const,
      message: "wedged emulator",
    }));
    const sweeper = reclaimer({ backoff: [60_000] });

    for (let sweep = 0; sweep < 20; sweep += 1) {
      await sweeper.sweep();
    }
    // Twenty sweeps at one instant: one attempt, never a hot loop.
    expect(stopper.calls).toHaveLength(1);
    expect((await registry.listFreeDevices())[0]?.state).toBe("free");

    for (let attempt = 2; attempt <= 4; attempt += 1) {
      timer.advanceTime(60_000);
      await sweeper.sweep();
      expect(stopper.calls).toHaveLength(attempt);
      // After every failed attempt the row is `free` again, so a slot can adopt it.
      expect((await registry.listFreeDevices())[0]?.state).toBe("free");
    }
  });

  test("a device with no pooled runtime reverts immediately and stays adoptable", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    stopper.results = [{ kind: "failed", message: "pool has no runtime" }];

    await reclaimer().sweep();

    expect((await registry.listFreeDevices())[0]?.state).toBe("free");
  });

  test("daemon death mid-stop: the next daemon recovers once the dead claim is stale", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    const [free] = await registry.listFreeDevices();
    // daemon-1 claimed the stop and died before finishing.
    await registry.beginFreeDeviceStop({ ...free!, claimedBy: "daemon-1" });
    const next = reclaimer({ claimedBy: "daemon-2" });

    // While the dead claim is still live the new daemon leaves the row alone.
    expect((await next.sweep()).skipped).toEqual([
      { platform: "android", stableDeviceId: "amslot-a", reason: "not_reclaimable" },
    ]);
    expect(stopper.calls).toEqual([]);

    timer.advanceTime(FREE_DEVICE_STOP_CLAIM_STALE_MS);
    const recovered = await next.sweep();

    expect(recovered.stopped).toHaveLength(1);
    expect((await registry.listFreeDevices())[0]).toMatchObject({
      state: "stopped",
      stopClaimedBy: null,
    });
  });

  test("the stopper is handed a claim check that is true only while the row is ours", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    let seen: boolean[] = [];
    stopper.beforeStop = async () => {
      const [call] = stopper.calls;
      seen = [await call!.stillClaimed()];
      // Another daemon takes the stale claim over mid-stop.
      timer.advanceTime(FREE_DEVICE_STOP_CLAIM_STALE_MS);
      const [row] = await registry.listFreeDevices();
      await registry.beginFreeDeviceStop({ ...row!, claimedBy: "daemon-2" });
      seen.push(await call!.stillClaimed());
    };

    const report = await reclaimer().sweep();

    expect(seen).toEqual([true, false]);
    // The original claimer lost the row: it neither completes nor reverts it.
    expect(report.stopped).toEqual([]);
    expect((await registry.listFreeDevices())[0]).toMatchObject({
      state: "stopping",
      stopClaimedBy: "daemon-2",
    });
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

    expect(await sweeper.sweep()).toEqual({ stopped: [], released: [], failed: [], skipped: [] });
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

  class FakeAbsentEvictor implements ManagedSlotCacheEvictor {
    calls: ManagedSlotEvictionCandidate[] = [];
    result: ManagedSlotEvictionResult = { kind: "absent" };
    error: Error | undefined;
    async evict(candidate: ManagedSlotEvictionCandidate): Promise<ManagedSlotEvictionResult> {
      this.calls.push(candidate);
      if (this.error) {
        throw this.error;
      }
      return this.result;
    }
  }

  test.each(["free", "stopped"] as const)(
    "two complete sweeps release a missing %s row",
    async (state) => {
      await freeDevice("amslot-a");
      const [row] = await registry.listFreeDevices();
      if (state === "stopped") {
        const claim = { ...row!, claimedBy: "stopper" };
        await registry.beginFreeDeviceStop(claim, { thresholdMs: 0 });
        await registry.completeFreeDeviceStop(claim);
      }
      inventory.remove("amslot-a");
      pastThreshold();
      const evictor = new FakeAbsentEvictor();
      const sweep = reclaimer({ absentRowEvictor: () => evictor });
      let listings = 0;
      inventory.beforeList = async () => {
        listings++;
      };
      expect((await sweep.sweep()).skipped[0]?.reason).toBe("absence_unconfirmed");
      expect(evictor.calls).toEqual([]);
      expect((await sweep.sweep()).released).toEqual([
        { platform: "android", stableDeviceId: "amslot-a" },
      ]);
      expect(listings).toBe(3);
      expect(evictor.calls).toEqual([
        {
          platform: row!.platform,
          stableDeviceId: row!.stableDeviceId,
          fromScopeKey: row!.fromScopeKey,
          freedAtMs: row!.freedAtMs,
          name: row!.stableDeviceId,
          lastUsedAtMs: row!.freedAtMs,
          absent: true,
        },
      ]);
    },
  );

  test("pre-check reappearance skips eviction and restarts absence observations", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    inventory.remove("amslot-a");
    const evictor = new FakeAbsentEvictor();
    const sweep = reclaimer({ absentRowEvictor: () => evictor });
    await sweep.sweep();
    timer.advanceTime(FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS);
    let listings = 0;
    inventory.beforeList = async () => {
      if (++listings === 2) {
        inventory.devices.push(avd("amslot-a"));
      }
    };
    const report = await sweep.sweep();
    expect(report.skipped).toEqual([
      { platform: "android", stableDeviceId: "amslot-a", reason: "reappeared" },
    ]);
    expect(report.released).toEqual([]);
    expect(evictor.calls).toEqual([]);
    inventory.beforeList = undefined;
    inventory.remove("amslot-a");
    timer.advanceTime(FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS);
    expect((await sweep.sweep()).skipped[0]?.reason).toBe("absence_unconfirmed");
    expect(evictor.calls).toEqual([]);
  });

  test.each(["incomplete", "throw"] as const)(
    "pre-check %s keeps the absence observation without eviction",
    async (kind) => {
      await freeDevice("amslot-a");
      pastThreshold();
      inventory.remove("amslot-a");
      const evictor = new FakeAbsentEvictor();
      const sweep = reclaimer({ absentRowEvictor: () => evictor });
      await sweep.sweep();
      timer.advanceTime(FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS);
      let listings = 0;
      inventory.beforeList = async () => {
        if (++listings !== 2) {
          return;
        }
        if (kind === "throw") {
          throw new Error("inventory hiccup");
        }
        inventory.complete = false;
      };
      const report = await sweep.sweep();
      expect(report.skipped[0]?.reason).toBe("discovery_incomplete");
      expect(report.released).toEqual([]);
      expect(evictor.calls).toEqual([]);
      inventory.beforeList = undefined;
      inventory.complete = true;
      timer.advanceTime(FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS);
      expect((await sweep.sweep()).released).toHaveLength(1);
    },
  );

  test("listing again clears the per-row absence observation", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    inventory.remove("amslot-a");
    const evictor = new FakeAbsentEvictor();
    const sweep = reclaimer({ absentRowEvictor: () => evictor });
    await sweep.sweep();
    inventory.devices.push(avd("amslot-a"));
    expect((await sweep.sweep()).released).toEqual([]);
    inventory.remove("amslot-a");
    expect((await sweep.sweep()).skipped[0]?.reason).toBe("absence_unconfirmed");
    expect(evictor.calls).toEqual([]);
  });

  test("incomplete discovery neither confirms nor clears absence", async () => {
    await freeDevice("amslot-a");
    pastThreshold();
    inventory.remove("amslot-a");
    const evictor = new FakeAbsentEvictor();
    const sweep = reclaimer({ absentRowEvictor: () => evictor });
    await sweep.sweep();
    inventory.complete = false;
    const incomplete = await sweep.sweep();
    expect(incomplete.skipped[0]?.reason).toBe("discovery_incomplete");
    expect(incomplete.released).toEqual([]);
    expect(evictor.calls).toEqual([]);
    inventory.complete = true;
    expect((await sweep.sweep()).released).toHaveLength(1);
  });

  test.each(["lost", "failed", "throw"] as const)(
    "absent eviction %s is reported without aborting the sweep",
    async (kind) => {
      await freeDevice("amslot-a");
      await freeDevice("amslot-b", "runner-b");
      pastThreshold();
      inventory.devices = [];
      const evictor = new FakeAbsentEvictor();
      if (kind === "throw") {
        evictor.error = new Error("boom");
      } else {
        evictor.result = kind === "lost" ? { kind } : { kind, message: "boom" };
      }
      const sweep = reclaimer({ absentRowEvictor: () => evictor });
      await sweep.sweep();
      const report = await sweep.sweep();
      expect(evictor.calls).toHaveLength(2);
      if (kind === "lost") {
        expect(report.skipped.map((skip) => skip.reason)).toEqual(["row_moved", "row_moved"]);
      } else {
        expect(report.failed.map((failure) => failure.message)).toEqual(["boom", "boom"]);
      }
    },
  );

  test("young missing rows are never considered for release", async () => {
    await freeDevice("amslot-a");
    inventory.devices = [];
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS - 1);
    const evictor = new FakeAbsentEvictor();
    const sweep = reclaimer({ absentRowEvictor: () => evictor });
    expect((await sweep.sweep()).skipped).toEqual([]);
    expect((await sweep.sweep()).released).toEqual([]);
    expect(evictor.calls).toEqual([]);
  });
});
