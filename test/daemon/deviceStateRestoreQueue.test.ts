import { afterEach, expect, spyOn, test } from "bun:test";
import { DeviceStateRestoreQueue } from "../../src/daemon/deviceStateRestoreQueue";
import { DevicePool } from "../../src/daemon/devicePool";
import { defaultDeviceClockRestoreRegistry } from "../../src/features/utility/DeviceClock";
import { SessionManager } from "../../src/daemon/sessionManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

const policy = {
  kind: "clock",
  retiredOnIncarnationBump: false,
  setupHandoff: "track-eagerly",
  removedDuringSetupMessage: "removed",
} as const;

const idle = () => Promise.resolve({ pending: null });

test("join deduplicates by baseline object and publishes before starting", () => {
  const queue = new DeviceStateRestoreQueue<{ v: number }>(policy);
  const state = { v: 1 };
  let starts = 0;
  let publishedAtStart = false;
  const first = queue.join(
    "d1",
    state,
    () => {},
    () => {
      starts++;
      publishedAtStart = queue.targets.get("d1")?.has(state) ?? false;
      return idle();
    },
  );
  const second = queue.join(
    "d1",
    state,
    () => {},
    () => {
      starts++;
      return idle();
    },
  );
  expect(second).toBe(first);
  expect(starts).toBe(1);
  expect(publishedAtStart).toBe(true);
  queue.join("d1", { v: 1 }, () => {}, idle);
  expect(queue.targets.get("d1")?.size).toBe(2);
});

test("retire bumps the generation, aborts, marks removed and clears every target", () => {
  const queue = new DeviceStateRestoreQueue<{ v: number }>(policy);
  const cleared: number[] = [];
  const state = { v: 1 };
  queue.join("d1", state, () => cleared.push(1), idle);
  const target = queue.targets.get("d1")!.get(state)!;
  expect(queue.generation("d1")).toBe(0);
  queue.retire("d1");
  expect(queue.generation("d1")).toBe(1);
  expect(queue.generation("d2")).toBe(0);
  expect(target.removed).toBe(true);
  expect(target.controller.signal.aborted).toBe(true);
  expect(cleared).toEqual([1]);
  expect(queue.targets.has("d1")).toBe(false);
});

test("a start that rejects rejects the joined result", async () => {
  const queue = new DeviceStateRestoreQueue<object>(policy);
  const result = queue.join(
    "d1",
    {},
    () => {},
    () => Promise.reject(new Error("boom")),
  );
  await expect(result).rejects.toThrow("boom");
});

test("onRetire runs before the queue state is retired", () => {
  const seen: number[] = [];
  const queue = new DeviceStateRestoreQueue<object>(policy, () =>
    seen.push(queue.generation("d1")),
  );
  queue.retire("d1");
  expect(seen).toEqual([0]);
  expect(queue.generation("d1")).toBe(1);
});

const kinds = ["clock", "rotation", "screen-reader"] as const;
type Kind = (typeof kinds)[number];

// Open question for the owner (#11794): a VM restore retires only the clock restore, while device
// removal retires all three. This pins today's behaviour; it does not endorse it.
const causeTable: Array<["removal" | "incarnation-bump", readonly Kind[]]> = [
  ["removal", ["clock", "rotation", "screen-reader"]],
  ["incarnation-bump", ["clock"]],
];

test.each(causeTable)(
  "retireRestorations(%s) retires %j and runs only their side effects",
  (cause, retired) => {
    const manager = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    const deviceId = "emulator-5554";
    const internals = {
      clockRestores: manager["clockRestores"],
      rotationRestores: manager["stateRestore"].rotationRestores,
      screenReaderRestores: manager["stateRestore"].screenReaderRestores,
      abandonedRotations: manager["stateRestore"].abandonedRotations as Map<string, object>,
      abandonedScreenReaders: manager["stateRestore"].abandonedScreenReaders as Map<string, object>,
    };
    const queues: Record<Kind, DeviceStateRestoreQueue<object>> = {
      clock: internals.clockRestores,
      rotation: internals.rotationRestores,
      "screen-reader": internals.screenReaderRestores,
    };
    internals.abandonedRotations.set(deviceId, {});
    internals.abandonedScreenReaders.set(deviceId, {});
    const registryRetire = spyOn(defaultDeviceClockRestoreRegistry, "retire");
    try {
      manager.retireRestorations(deviceId, cause);
      for (const kind of kinds) {
        expect(queues[kind].generation(deviceId)).toBe(retired.includes(kind) ? 1 : 0);
      }
      expect(registryRetire).toHaveBeenCalledTimes(retired.includes("clock") ? 1 : 0);
      expect(internals.abandonedRotations.has(deviceId)).toBe(!retired.includes("rotation"));
      expect(internals.abandonedScreenReaders.has(deviceId)).toBe(
        !retired.includes("screen-reader"),
      );
    } finally {
      registryRetire.mockRestore();
      manager.stopCleanupTimer();
    }
  },
);

afterEach(() => PlatformDeviceManagerFactory.reset());

test("DevicePool: bumpDeviceIncarnation and removeDevice route through retireRestorations with their cause", async () => {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  const utils = new FakeDeviceUtils();
  const device = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
  utils.setBootedDevices("android", [device]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "restore-queue", { timer, deviceManager: utils }),
  );
  const retire = spyOn(manager, "retireRestorations");
  try {
    await pool.initializeWithDevices([device]);
    expect(pool.bumpDeviceIncarnation(device.deviceId)).toBe(true);
    expect(retire.mock.calls).toEqual([[device.deviceId, "incarnation-bump"]]);

    await pool.removeDevice(device.deviceId);
    expect(retire.mock.calls.at(-1)).toEqual([device.deviceId, "removal"]);
  } finally {
    manager.stopCleanupTimer();
  }
});
