import { test } from "bun:test";
import fc from "fast-check";
import {
  compareSelectionRank,
  type SelectionRank,
} from "../../../src/features/utility/selectionRank";

const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;
const flag = fc.constantFrom(undefined, true, false);
const rank: fc.Arbitrary<SelectionRank> = fc.record({
  windowRank: fc.integer({ min: 0, max: 2 }),
  interactive: fc.boolean(),
  raw: flag,
  input: flag,
  area: fc.constantFrom(0, 1, 10, Infinity),
  order: fc.integer({ min: 0, max: 2 }),
});

test("rank comparator is antisymmetric with absent flags", () => {
  fc.assert(
    fc.property(
      rank,
      rank,
      fc.boolean(),
      fc.constantFrom(-1, 0, 1),
      (a, b, interactive, input) =>
        Math.sign(compareSelectionRank(a, b, interactive, input)) ===
        -Math.sign(compareSelectionRank(b, a, interactive, input)),
    ),
    RUN_OPTIONS,
  );
});

test("rank comparator is transitive including equivalence with absent flags", () => {
  fc.assert(
    fc.property(
      rank,
      rank,
      rank,
      fc.boolean(),
      fc.constantFrom(-1, 0, 1),
      (a, b, c, interactive, input) => {
        const ab = compareSelectionRank(a, b, interactive, input);
        const bc = compareSelectionRank(b, c, interactive, input);
        const ac = compareSelectionRank(a, c, interactive, input);
        return !(ab <= 0 && bc <= 0) || ac <= 0;
      },
    ),
    RUN_OPTIONS,
  );
});
