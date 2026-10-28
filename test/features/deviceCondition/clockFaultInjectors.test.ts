import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import {
  createClockSkewFaultInjector,
  resolveClockFaultInjector,
} from "../../../src/features/deviceCondition/clockFaultInjectors";
import { deviceConditionInputSchema } from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { resolveIosRefusalInjector } from "../../../src/features/deviceCondition/iosRefusalInjector";
import { DeviceClockRestoreRegistry } from "../../../src/features/utility/DeviceClock";
import { FakeDeviceClockAdapter } from "../../fakes/FakeDeviceClockAdapter";

const HOST_NOW = Date.parse("2026-10-28T12:00:00Z");
const DAY = 86_400;

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

interface Harness {
  clock: FakeDeviceClockAdapter;
  registry: DeviceClockRestoreRegistry;
  invalidated: string[];
  controller: DeviceConditionController;
}

function harness(device: BootedDevice = emulator, automaticTime: 0 | 1 = 1): Harness {
  const clock = new FakeDeviceClockAdapter();
  clock.instantMs = HOST_NOW;
  clock.automaticTime = automaticTime;
  const registry = new DeviceClockRestoreRegistry();
  const invalidated: string[] = [];
  const injector = createClockSkewFaultInjector(device, {
    adapter: () => clock,
    hostClock: { now: () => HOST_NOW },
    registry,
    invalidate: (deviceId) => invalidated.push(deviceId),
  });
  const controller = new DeviceConditionController((key) =>
    key === injector.key ? injector : undefined,
  );
  return { clock, registry, invalidated, controller };
}

const skew = (offsetSeconds: number) => ({ faults: { clockSkew: { offsetSeconds } } });

describe("faults.clockSkew", () => {
  test("moves the clock ahead of real time with automatic time off, and reset restores both", async () => {
    const h = harness();
    const result = await h.controller.apply(skew(DAY));
    expect(result.changes).toEqual([
      {
        key: "faults.clockSkew",
        status: "applied",
        detail: "device clock set to 2026-10-29T12:00:00.000Z (+86400s from real time)",
      },
    ]);
    expect(result.active).toEqual(["faults.clockSkew"]);
    expect(h.clock.instantMs).toBe(HOST_NOW + DAY * 1000);
    expect(h.clock.automaticTime).toBe(0);
    expect(h.invalidated).toEqual(["emulator-5554"]);

    const report = await h.controller.restore();
    expect(report).toEqual({ restored: ["faults.clockSkew"], failures: [], verifiedClean: true });
    expect(h.clock.instantMs).toBe(HOST_NOW);
    expect(h.clock.automaticTime).toBe(1);
    expect(h.clock.calls).toContain("unroot");
  });

  test("a negative offset puts the clock behind real time", async () => {
    const h = harness();
    await h.controller.apply(skew(-DAY));
    expect(h.clock.instantMs).toBe(HOST_NOW - DAY * 1000);
  });

  test("restores automatic time to its original off value", async () => {
    const h = harness(emulator, 0);
    await h.controller.apply(skew(DAY));
    await h.controller.restore();
    expect(h.clock.automaticTime).toBe(0);
    expect(h.clock.instantMs).toBe(HOST_NOW);
  });

  test("a second skew moves the clock again and keeps the first baseline and one reset", async () => {
    const h = harness();
    await h.controller.apply(skew(DAY));
    const second = await h.controller.apply(skew(-3600));
    expect(second.changes[0]?.status).toBe("applied");
    expect(h.clock.instantMs).toBe(HOST_NOW - 3_600_000);

    const report = await h.controller.restore();
    expect(report.restored).toEqual(["faults.clockSkew"]);
    // The original auto_time (1) survives the second skew, which saw it already off.
    expect(h.clock.automaticTime).toBe(1);
  });

  test("unset clears an applied skew", async () => {
    const h = harness();
    await h.controller.apply(skew(DAY));
    const cleared = await h.controller.apply({ faults: { clockSkew: "unset" } });
    expect(cleared.changes).toEqual([{ key: "faults.clockSkew", status: "cleared" }]);
    expect(cleared.active).toEqual([]);
    expect(h.clock.instantMs).toBe(HOST_NOW);
  });

  test("a refused root reports unsupported and changes nothing", async () => {
    const h = harness();
    h.clock.root = false;
    const result = await h.controller.apply(skew(DAY));
    expect(result.success).toBe(false);
    expect(result.changes[0]?.status).toBe("unsupported");
    expect(result.changes[0]?.detail).toContain("rootable Android emulator");
    expect(result.active).toEqual([]);
    expect(h.clock.instantMs).toBe(HOST_NOW);
  });

  test("a physical Android device is unsupported", async () => {
    const h = harness({ name: "pixel", platform: "android", deviceId: "R58M123ABC" });
    const result = await h.controller.apply(skew(DAY));
    expect(result.changes[0]?.status).toBe("unsupported");
    expect(result.changes[0]?.detail).toContain("physical Android devices");
    expect(h.clock.calls).toEqual([]);
  });

  test("a failed clock write still owes the reset, which restores real time", async () => {
    const h = harness();
    h.clock.writeError = new Error("date: cannot set date");
    const result = await h.controller.apply(skew(DAY));
    expect(result.changes[0]?.status).toBe("unsupported");
    expect(result.active).toEqual(["faults.clockSkew"]);

    h.clock.writeError = undefined;
    const report = await h.controller.restore();
    expect(report.verifiedClean).toBe(true);
    expect(h.clock.instantMs).toBe(HOST_NOW);
    expect(h.clock.automaticTime).toBe(1);
  });

  test("a reset that does not verify stays owed and is retried", async () => {
    const h = harness();
    await h.controller.apply(skew(DAY));
    h.clock.readOffsetMs = 60_000;
    const first = await h.controller.restore();
    expect(first.verifiedClean).toBe(false);
    expect(first.failures[0]?.error).toContain("did not restore real time");
    expect(h.controller.activeKeys()).toEqual(["faults.clockSkew"]);

    h.clock.readOffsetMs = 0;
    const retry = await h.controller.restore();
    expect(retry.verifiedClean).toBe(true);
  });

  test("shares the clock baseline with setDeviceState.clock on the same registry", async () => {
    const h = harness();
    // A prior setDeviceState.clock write already recorded the original auto_time (1).
    await h.registry.runExclusive("emulator-5554", async (slot) => {
      slot.record({ initialAutomaticTime: 1, clockChangedByUs: true, rootedByUs: false });
    });
    h.clock.automaticTime = 0;
    await h.controller.apply(skew(DAY));
    await h.controller.restore();
    // The skew did not record its own "auto_time off" as the original.
    expect(Number(h.clock.automaticTime)).toBe(1);
  });
});

