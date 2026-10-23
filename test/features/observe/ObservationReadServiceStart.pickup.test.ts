import { expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { ObservationReadServiceStart } from "../../../src/features/observe/ObservationReadServiceStart";
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import { observationServiceStartHarness } from "../../helpers/observationServiceStartHarness";

function harness() {
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
    ownershipGuard: { canStart: () => state.pooled && state.allowed },
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
