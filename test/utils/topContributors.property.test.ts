import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  selectTopContributors,
  TOP_CONTRIBUTOR_WEIGHT_THRESHOLD,
  type WeightedContribution,
} from "../../src/utils/topContributors";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Weights live in [0, 1] per the audit contract. Each violation is a distinct
// object so subset membership can be checked by reference.
const weight = fc.double({ min: 0, max: 1, noNaN: true });
const violations = fc.array(
  weight.map((w) => ({ contributionWeight: w })),
  { maxLength: 20 },
);

describe("selectTopContributors (property-based)", () => {
  test("an empty input yields an empty result", () => {
    fc.assert(
      fc.property(
        fc.constant([] as WeightedContribution[]),
        (v) => selectTopContributors(v).length === 0,
      ),
      RUN_OPTIONS,
    );
  });

  test("a non-empty input always yields at least one contributor (issue #4167)", () => {
    fc.assert(
      fc.property(
        violations.filter((v) => v.length > 0),
        (v) => selectTopContributors(v).length >= 1,
      ),
      RUN_OPTIONS,
    );
  });

  test("the result is a subset of the input and never larger", () => {
    fc.assert(
      fc.property(violations, (v) => {
        const result = selectTopContributors(v);
        return result.length <= v.length && result.every((r) => v.includes(r));
      }),
      RUN_OPTIONS,
    );
  });

  test("the result is sorted by weight, highest first", () => {
    fc.assert(
      fc.property(violations, (v) => {
        const result = selectTopContributors(v);
        return result.every(
          (r, i) => i === 0 || result[i - 1].contributionWeight >= r.contributionWeight,
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("every selected weight is at or above min(threshold, maxWeight), and the max is always selected", () => {
    fc.assert(
      fc.property(
        violations.filter((v) => v.length > 0),
        (v) => {
          const maxWeight = Math.max(...v.map((x) => x.contributionWeight));
          const cutoff = Math.min(TOP_CONTRIBUTOR_WEIGHT_THRESHOLD, maxWeight);
          const result = selectTopContributors(v);
          const allAboveCutoff = result.every((r) => r.contributionWeight >= cutoff);
          const includesMax = result.some((r) => r.contributionWeight === maxWeight);
          return allAboveCutoff && includesMax;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("when any violation meets the threshold, nothing below it is selected", () => {
    fc.assert(
      fc.property(
        violations.filter((v) =>
          v.some((x) => x.contributionWeight >= TOP_CONTRIBUTOR_WEIGHT_THRESHOLD),
        ),
        (v) => {
          return selectTopContributors(v).every(
            (r) => r.contributionWeight >= TOP_CONTRIBUTOR_WEIGHT_THRESHOLD,
          );
        },
      ),
      RUN_OPTIONS,
    );
  });
});
