import { describe, test } from "bun:test";
import fc from "fast-check";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import {
  ANDROID_PRE_TAP_STABLE_MATCHES_STRICT,
  androidPreTapConsecutiveStableMatchesRequired,
} from "../../../src/features/action/androidPreTapStablePolicy";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const sibling = fc.constantFrom<boolean | undefined>(true, false, undefined);
const optionsOf = (s: boolean | undefined): TapOnElementOptions =>
  ({ sibling: s }) as unknown as TapOnElementOptions;

describe("androidPreTapConsecutiveStableMatchesRequired (property-based)", () => {
  test("returns only 1 or the strict count", () => {
    fc.assert(
      fc.property(sibling, (s) => {
        const n = androidPreTapConsecutiveStableMatchesRequired(optionsOf(s));
        return n === 1 || n === ANDROID_PRE_TAP_STABLE_MATCHES_STRICT;
      }),
      RUN_OPTIONS,
    );
  });

  test("requires the strict count iff sibling is exactly true", () => {
    fc.assert(
      fc.property(sibling, (s) => {
        const n = androidPreTapConsecutiveStableMatchesRequired(optionsOf(s));
        return n === (s === true ? ANDROID_PRE_TAP_STABLE_MATCHES_STRICT : 1);
      }),
      RUN_OPTIONS,
    );
  });

  test("a non-sibling tap (false or absent) requires a single stable match", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<boolean | undefined>(false, undefined),
        (s) => androidPreTapConsecutiveStableMatchesRequired(optionsOf(s)) === 1,
      ),
      RUN_OPTIONS,
    );
  });
});
