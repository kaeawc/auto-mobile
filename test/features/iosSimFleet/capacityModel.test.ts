import { expect, test } from "bun:test";
import { resolveCapacityLimits } from "../../../src/features/iosSimFleet/capacityPolicy";

const GIB = 1024 ** 3;
const host = { totalMemoryBytes: 128 * GIB, cpuCount: 16 };

test("settled CPU replaces the two-core cap while preserving memory sizing", () => {
  expect(resolveCapacityLimits({}, { ...host, totalMemoryBytes: 64 * GIB }).maxBooted).toBe(15);
  expect(resolveCapacityLimits({}, host).maxBooted).toBe(30);
  expect(resolveCapacityLimits({}, host, 2 * GIB).maxBooted).toBe(38);
  expect(resolveCapacityLimits({}, { ...host, cpuCount: 4 }).maxBooted).toBe(20);
  expect(resolveCapacityLimits({}, { ...host, cpuCount: 4 }, 1.5 * GIB).maxBooted).toBe(20);
  expect(resolveCapacityLimits({}, { totalMemoryBytes: 1, cpuCount: 1 }).maxBooted).toBe(1);
});

test("boot burst concurrency derives independently from core count", () => {
  for (const [cpuCount, expected] of [
    [4, 2],
    [8, 2],
    [16, 2],
    [32, 3],
    [64, 5],
    [0, 1],
  ]) {
    expect(resolveCapacityLimits({}, { ...host, cpuCount }).bootConcurrency).toBe(expected);
  }
});

test("both overrides work independently and invalid concurrency warns", () => {
  expect(
    resolveCapacityLimits(
      { AUTOMOBILE_IOS_SIM_MAX_BOOTED: "99", AUTOMOBILE_IOS_SIM_BOOT_CONCURRENCY: "3" },
      host,
    ),
  ).toEqual({ maxBooted: 99, source: "env", bootConcurrency: 3, bootConcurrencySource: "env" });
  for (const value of ["0", "-1", "1.5", "no", "Infinity", "99999999999999999999999999999999"]) {
    expect(
      resolveCapacityLimits({ AUTOMOBILE_IOS_SIM_BOOT_CONCURRENCY: value }, host),
    ).toMatchObject({
      maxBooted: 30,
      bootConcurrency: 2,
      bootConcurrencySource: "derived",
      bootConcurrencyWarning: expect.stringContaining("not a positive integer"),
    });
  }
  expect(resolveCapacityLimits({ AUTOMOBILE_IOS_SIM_MAX_BOOTED: "7" }, host).maxBooted).toBe(7);
});
