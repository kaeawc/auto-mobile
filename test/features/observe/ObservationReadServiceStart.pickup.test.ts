import { expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  ObservationReadServiceStart,
  ServiceStartTransitionDeclinedError,
  daemonObservationServiceOwnershipGuard,
} from "../../../src/features/observe/ObservationReadServiceStart";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  acquireDeviceReadinessLock,
  deviceReadinessLockKey,
} from "../../../src/utils/deviceReadinessLock";
import { drainUntil, drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { observationServiceStartHarness } from "../../helpers/observationServiceStartHarness";

function harness(
  awaitTransition?: (device: BootedDevice, signal?: AbortSignal) => Promise<boolean>,
) {
  const timer = new FakeTimer();
  const device: BootedDevice = {
    deviceId: "late-device",
    name: "Late device",
    platform: "android",
  };
  const state = {
    available: true,
    pooled: false,
    allowed: true,
    pickupCalls: 0,
    readinessCalls: 0,
  };
  let pickup = async () => {};
  const starter = new ObservationReadServiceStart({
    timer,
    ownershipGuard: { canStart: () => state.pooled && state.allowed, awaitTransition },
    poolPickup: {
      available: () => state.available,
      isPooled: () => state.pooled,
      ensurePooled: async () => {
        state.pickupCalls++;
        await pickup();
      },
    },
    readiness: {
      ensureReady: async (request) => {
        state.readinessCalls++;
        request.assertCanSetup?.();
      },
    },
    isServiceConnected: () => false,
    skipCtrlProxyDownload: () => true,
  });
  return {
    timer,
    device,
    state,
    setPickup: (value: typeof pickup) => {
      pickup = value;
    },
    start: (signal?: AbortSignal) =>
      starter.start({ device, deadlineMs: timer.now() + 100, signal }),
  };
}

const unknownMessage =
  "Device late-device is running but not known to this daemon's device pool; call startDevice for it (or retry once the daemon has discovered it).";

test("unpooled read picks up once and proceeds to readiness", async () => {
  const h = harness();
  h.setPickup(async () => {
    h.state.pooled = true;
  });
  expect(await h.start()).toBe(true);
  expect(h.state.pickupCalls).toBe(1);
  expect(h.state.readinessCalls).toBe(1);
});

test("still unpooled read returns actionable device and startDevice guidance", async () => {
  const h = harness();
  await expect(h.start()).rejects.toBeInstanceOf(ActionableError);
  await expect(h.start()).rejects.toThrow(unknownMessage);
  expect(h.state.readinessCalls).toBe(0);
});

test("unavailable pickup keeps the original service start decline", async () => {
  const h = harness();
  h.state.available = false;
  await expect(h.start()).rejects.toThrow(
    "service start declined: ownership or pool transition cannot be excluded",
  );
  expect(h.state.pickupCalls).toBe(0);
  expect(h.state.readinessCalls).toBe(0);
});

test("pooled but held decline never invokes pickup", async () => {
  const h = harness();
  h.state.pooled = true;
  h.state.allowed = false;
  await expect(h.start()).rejects.toThrow(
    "service start declined: ownership or pool transition cannot be excluded",
  );
  expect(h.state.pickupCalls).toBe(0);
});

test("concurrent unpooled starts share one pickup", async () => {
  const h = harness();
  const pending = Promise.withResolvers<void>();
  h.setPickup(async () => {
    await pending.promise;
    h.state.pooled = true;
  });
  const first = h.start();
  const second = h.start();
  await drainUntil(() => h.state.pickupCalls === 1, { description: "pickup" });
  pending.resolve();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(h.state.pickupCalls).toBe(1);
});

test("negative pickup is throttled for ten seconds using FakeTimer", async () => {
  const h = harness();
  await expect(h.start()).rejects.toThrow(unknownMessage);
  h.timer.advanceTime(9999);
  await expect(h.start()).rejects.toThrow(unknownMessage);
  expect(h.state.pickupCalls).toBe(1);
  h.timer.advanceTime(2);
  await expect(h.start()).rejects.toThrow(unknownMessage);
  expect(h.state.pickupCalls).toBe(2);
});

test("pickup failure warns with the underlying error and returns typed guidance", async () => {
  const h = harness();
  const failure = new ActionableError("Android transport has no proven identity");
  h.setPickup(async () => {
    throw failure;
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const first = h.start();
    const second = h.start();
    for (const result of await Promise.allSettled([first, second])) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(ActionableError);
        expect(result.reason.message).toBe(
          `Device late-device is running but could not be added to this daemon's device pool: ${failure.message}; call startDevice for it.`,
        );
      }
    }
    expect(h.state.pickupCalls).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      `[observe] Device pool pickup failed: ${failure.message}`,
      failure,
    );
  } finally {
    warn.mockRestore();
  }
});

