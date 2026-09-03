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

    // --- issue #5377: age must be measured in a single (host) clock domain ---

    test("CLOCK SKEW: a host-domain age basis is used for ageMs instead of the device timestamp", () => {
      // The device clock is ~25s behind the host, so `actualTimestamp` (device
      // domain) is 25s "in the past" relative to host `now` even though the tree
      // was captured ~now on the device and received ~200ms ago on the host.
      // ageMs must reflect the host-domain receipt age, not the skew.
      const v = computeFreshness({
        actualTimestamp: NOW - 25_000, // device-authored, skewed
        hostAgeBasisMs: NOW - 200, // host-authored receipt time
        now: NOW,
        verified: true,
      });
      expect(v.ageMs).toBe(200);
      expect(v.actualTimestamp).toBe(NOW - 25_000); // still reports the device timestamp
      expect(v.isFresh).toBe(true);
      expect(v.warning).toBeUndefined(); // no spurious "the rest of the observation was slow"
    });

    test("CLOCK SKEW: no spurious over-budget warning when only the device clock is skewed", () => {
      // Recent host receipt but a wildly skewed device timestamp: without the
      // host-domain basis this fired the false "already Nms old … slow" warning.
      const v = computeFreshness({
        actualTimestamp: NOW - 25_000,
        hostAgeBasisMs: NOW - 100,
        now: NOW,
        verified: true,
      });
      expect(v.isFresh).toBe(true);
      expect(v.warning).toBeUndefined();
    });

    test("a genuinely slow observation still warns, measured in the host domain", () => {
      // Host-domain basis IS past the budget: this is real slowness (dense-screen
      // extraction), so the verified-tree warning is legitimate here.
      const v = computeFreshness({
        actualTimestamp: NOW - 11_000,
        hostAgeBasisMs: NOW - 11_000,
        now: NOW,
        verified: true,
      });
      expect(v.ageMs).toBe(11_000);
      expect(v.isFresh).toBe(true);
      expect(v.warning).toContain("verified against the device");
    });

    test("FALLBACK: with no host-domain basis, age falls back to the device timestamp (iOS)", () => {
      // iOS shares the host clock, so it never supplies a host basis; the old
      // device-timestamp age must remain byte-identical.
      const v = computeFreshness({ actualTimestamp: NOW - 200, now: NOW, verified: true });
      expect(v.ageMs).toBe(200);
      expect(v.isFresh).toBe(true);
      expect(v.warning).toBeUndefined();
    });
  });

  describe("with a requested minimum (the `waitFor` polling path)", () => {
    test("semantics are unchanged: satisfied", () => {
      const v = computeFreshness({
        requestedAfter: NOW - 1_000,
        actualTimestamp: NOW - 500,
        now: NOW,
      });
      expect(v.isFresh).toBe(true);
      expect(v.staleDurationMs).toBeUndefined();
    });

    test("semantics are unchanged: not satisfied, staleDurationMs is the shortfall", () => {
      const v = computeFreshness({
        requestedAfter: NOW - 500,
        actualTimestamp: NOW - 181_858,
        now: NOW,
      });
      expect(v.isFresh).toBe(false);
      expect(v.staleDurationMs).toBe(181_358);
    });

    test("an exactly-equal timestamp satisfies the minimum", () => {
      const v = computeFreshness({ requestedAfter: NOW, actualTimestamp: NOW, now: NOW });
      expect(v.isFresh).toBe(true);
    });

    test("a requested minimum still reports the wall-clock age alongside the verdict", () => {
      const v = computeFreshness({
        requestedAfter: NOW - 10_000,
        actualTimestamp: NOW - 5_000,
        now: NOW,
      });
      expect(v.isFresh).toBe(true);
      expect(v.ageMs).toBe(5_000);
    });
  });

  // --- issue #5867: window-identity mismatch retracts freshness ---
  describe("window-identity mismatch (issue #5867)", () => {
    test("a wrong-window capture is NOT verified and NOT fresh, even when device-verified and recent", () => {
      // The delegate said the tree was verified (`verified: true`) and it is
      // brand new, but it belongs to a different app than the one currently
      // resumed on the device. That is the stale wrong-window bug: it must not
      // read as fresh, and `verified` must be retracted to false.
      const v = computeFreshness({
        actualTimestamp: NOW - 100,
        now: NOW,
        verified: true,
        windowIdentityMismatch: {
          observed: "com.google.android.calendar",
          foreground: "com.android.settings",
        },
      });
      expect(v.verified).toBe(false);
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("com.google.android.calendar");
      expect(v.warning).toContain("com.android.settings");
    });

    test("the mismatch dominates a requested-minimum poll too", () => {
      const v = computeFreshness({
        requestedAfter: NOW - 1_000,
        actualTimestamp: NOW,
        now: NOW,
        windowIdentityMismatch: {
          observed: "com.google.android.calendar",
          foreground: "com.android.settings",
        },
      });
      expect(v.verified).toBe(false);
      expect(v.isFresh).toBe(false);
    });

    test("an unresolved same-app activity disagreement is NOT verified or fresh", () => {
      const v = computeFreshness({
        actualTimestamp: NOW - 100,
        now: NOW,
        verified: true,
        activityAttributionMismatch: true,
      });
      expect(v.verified).toBe(false);
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("disagree about the current activity");
    });

    test("a hierarchy that could not be retrieved still reports unavailable, not a mismatch", () => {
      // No hierarchy means no window to compare — unavailable dominates.
      const v = computeFreshness({
        actualTimestamp: NOW,
        now: NOW,
        unavailable: true,
        windowIdentityMismatch: {
          observed: "com.google.android.calendar",
          foreground: "com.android.settings",
        },
      });
      expect(v.isFresh).toBe(false);
      expect(v.warning).toContain("could not be retrieved");
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
