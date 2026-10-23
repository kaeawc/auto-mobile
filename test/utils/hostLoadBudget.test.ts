import { testOverrides } from "../../src/utils/testOverrides";
import { expect, test } from "bun:test";
import {
  defaultHostLoadReader,
  describeLoadScaledBudget,
  loadScaledBudget,
  retryBudget,
} from "../../src/utils/hostLoadBudget";

test.each([
  [0.4, 1, 30000, 5000, false],
  [1, 1, 30000, 5000, false],
  [6, 2, 30000, 15000, false],
  [8, 1, 30000, 30000, true],
  [null, 1, 30000, 5000, false],
  [8, 0, 30000, 5000, false],
  [3, 1, 1000, 5000, true],
] as const)("load %s on %s cores with ceiling %s", (load, cores, ceilingMs, expected, capped) => {
  const budget = loadScaledBudget(
    { baseMs: 5000, ceilingMs },
    {
      loadAverage1m: () => load,
      cpuCount: () => cores,
    },
  );
  expect(budget.budgetMs).toBe(expected);
  expect(budget.capped).toBe(capped);
  expect(retryBudget(budget)).toBe(Math.min(Math.max(5000, ceilingMs), expected * 2));
});

test("descriptions distinguish idle, unknown and capped load", () => {
  const budget = (load: number | null) =>
    loadScaledBudget(
      { baseMs: 5000, ceilingMs: 30000 },
      {
        loadAverage1m: () => load,
        cpuCount: () => 1,
      },
    );
  expect(describeLoadScaledBudget(budget(0.4))).toBe("budget 5000ms (base, host load 0.4/core)");
  expect(describeLoadScaledBudget(budget(null))).toContain("host load unknown");
  expect(describeLoadScaledBudget(budget(6.3))).toContain("30000ms (base");
  expect(describeLoadScaledBudget(budget(6.3))).toContain("capped at ceiling 30000ms");
});

test("default host load override is resolved lazily", () => {
  const previous = testOverrides.hostLoad;
  const idle = { loadAverage1m: () => 0, cpuCount: () => 1 };
  const loaded = { loadAverage1m: () => 6, cpuCount: () => 2 };
  try {
    testOverrides.hostLoad = idle;
    expect(defaultHostLoadReader()).toBe(idle);
    testOverrides.hostLoad = loaded;
    expect(defaultHostLoadReader()).toBe(loaded);
  } finally {
    testOverrides.hostLoad = previous;
  }
});
