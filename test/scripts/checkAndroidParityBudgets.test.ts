import { describe, expect, test } from "bun:test";
import {
  allowedGrowNames,
  compareParityBudgets,
  GOLDENS_DIR,
  goldenNames,
  parseBudgets,
  type ParityBudgetInputs,
} from "../../scripts/prototype/check-android-parity-budgets";

const base = { alpha: 100, beta: 50 };
const baseGoldens = new Set(["alpha", "beta", "gamma"]);

function inputs(overrides: Partial<ParityBudgetInputs>): ParityBudgetInputs {
  return { base, current: base, baseGoldens, allowedGrows: new Set(), ...overrides };
}

describe("compareParityBudgets", () => {
  test("unchanged budgets pass", () => {
    expect(compareParityBudgets(inputs({}))).toEqual({ failures: [], allowed: [] });
  });

  test("raising a budget fails with the golden name and both values", () => {
    const report = compareParityBudgets(inputs({ current: { alpha: 101, beta: 50 } }));
    expect(report.failures).toEqual(["alpha: budget raised 100 -> 101"]);
  });

  test("lowering a budget passes", () => {
    expect(compareParityBudgets(inputs({ current: { alpha: 1, beta: 0 } })).failures).toEqual([]);
  });

  test("removing a budget passes", () => {
    expect(compareParityBudgets(inputs({ current: { alpha: 100 } })).failures).toEqual([]);
  });

  test("adding a budget for a new golden passes", () => {
    const report = compareParityBudgets(inputs({ current: { ...base, delta: 9000 } }));
    expect(report.failures).toEqual([]);
  });

  test("budgeting a golden that already existed fails", () => {
    const report = compareParityBudgets(inputs({ current: { ...base, gamma: 7 } }));
    expect(report.failures).toEqual(["gamma: new budget 7 for a golden that already existed"]);
  });

  test("a trailer allows only the golden it names", () => {
    const report = compareParityBudgets(
      inputs({ current: { alpha: 200, beta: 60 }, allowedGrows: new Set(["alpha"]) }),
    );
    expect(report.allowed).toEqual(["alpha: budget raised 100 -> 200"]);
    expect(report.failures).toEqual(["beta: budget raised 50 -> 60"]);
  });

  test("a budgets file new at the merge-base is accepted", () => {
    expect(compareParityBudgets(inputs({ base: undefined, current: { gamma: 5 } }))).toEqual({
      failures: [],
      allowed: [],
    });
  });
});

describe("input parsing", () => {
  test("parseBudgets rejects non-objects and non-integer budgets", () => {
    expect(parseBudgets('{"a":1}', "x")).toEqual({ a: 1 });
    expect(() => parseBudgets("[]", "x")).toThrow("expected a JSON object");
    expect(() => parseBudgets('{"a":1.5}', "x")).toThrow("a is not a non-negative integer");
    expect(() => parseBudgets('{"a":-1}', "x")).toThrow("a is not a non-negative integer");
    expect(() => parseBudgets('{"a":"1"}', "x")).toThrow("a is not a non-negative integer");
  });

  test("goldenNames keeps PNGs directly in the goldens directory", () => {
    expect(
      goldenNames([
        `${GOLDENS_DIR}/alpha.png`,
        `${GOLDENS_DIR}/nested/beta.png`,
        `${GOLDENS_DIR}/notes.txt`,
        "other/gamma.png",
      ]),
    ).toEqual(new Set(["alpha"]));
  });

  test("allowedGrowNames reads repeated and comma-separated trailers", () => {
    expect(
      allowedGrowNames([
        "Parity-Budget-Grow: alpha",
        "parity-budget-grow: beta, gamma",
        "Other-Trailer: delta",
        "",
      ]),
    ).toEqual(new Set(["alpha", "beta", "gamma"]));
  });
});
