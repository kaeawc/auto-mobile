import { describe, expect, test } from "bun:test";
import {
  TOP_CONTRIBUTOR_WEIGHT_THRESHOLD,
  selectTopContributors,
} from "../../src/utils/topContributors";

describe("selectTopContributors", function () {
  test("returns an empty list only for an empty violation set", function () {
    expect(selectTopContributors([])).toEqual([]);
  });

  test("never returns an empty list for a non-empty violation set", function () {
    for (const weight of [0, 0.1, 0.4, 0.5, 0.51, 1]) {
      expect(selectTopContributors([{ metric: "x", contributionWeight: weight }])).toHaveLength(1);
    }
  });

  test("includes a violation at exactly the threshold", function () {
    const at = { metric: "cpuUsage", contributionWeight: TOP_CONTRIBUTOR_WEIGHT_THRESHOLD };
    const above = { metric: "p95", contributionWeight: 0.8 };

    expect(selectTopContributors([at, above])).toEqual([above, at]);
  });

  test("drops sub-threshold violations when any violation meets the threshold", function () {
    const high = { metric: "jankCount", contributionWeight: 0.9 };
    const low = { metric: "p99", contributionWeight: 0.4 };

    expect(selectTopContributors([low, high])).toEqual([high]);
  });

  test("keeps the highest-weighted violations when every weight is sub-threshold", function () {
    const low = { metric: "p99", contributionWeight: 0.4 };
    const lower = { metric: "noise", contributionWeight: 0.1 };

    expect(selectTopContributors([lower, low])).toEqual([low]);
  });

  test("sorts by descending weight and does not mutate the input", function () {
    const input = [
      { metric: "a", contributionWeight: 0.6 },
      { metric: "b", contributionWeight: 0.9 },
      { metric: "c", contributionWeight: 0.7 },
    ];

    expect(selectTopContributors(input).map((v) => v.metric)).toEqual(["b", "c", "a"]);
    expect(input.map((v) => v.metric)).toEqual(["a", "b", "c"]);
  });
});
