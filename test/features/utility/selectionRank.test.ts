import { expect, test } from "bun:test";
import {
  compareSelectionRank,
  type SelectionRank,
} from "../../../src/features/utility/selectionRank";

const base: SelectionRank = { windowRank: 0, interactive: false, area: 10, order: 0 };
const rank = (overrides: Partial<SelectionRank> = {}): SelectionRank => ({ ...base, ...overrides });

test("tiers decide in window, interactive, raw, input, area, order priority", () => {
  const cases: [SelectionRank, SelectionRank, boolean, number][] = [
    [
      rank({ windowRank: -1, area: Infinity, order: 99 }),
      rank({ interactive: true, raw: true, input: true }),
      true,
      1,
    ],
    [
      rank({ interactive: true, area: Infinity, order: 99 }),
      rank({ raw: true, input: true }),
      true,
      1,
    ],
    [rank({ raw: true, area: Infinity, order: 99 }), rank({ input: true }), false, 1],
    [rank({ input: true, area: Infinity, order: 99 }), rank(), false, 1],
    [rank({ area: 1, order: 99 }), rank({ area: 2 }), false, 0],
    [rank({ order: 1 }), rank({ order: 2 }), false, 0],
  ];
  for (const [a, b, interactive, input] of cases) {
    expect(compareSelectionRank(a, b, interactive, input)).toBeLessThan(0);
    expect(compareSelectionRank(b, a, interactive, input)).toBeGreaterThan(0);
  }
});

test("interactive preference is disabled by default and explicitly off", () => {
  const a = rank({ interactive: true });
  expect(compareSelectionRank(a, base)).toBe(0);
  expect(compareSelectionRank(a, base, false)).toBe(0);
  expect(compareSelectionRank(a, base, true)).toBe(-1);
});

test("raw absent means false", () => {
  expect(compareSelectionRank(rank({ raw: true }), base)).toBe(-1);
  expect(compareSelectionRank(base, rank({ raw: false }))).toBe(0);
  expect(compareSelectionRank(rank({ raw: true }), rank({ raw: false }))).toBe(-1);
});

test("input absent means false with positive, negative and disabled preferences", () => {
  for (const input of [undefined, false]) {
    const a = rank({ input: true });
    const b = rank({ input });
    expect(compareSelectionRank(a, b, false, 1)).toBe(-1);
    expect(compareSelectionRank(a, b, false, -1)).toBe(1);
    expect(compareSelectionRank(a, b, false, 0)).toBe(0);
    expect(compareSelectionRank(b, a, false, 1)).toBe(1);
  }
});

test("area supports Infinity and ties fall through to order or full equality", () => {
  expect(compareSelectionRank(base, rank({ area: Infinity }))).toBe(-Infinity);
  expect(compareSelectionRank(rank({ area: Infinity }), base)).toBe(Infinity);
  expect(
    compareSelectionRank(rank({ area: Infinity, order: 1 }), rank({ area: Infinity, order: 2 })),
  ).toBe(-1);
  expect(compareSelectionRank(rank({ area: Infinity }), rank({ area: Infinity }))).toBe(0);
  expect(compareSelectionRank(base, rank())).toBe(0);
});

test("absent raw no longer breaks tie transitivity", () => {
  const a = rank({ raw: true });
  const b = rank();
  const c = rank({ raw: false });
  expect(compareSelectionRank(a, b)).toBeLessThan(0);
  expect(compareSelectionRank(b, c)).toBe(0);
  expect(compareSelectionRank(a, c)).toBeLessThan(0);
});

test("sort preserves equal-rank input order and deterministically ranks shuffled items", () => {
  const a = { ...base, id: "a" };
  const b = { ...base, id: "b" };
  expect([b, a].sort(compareSelectionRank).map(({ id }) => id)).toEqual(["b", "a"]);
  const ordered = [
    rank({ windowRank: -1 }),
    rank({ raw: true }),
    rank({ area: 1 }),
    rank({ order: 1 }),
  ];
  for (const shuffled of [
    [ordered[3], ordered[1], ordered[0], ordered[2]],
    [...ordered].reverse(),
  ]) {
    expect(shuffled.sort(compareSelectionRank)).toEqual(ordered);
  }
});