test.each(["deadline", "abort"])("pickup wait is bounded by request %s", async (kind) => {
  const h = harness();
  h.setPickup(async () => new Promise<void>(() => {}));
  const controller = new AbortController();
  const pending = h.start(controller.signal);
  await drainUntil(() => h.state.pickupCalls === 1, { description: "pickup" });
  if (kind === "abort") {
    controller.abort(new Error("read cancelled"));
  } else {
    h.timer.advanceTime(100);
  }
  await expect(pending).rejects.toThrow(kind === "abort" ? "read cancelled" : "timed out");
  expect(h.state.readinessCalls).toBe(0);
});

test("default daemon pickup uses fenced pickup through its narrow writes view", async () => {
  const h = await observationServiceStartHarness();
  const pooled = h.pool.getDevice(h.device.deviceId);
  let discovered = false;
  const lookup = spyOn(h.pool, "getDevice").mockImplementation(() => (discovered ? pooled : null));
  const refresh = spyOn(h.pool, "refreshDevices").mockResolvedValue(0);
  const add = spyOn(h.pool, "addDevice");
  const pickup = spyOn(h.pool, "pickUpRunningDevice").mockImplementation(async () => {
    discovered = true;
  });
  let readinessCalls = 0;
  const starter = new ObservationReadServiceStart({
    timer: h.timer,
    readiness: {
      ensureReady: async () => {
        readinessCalls++;
      },
    },
    isServiceConnected: () => false,
  });
  try {
    expect(await starter.start({ device: h.device, deadlineMs: h.timer.now() + 100 })).toBe(true);
    expect(pickup).toHaveBeenCalledTimes(1);
    expect(pickup).toHaveBeenCalledWith(h.device);
    expect(add).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(readinessCalls).toBe(1);
  } finally {
    lookup.mockRestore();
    refresh.mockRestore();
    add.mockRestore();
    pickup.mockRestore();
    h.close();
  }
});

const decline = "service start declined: ownership or pool transition cannot be excluded";

test.each([false, true])("transition parks admission (already pooled: %s)", async (pooled) => {
  const gate = Promise.withResolvers<boolean>();
  let waits = 0;
  const h = harness(async () => {
    waits++;
    return gate.promise;
  });
  h.state.pooled = pooled;
  h.state.allowed = false;
  h.setPickup(async () => {
    h.state.pooled = true;
  });
  const pending = h.start();
  void pending.catch(() => {});
  await drainUntil(() => waits === 1, { description: "transition wait" });
  expect(h.state.readinessCalls).toBe(0);
  h.state.allowed = true;
  gate.resolve(true);
  expect(await pending).toBe(true);
  expect(h.state.readinessCalls).toBe(1);
});

test("three first pickups hand the shared mutex to the next pickup", async () => {
  const timer = new FakeTimer();
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const pickups = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const pooled = new Set<string>();
  let owner = 0;
  let waits = 0;
  let readiness = 0;
  const starter = new ObservationReadServiceStart({
    timer,
    ownershipGuard: {
      canStart: (device) => pooled.has(device.deviceId) && owner === 3,
      awaitTransition: async () => {
        waits++;
        if (owner === 3) {
          return false;
        }
        await gates[owner]!.promise;
        return true;
      },
    },
    poolPickup: {
      available: () => true,
      isPooled: (device) => pooled.has(device.deviceId),
      ensurePooled: async (device) => {
        const index = Number(device.deviceId);
        if (index > 0) {
          await gates[index - 1]!.promise;
        }
        await pickups[index]!.promise;
        pooled.add(device.deviceId);
        owner = index + 1;
        gates[index]!.resolve();
      },
    },
    readiness: {
      ensureReady: async (request) => {
        request.assertCanSetup?.();
        readiness++;
      },
    },
    isServiceConnected: () => false,
  });
  const starts = [0, 1, 2].map((index) =>
    starter.start({
      device: { deviceId: String(index), name: String(index), platform: "android" },
      deadlineMs: 100,
    }),
  );
  for (const pending of starts) {
    void pending.catch(() => {});
  }
  // Each release hands the mutex to the next queued pickup before admission rechecks.
  pickups[0]!.resolve();
  await drainUntil(() => waits === 1, { description: "first admission sees second pickup mutex" });
  pickups[1]!.resolve();
  await drainUntil(() => waits >= 3, { description: "both admissions see third pickup mutex" });
  pickups[2]!.resolve();
  expect(await Promise.all(starts)).toEqual([true, true, true]);
  expect(readiness).toBe(3);
});

