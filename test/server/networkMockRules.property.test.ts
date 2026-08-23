import { describe, test } from "bun:test";
import fc from "fast-check";
import { buildNetworkMockRules } from "../../src/server/networkMockRules";
import type { MockRule, NetworkState } from "../../src/server/NetworkState";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const nullableCount = fc.option(fc.integer({ min: 0, max: 1000 }), { nil: null });
const mockRule: fc.Arbitrary<MockRule> = fc.record({
  mockId: fc.string({ maxLength: 8 }),
  host: fc.string({ maxLength: 12 }),
  path: fc.string({ maxLength: 12 }),
  method: fc.constantFrom("GET", "POST", "PUT", "DELETE", "PATCH"),
  limit: nullableCount,
  // `remaining` is intentionally independent of `limit`, to prove it is IGNORED.
  remaining: nullableCount,
  statusCode: fc.integer({ min: 100, max: 599 }),
  responseHeaders: fc.dictionary(fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 }), {
    maxKeys: 4,
  }),
  responseBody: fc.string({ maxLength: 12 }),
  contentType: fc.string({ maxLength: 10 }),
});

// buildNetworkMockRules only reads state.getMocks(); a minimal seam keeps it pure.
const stateFrom = (rules: MockRule[]): NetworkState =>
  ({
    getMocks: () => new Map(rules.map((r, i) => [`k${i}`, r] as const)),
  }) as unknown as NetworkState;

describe("buildNetworkMockRules (property-based)", () => {
  test("preserves count and insertion order by mockId", () => {
    fc.assert(
      fc.property(fc.array(mockRule, { maxLength: 12 }), (rules) => {
        const out = buildNetworkMockRules(stateFrom(rules));
        return out.length === rules.length && out.every((o, i) => o.mockId === rules[i].mockId);
      }),
      RUN_OPTIONS,
    );
  });

  test("reinitializes remaining from limit, never copying the store's remaining", () => {
    fc.assert(
      fc.property(fc.array(mockRule, { maxLength: 12 }), (rules) => {
        const out = buildNetworkMockRules(stateFrom(rules));
        return out.every((o, i) => o.remaining === rules[i].limit);
      }),
      RUN_OPTIONS,
    );
  });

  test("passes every other field through unchanged", () => {
    fc.assert(
      fc.property(fc.array(mockRule, { minLength: 1, maxLength: 12 }), (rules) => {
        const out = buildNetworkMockRules(stateFrom(rules));
        return out.every((o, i) => {
          const r = rules[i];
          return (
            o.host === r.host &&
            o.path === r.path &&
            o.method === r.method &&
            o.limit === r.limit &&
            o.statusCode === r.statusCode &&
            o.responseHeaders === r.responseHeaders &&
            o.responseBody === r.responseBody &&
            o.contentType === r.contentType
          );
        });
      }),
      RUN_OPTIONS,
    );
  });

  test("an empty store yields an empty payload", () => {
    fc.assert(
      fc.property(fc.constant(null), () => buildNetworkMockRules(stateFrom([])).length === 0),
      RUN_OPTIONS,
    );
  });
});
