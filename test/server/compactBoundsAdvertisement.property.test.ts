import { describe, test } from "bun:test";
import fc from "fast-check";
import {
  advertiseBoundsForCompact,
  BOUNDS_UNION_DESCRIPTION_PREFIX as PREFIX,
} from "../../src/server/compactBoundsAdvertisement";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// A bounds union: an anyOf with an object arm and a tuple arm, described with the
// marker prefix. Non-bounds objects never carry an `anyOf` key (see nodeAt), so
// nothing else matches the collapse pattern by accident.
const objectArm = fc.record({ type: fc.constant("object"), title: fc.string({ maxLength: 6 }) });
const boundsUnion = fc.record({
  anyOf: fc.tuple(objectArm, fc.record({ type: fc.constant("array") })),
  description: fc.string({ maxLength: 20 }).map((s) => `${PREFIX}${s}`),
});

const primitive = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);
const nodeAt = (d: number): fc.Arbitrary<unknown> => {
  if (d <= 0) {
    return fc.oneof(primitive, boundsUnion);
  }
  const child = nodeAt(d - 1);
  const genericObject = fc.dictionary(
    fc.constantFrom("type", "title", "properties", "items", "foo"),
    child,
    { maxKeys: 3 },
  );
  return fc.oneof(primitive, boundsUnion, genericObject, fc.array(child, { maxLength: 3 }));
};
const schema = nodeAt(3);

const isBoundsUnion = (n: unknown): boolean =>
  !!n &&
  typeof n === "object" &&
  !Array.isArray(n) &&
  Array.isArray((n as Record<string, unknown>).anyOf) &&
  typeof (n as Record<string, unknown>).description === "string" &&
  ((n as Record<string, unknown>).description as string).startsWith(PREFIX);

const countBoundsUnions = (node: unknown): number => {
  if (Array.isArray(node)) {
    return node.reduce((s: number, n) => s + countBoundsUnions(n), 0);
  }
  if (!node || typeof node !== "object") {
    return 0;
  }
  const self = isBoundsUnion(node) ? 1 : 0;
  return (
    self +
    Object.values(node as Record<string, unknown>).reduce(
      (s: number, v) => s + countBoundsUnions(v),
      0,
    )
  );
};

describe("advertiseBoundsForCompact (property-based)", () => {
  test("returns the input unchanged when compaction is enabled", () => {
    fc.assert(
      fc.property(schema, (s) => advertiseBoundsForCompact(s, true) === s),
      RUN_OPTIONS,
    );
  });

  test("never mutates the input schema", () => {
    fc.assert(
      fc.property(schema, (s) => {
        const before = JSON.stringify(s);
        advertiseBoundsForCompact(s, false);
        return JSON.stringify(s) === before;
      }),
      RUN_OPTIONS,
    );
  });

  test("collapse (compaction off) leaves no bounds union in the output", () => {
    fc.assert(
      fc.property(schema, (s) => countBoundsUnions(advertiseBoundsForCompact(s, false)) === 0),
      RUN_OPTIONS,
    );
  });

  test("collapse is idempotent", () => {
    fc.assert(
      fc.property(schema, (s) => {
        const once = advertiseBoundsForCompact(s, false);
        return JSON.stringify(advertiseBoundsForCompact(once, false)) === JSON.stringify(once);
      }),
      RUN_OPTIONS,
    );
  });

  test("a bounds union collapses to its object arm, keeping the description", () => {
    fc.assert(
      fc.property(boundsUnion, (u) => {
        const r = advertiseBoundsForCompact(u, false) as Record<string, unknown>;
        return r.type === "object" && r.description === u.description && !("anyOf" in r);
      }),
      RUN_OPTIONS,
    );
  });
});