test("persistent decline stops without timer waits", async () => {
  let probes = 0;
  const h = harness(async () => {
    probes++;
    return false;
  });
  h.state.pooled = true;
  h.state.allowed = false;
  await expect(h.start()).rejects.toThrow(decline);
  expect(probes).toBe(1);
  expect(h.timer.getSleepCallCount()).toBe(0);
  expect(h.timer.now()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test.each(["deadline", "abort"])("transition wait respects %s", async (kind) => {
  const gate = Promise.withResolvers<boolean>();
  let waiting = false;
  const h = harness(async () => {
    waiting = true;
    return gate.promise;
  });
  h.state.pooled = true;
  h.state.allowed = false;
  const controller = new AbortController();
  const pending = h.start(controller.signal);
  const reason = new Error("transition cancelled");
  void pending.catch(() => {});
  await drainUntil(() => waiting, { description: "transition" });
  if (kind === "abort") {
    controller.abort(reason);
  } else {
    h.timer.advanceTime(101);
  }
  if (kind === "abort") {
    await expect(pending).rejects.toBe(reason);
  } else {
    await expect(pending).rejects.toThrow("timed out");
  }
  expect(h.state.readinessCalls).toBe(0);
});

test("transition retry cap stops after eight waits", async () => {
  let waits = 0;
  let settled = false;
  const h = harness(async () => {
    waits++;
    return true;
  });
  h.state.pooled = true;
  h.state.allowed = false;
  const pending = h.start();
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // A bounded microtask drain makes removal of the cap fail without hanging the suite.
  await drainUntil(() => settled || waits > 8, { description: "bounded admission" });
  const attempts = waits;
  if (attempts > 8) {
    h.state.allowed = true;
    await pending;
  } else {
    await expect(pending).rejects.toThrow(decline);
  }
  expect(attempts).toBe(8);
});

test("guard without a transition hook retains the post-pickup decline", async () => {
  const h = harness();
  h.state.allowed = false;
  h.setPickup(async () => {
    h.state.pooled = true;
  });
  await expect(h.start()).rejects.toThrow(decline);
  expect(h.state.pickupCalls).toBe(1);
  expect(h.state.readinessCalls).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

function recheckHarness(wait: (signal?: AbortSignal) => Promise<boolean>) {
  const timer = new FakeTimer();
  const device: BootedDevice = { deviceId: "recheck", name: "Recheck", platform: "ios" };
  let allowed = true;
  let calls = 0;
  const starter = new ObservationReadServiceStart({
    timer,
    ownershipGuard: {
      canStart: () => allowed,
      awaitTransition: (_device, signal) => wait(signal),
    },
    isServiceConnected: () => false,
    readiness: {
      ensureReady: async (request) => {
        calls++;
        allowed = false;
        request.assertCanSetup?.();
      },
    },
  });
  return {
    timer,
    device,
    starter,
    calls: () => calls,
    allow: () => {
      allowed = true;
    },
  };
}

test("readiness re-check stops after eight assignment waits", async () => {
  let waits = 0;
  let settled = false;
  const h = recheckHarness(async () => {
    waits++;
    return true;
  });
  const pending = h.starter.start({ device: h.device, deadlineMs: 100 });
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await drainUntil(() => settled || waits > 8, { description: "bounded setup retries" });
  const attempts = waits;
  // Terminate even a mutated unbounded loop, so a failed assertion cannot hang tests.
  if (attempts > 8) {
    h.timer.advanceTime(60_000);
  }
  await expect(pending).rejects.toBeInstanceOf(ServiceStartTransitionDeclinedError);
  expect(attempts).toBe(8);
  expect(h.calls()).toBe(9);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("readiness re-check immediately retains decline for a non-transient hold", async () => {
  let waits = 0;
  const h = recheckHarness(async () => {
    waits++;
    return false;
  });
  await expect(h.starter.start({ device: h.device, deadlineMs: 100 })).rejects.toBeInstanceOf(
    ServiceStartTransitionDeclinedError,
  );
  expect(waits).toBe(1);
  expect(h.calls()).toBe(1);
});

test("readiness re-check retains decline when its flight deadline expires while parked", async () => {
  let waits = 0;
  const h = recheckHarness(async () => {
    waits++;
    return new Promise<boolean>(() => {});
  });
  const first = h.starter.start({ device: h.device, deadlineMs: 100 });
  const firstFailure = first.catch((error: unknown) => error);
  await drainUntil(() => waits === 1, { description: "parked re-check" });
  h.timer.advanceTime(100);
  await firstFailure;
  // Keep a reader beyond the flight's ceiling to see the setup failure directly.
  h.allow();
  const later = h.starter.start({ device: h.device, deadlineMs: 70_000 });
  const failure = later.catch((error: unknown) => error);
  await drainMicrotasks(40);
  h.timer.advanceTime(59_900);
  expect(await failure).toBeInstanceOf(ServiceStartTransitionDeclinedError);
  expect(h.calls()).toBe(1);
  expect(waits).toBe(1);
});

test("request abort cancels the parked readiness re-check without retrying", async () => {
  let waits = 0;
  let flightSignal: AbortSignal | undefined;
  const h = recheckHarness(async (signal) => {
    waits++;
    flightSignal = signal;
    return new Promise<boolean>(() => {});
  });
  const controller = new AbortController();
  const pending = h.starter.start({ device: h.device, deadlineMs: 100, signal: controller.signal });
  const failure = pending.catch((error: unknown) => error);
  await drainUntil(() => waits === 1, { description: "parked re-check" });
  const reason = new Error("caller cancelled transition");
  controller.abort(reason);
  expect(await failure).toBe(reason);
  await drainMicrotasks(40);
  expect(flightSignal?.aborted).toBe(true);
  expect(h.calls()).toBe(1);
  expect(waits).toBe(1);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("three iOS readiness re-checks survive successive real assignment mutex holders", async () => {
  const h = await observationServiceStartHarness("ios");
  const devices = [0, 1, 2].map((index) => ({
    ...h.device,
    deviceId: `ios-recheck-${index}`,
    name: `Recheck ${index}`,
  }));
  await h.pool.initializeWithDevices(devices);
  const unlocks = devices.map(() => Promise.withResolvers<void>());
  const holders: Promise<void>[] = [];
  const calls = new Map<string, number>();
  let admitted = 0;
  let waits = 0;
  const starter = new ObservationReadServiceStart({
    timer: h.timer,
    ownershipGuard: {
      canStart: daemonObservationServiceOwnershipGuard.canStart,
      awaitTransition: async (device, signal) => {
        waits++;
        const waited = await daemonObservationServiceOwnershipGuard.awaitTransition!(
          device,
          signal,
        );
        // Model the next pickup taking the real mutex after unlock but before
        // the resumed ensureReady admission re-check.
        if (!h.pool.testHooks.assignmentMutex.isLocked() && holders.length < 3) {
          const index = holders.length;
          holders.push(
            h.pool.testHooks.assignmentMutex.runExclusive(async () => {
              await unlocks[index]!.promise;
            }),
          );
        }
        return waited;
      },
    },
    isServiceConnected: () => false,
    readiness: {
      ensureReady: async (request) => {
        const id = request.device.deviceId;
        calls.set(id, (calls.get(id) ?? 0) + 1);
        const release = await acquireDeviceReadinessLock(deviceReadinessLockKey("ios", id), {
          timer: h.timer,
          signal: request.signal,
        });
        try {
          if (holders.length === 0) {
            holders.push(
              h.pool.testHooks.assignmentMutex.runExclusive(async () => {
                await unlocks[0]!.promise;
              }),
            );
          }
          request.assertCanSetup?.();
          admitted++;
        } finally {
          release();
        }
      },
    },
  });
  try {
    // All starts pass initial admission before any readiness callback takes the mutex.
    const starts = devices.map((device) => starter.start({ device, deadlineMs: 15_000 }));
    for (const pending of starts) {
      void pending.catch(() => {});
    }
    await drainUntil(() => waits === 3, { description: "all three re-checks parked" });
    expect(admitted).toBe(0);
    unlocks[0]!.resolve();
    await drainUntil(() => waits >= 6, { description: "next holder wins assignment gap" });
    unlocks[1]!.resolve();
    await drainUntil(() => waits >= 9, { description: "third holder wins assignment gap" });
    unlocks[2]!.resolve();
    expect(await Promise.all(starts)).toEqual([true, true, true]);
    expect(admitted).toBe(3);
    expect([...calls.values()]).toEqual([4, 4, 4]);
  } finally {
    for (const unlock of unlocks) {
      unlock.resolve();
    }
    await Promise.all(holders);
    h.close();
  }
});