describe("faults.clockSkew request shape", () => {
  test("accepts an offset of at least 3 seconds either way, up to ten years", () => {
    for (const offsetSeconds of [3, -3, DAY, 315_360_000, -315_360_000]) {
      expect(deviceConditionInputSchema.safeParse(skew(offsetSeconds)).success).toBe(true);
    }
    expect(deviceConditionInputSchema.safeParse({ faults: { clockSkew: "unset" } }).success).toBe(
      true,
    );
  });

  test("rejects a zero, sub-tolerance, fractional, too-large or extra-field skew", () => {
    for (const clockSkew of [
      { offsetSeconds: 0 },
      { offsetSeconds: 2 },
      { offsetSeconds: -1 },
      { offsetSeconds: 1.5 },
      { offsetSeconds: 315_360_001 },
      { offsetSeconds: DAY, timezone: "UTC" },
      {},
      "on",
    ]) {
      expect(deviceConditionInputSchema.safeParse({ faults: { clockSkew } }).success).toBe(false);
    }
  });
});

describe("resolveClockFaultInjector", () => {
  test("serves only faults.clockSkew on Android, one instance per device", () => {
    const cache = new Map();
    const deps = { cache, registry: new DeviceClockRestoreRegistry() };
    const first = resolveClockFaultInjector(emulator, "faults.clockSkew", deps);
    expect(first?.key).toBe("faults.clockSkew");
    expect(resolveClockFaultInjector(emulator, "faults.clockSkew", deps)).toBe(first);
    expect(resolveClockFaultInjector(emulator, "faults.storage", deps)).toBeUndefined();
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    expect(resolveClockFaultInjector(ios, "faults.clockSkew", deps)).toBeUndefined();
  });

  test("iOS refuses clockSkew with the Android-only reason", async () => {
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    const refusal = resolveIosRefusalInjector(ios, "faults.clockSkew");
    expect(refusal).toBeDefined();
    let message = "";
    try {
      await refusal?.apply("apply");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("unsupported on iOS Simulator");
  });
});
