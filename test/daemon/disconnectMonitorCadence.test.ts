import { describe, expect, test } from "bun:test";
import {
  DisconnectMonitorSchedule,
  eligibleIdleSweepSignature,
  idleSweepInterval,
  idleSweepSignature,
  nextIdleSweepState,
  selectDisconnectScope,
} from "../../src/daemon/disconnectMonitorCadence";

describe("disconnect monitor cadence decisions", () => {
  test("idle intervals double from baseline and cap at two minutes", () => {
    expect([0, 1, 2, 3, 100].map((n) => idleSweepInterval(30_000, n))).toEqual([
      30_000, 60_000, 120_000, 120_000, 120_000,
    ]);
    expect(idleSweepInterval(40, 3, 100)).toBe(100);
  });
  test("signature sorts ids and distinguishes pool from discovery", () => {
    expect(idleSweepSignature(["b", "a"], ["d", "c"], new Set(["ios", "android"]))).toBe(
      idleSweepSignature(["a", "b"], ["c", "d"], new Set(["android", "ios"])),
    );
    expect(idleSweepSignature(["a"], ["b"], new Set(["android"]))).not.toBe(
      idleSweepSignature(["b"], ["a"], new Set(["android"])),
    );
  });
  test("signature changes with succeeded platforms", () => {
    expect(idleSweepSignature(["a"], ["a"], new Set(["android"]))).not.toBe(
      idleSweepSignature(["a"], ["a"], new Set(["android", "ios"])),
    );
  });
  test("unchanged increments; changed, failed or missing evidence resets baseline", () => {
    const baseline = nextIdleSweepState(undefined, "a");
    expect(baseline).toEqual({ signature: "a", unchanged: 0 });
    expect(nextIdleSweepState(baseline, "a")).toEqual({ signature: "a", unchanged: 1 });
    expect(nextIdleSweepState({ signature: "a", unchanged: 3 }, "b")).toEqual({
      signature: "b",
      unchanged: 0,
    });
    expect(nextIdleSweepState(baseline, undefined)).toBeUndefined();
  });
  test("scope uses all tracked platforms and forces periodic full discovery", () => {
    expect(selectDisconnectScope(["ios"], 5_000, undefined, 30_000)).toBe("either");
    expect(selectDisconnectScope(["ios", "ios"], 10_000, 5_000, 30_000)).toBe("ios");
    expect(selectDisconnectScope(["android"], 10_000, 5_000, 30_000)).toBe("android");
    expect(selectDisconnectScope(["ios", "android"], 10_000, 5_000, 30_000)).toBe("either");
    expect(selectDisconnectScope([], 10_000, 5_000, 30_000)).toBe("either");
    expect(selectDisconnectScope(["ios"], 35_000, 5_000, 30_000)).toBe("either");
  });
});

