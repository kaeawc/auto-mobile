/**
 * Freshness is the field consumers read to decide whether the tree they were
 * handed matches the screen. It used to be the literal `true` on every call that
 * supplied no `minTimestamp` — which is every call the public tool schema can
 * make, since `minTimestamp` is not one of its inputs.
 *
 * The tests below pin the property that made that a defect rather than a
 * cosmetic issue: a freshness flag must not read the same when freshness was
 * established as when it could not be.
 */

import { describe, expect, test } from "bun:test";
import {
  computeFreshness,
  DEFAULT_MAX_OBSERVATION_AGE_MS,
} from "../../../src/features/observe/observationFreshness";

const NOW = 1_700_000_000_000;

describe("computeFreshness", () => {
  describe("without a requested minimum (the plain `observe` path)", () => {
    test("a recently captured, device-verified tree is fresh", () => {
      const v = computeFreshness({ actualTimestamp: NOW - 200, now: NOW, verified: true });
      expect(v.isFresh).toBe(true);
      expect(v.ageMs).toBe(200);
      expect(v.staleDurationMs).toBeUndefined();
      expect(v.warning).toBeUndefined();
    });

    test("REGRESSION: a minutes-old tree is NOT reported fresh (was hardcoded `true`)", () => {
      const ageMs = 216_000; // a several-minutes-stale tree (well past any age budget)
      const v = computeFreshness({ actualTimestamp: NOW - ageMs, now: NOW });
      expect(v.isFresh).toBe(false);
      expect(v.ageMs).toBe(ageMs);
      expect(v.staleDurationMs).toBe(ageMs);
      expect(v.warning).toContain("past the");
    });

    test("REGRESSION: a cache served without device re-verification is NOT fresh, at any age", () => {
      // `verified: false` is the delegate reporting that it handed back a
      // host-side cache entry because the runner did not answer. Even one
      // millisecond old, that tree was never checked against the screen.
      const v = computeFreshness({ actualTimestamp: NOW - 1, now: NOW, verified: false });
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("without being re-verified");
    });

    test("an unknowable freshness reads false, not true", () => {
      const v = computeFreshness({ actualTimestamp: undefined, now: NOW });
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("cannot be established");
    });

    test("a hierarchy retrieval failure is never reported fresh, even with a current timestamp", () => {
      const v = computeFreshness({ actualTimestamp: NOW, now: NOW, unavailable: true });
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("could not be retrieved");
    });

    test("the budget boundary is exclusive on the fresh side", () => {
      const at = DEFAULT_MAX_OBSERVATION_AGE_MS;
      expect(computeFreshness({ actualTimestamp: NOW - at, now: NOW }).isFresh).toBe(true);
      expect(computeFreshness({ actualTimestamp: NOW - at - 1, now: NOW }).isFresh).toBe(false);
    });

    test("an explicit budget overrides the default", () => {
      const v = computeFreshness({ actualTimestamp: NOW - 800, now: NOW, maxAgeMs: 500 });
      expect(v.isFresh).toBe(false);
      expect(v.staleDurationMs).toBe(800);
    });

    test("NO FALSE ALARM: a device-verified tree stays fresh even past the age budget", () => {
      // Age past the budget on a verified read measures how long the REST of the
      // observation took (screenshot, audits, dense-screen element extraction),
      // not a stale channel — a dense screen can take several seconds end to end.
      const v = computeFreshness({ actualTimestamp: NOW - 11_000, now: NOW, verified: true });
      expect(v.isFresh).toBe(true);
      expect(v.ageMs).toBe(11_000);
      expect(v.staleDurationMs).toBeUndefined();
      expect(v.warning).toContain("verified against the device");
    });

    test("with no `verified` signal at all, age is the only evidence and it is used", () => {
      const v = computeFreshness({ actualTimestamp: NOW - 11_000, now: NOW, verified: undefined });
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("did not report whether it was verified");
    });

    test("a clock skew that puts capture in the future clamps to age 0 rather than going negative", () => {
      const v = computeFreshness({ actualTimestamp: NOW + 5_000, now: NOW, verified: true });
      expect(v.ageMs).toBe(0);
      expect(v.isFresh).toBe(true);
    });
  });

  describe("with a requested minimum (the `waitFor` polling path)", () => {
    test("semantics are unchanged: satisfied", () => {
      const v = computeFreshness({ requestedAfter: NOW - 1_000, actualTimestamp: NOW - 500, now: NOW });
      expect(v.isFresh).toBe(true);
      expect(v.staleDurationMs).toBeUndefined();
    });

    test("semantics are unchanged: not satisfied, staleDurationMs is the shortfall", () => {
      const v = computeFreshness({ requestedAfter: NOW - 500, actualTimestamp: NOW - 181_858, now: NOW });
      expect(v.isFresh).toBe(false);
      expect(v.staleDurationMs).toBe(181_358);
    });

    test("an exactly-equal timestamp satisfies the minimum", () => {
      const v = computeFreshness({ requestedAfter: NOW, actualTimestamp: NOW, now: NOW });
      expect(v.isFresh).toBe(true);
    });

    test("a requested minimum still reports the wall-clock age alongside the verdict", () => {
      const v = computeFreshness({ requestedAfter: NOW - 10_000, actualTimestamp: NOW - 5_000, now: NOW });
      expect(v.isFresh).toBe(true);
      expect(v.ageMs).toBe(5_000);
    });
  });

  test("every `isFresh: false` names its cause", () => {
    const falseCases = [
      computeFreshness({ actualTimestamp: NOW - 999_999, now: NOW }),
      computeFreshness({ actualTimestamp: NOW, now: NOW, verified: false }),
      computeFreshness({ actualTimestamp: undefined, now: NOW }),
      computeFreshness({ requestedAfter: NOW, actualTimestamp: NOW - 10, now: NOW }),
      computeFreshness({ requestedAfter: NOW, actualTimestamp: undefined, now: NOW }),
    ];
    for (const v of falseCases) {
      expect(v.isFresh).toBe(false);
      expect(v.warning).toBeTruthy();
    }
  });
});