describe("disconnect monitor schedule", () => {
  const cadence = { activeIntervalMs: 5_000, idleIntervalMs: 30_000 };

  test("idle admission starts from construction time and caps repeated successes", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 1_000);
    let now = 1_000;
    for (const interval of [30_000, 30_000, 60_000, 120_000, 120_000, 120_000]) {
      expect(schedule.shouldRun(false, now + interval - 1)).toBe(false);
      now += interval;
      expect(schedule.shouldRun(false, now)).toBe(true);
      schedule.recordSuccess("stable");
    }
  });

  test("admission respects an injected backoff cap", () => {
    const schedule = new DisconnectMonitorSchedule(
      { activeIntervalMs: 10, idleIntervalMs: 40, maxIdleIntervalMs: 100 },
      0,
    );
    let now = 0;
    for (const interval of [40, 40, 80, 100, 100]) {
      expect(schedule.shouldRun(false, now + interval - 1)).toBe(false);
      now += interval;
      expect(schedule.shouldRun(false, now)).toBe(true);
      schedule.recordSuccess("stable");
    }
  });

  test("changed or missing signatures reset the idle baseline", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    for (const now of [30_000, 60_000, 120_000]) {
      expect(schedule.shouldRun(false, now)).toBe(true);
      schedule.recordSuccess("stable");
    }
    expect(schedule.shouldRun(false, 240_000)).toBe(true);
    schedule.recordSuccess("changed");
    expect(schedule.shouldRun(false, 269_999)).toBe(false);
    expect(schedule.shouldRun(false, 270_000)).toBe(true);
    schedule.recordSuccess("changed");
    expect(schedule.shouldRun(false, 330_000)).toBe(true);
    schedule.recordSuccess(undefined);
    expect(schedule.shouldRun(false, 359_999)).toBe(false);
    expect(schedule.shouldRun(false, 360_000)).toBe(true);
  });

  test("watching admits immediately, clears backoff, and ignores success evidence", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    for (const now of [30_000, 60_000, 120_000]) {
      expect(schedule.shouldRun(false, now)).toBe(true);
      schedule.recordSuccess("stable");
    }
    expect(schedule.shouldRun(true, 125_000)).toBe(true);
    schedule.recordSuccess("stable");
    expect(schedule.shouldRun(true, 130_000)).toBe(true);
    schedule.recordSuccess("stable");
    expect(schedule.shouldRun(false, 159_999)).toBe(false);
    expect(schedule.shouldRun(false, 160_000)).toBe(true);
    schedule.recordSuccess("stable");
    expect(schedule.shouldRun(false, 189_999)).toBe(false);
    expect(schedule.shouldRun(false, 190_000)).toBe(true);
  });

  test("watching scopes homogeneous platforms until a periodic full sweep", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    expect(schedule.shouldRun(true, 5_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 5_000, false)).toBe("either");
    expect(schedule.shouldRun(true, 10_000)).toBe(true);
    expect(schedule.selectPlatform(["ios", "ios"], 10_000, false)).toBe("ios");
    expect(schedule.selectPlatform(["android"], 15_000, false)).toBe("android");
    expect(schedule.selectPlatform(["ios"], 34_999, false)).toBe("ios");
    expect(schedule.selectPlatform(["ios"], 35_000, false)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 40_000, false)).toBe("ios");
  });

  test("idle, mixed and empty platforms force full sweeps and record their time", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    expect(schedule.shouldRun(false, 30_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 30_000, false)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 35_000, false)).toBe("either");
    expect(schedule.shouldRun(true, 40_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 40_000, false)).toBe("either");
    expect(schedule.selectPlatform(["ios", "android"], 45_000, false)).toBe("either");
    expect(schedule.selectPlatform([], 50_000, false)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 79_999, false)).toBe("ios");
    expect(schedule.selectPlatform(["ios"], 80_000, false)).toBe("either");
  });

  test("entering watching resets full-sweep history even after an idle full sweep", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    expect(schedule.shouldRun(false, 30_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 30_000, false)).toBe("either");
    expect(schedule.shouldRun(true, 35_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 35_000, false)).toBe("either");
    expect(schedule.shouldRun(true, 40_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 40_000, false)).toBe("ios");
  });

  test("plan activity forces either even with one tracked platform and refreshes history", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    expect(schedule.shouldRun(true, 5_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 5_000, false)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 10_000, false)).toBe("ios");
    expect(schedule.selectPlatform(["ios"], 15_000, true)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 20_000, true)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 49_999, false)).toBe("ios");
    expect(schedule.selectPlatform(["ios"], 50_000, false)).toBe("either");
  });

  test("failure resets idle backoff without moving the last admitted time", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    for (const now of [30_000, 60_000, 120_000]) {
      expect(schedule.shouldRun(false, now)).toBe(true);
      schedule.recordSuccess("stable");
    }
    expect(schedule.shouldRun(false, 240_000)).toBe(true);
    schedule.recordFailure();
    expect(schedule.shouldRun(false, 269_999)).toBe(false);
    expect(schedule.shouldRun(false, 270_000)).toBe(true);
    schedule.recordSuccess("stable");
    expect(schedule.shouldRun(false, 300_000)).toBe(true);
  });

  test("failure forces a full sweep on the next continuously watched admission", () => {
    const schedule = new DisconnectMonitorSchedule(cadence, 0);
    expect(schedule.shouldRun(true, 5_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 5_000, false)).toBe("either");
    expect(schedule.selectPlatform(["ios"], 10_000, false)).toBe("ios");
    schedule.recordFailure();
    expect(schedule.shouldRun(true, 15_000)).toBe(true);
    expect(schedule.selectPlatform(["ios"], 15_000, false)).toBe("either");
  });
});

describe("idle signature eligibility", () => {
  test("successful discovery with no misses and all candidates booted yields a signature", () => {
    const platforms = new Set<"android" | "ios">(["ios"]);
    const booted = new Set(["sim-1", "sim-2"]);
    expect(eligibleIdleSweepSignature(platforms, 0, ["sim-1"], booted, ["sim-1"])).toBe(
      idleSweepSignature(booted, ["sim-1"], platforms),
    );
  });

  test("no successful platforms, outstanding misses or an absent candidate prevents backoff", () => {
    const platforms = new Set<"android" | "ios">(["ios"]);
    const booted = new Set(["sim-1"]);
    expect(eligibleIdleSweepSignature(new Set(), 0, ["sim-1"], booted, [])).toBeUndefined();
    expect(eligibleIdleSweepSignature(platforms, 1, ["sim-1"], booted, [])).toBeUndefined();
    expect(eligibleIdleSweepSignature(platforms, 0, ["sim-2"], booted, [])).toBeUndefined();
  });

  test("an empty pool and candidate set can back off after successful discovery", () => {
    const platforms = new Set<"android" | "ios">(["android"]);
    expect(eligibleIdleSweepSignature(platforms, 0, [], new Set(), [])).toBe(
      idleSweepSignature([], [], platforms),
    );
    expect(eligibleIdleSweepSignature(new Set(), 0, [], new Set(), [])).toBeUndefined();
  });
});
