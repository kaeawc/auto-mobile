import { describe, test } from "bun:test";
import fc from "fast-check";
import { compactExclusiveSelectorProperties } from "../../src/server/toolSchemaHelpers";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Short lowercase key names, deduplicated, matching realistic tool-schema field
// names (elementId, text, container, ...).
const keyName = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")),
  minLength: 3,
  maxLength: 8
});
const uniqueKeys = fc.uniqueArray(keyName, { minLength: 2, maxLength: 5 });

const branchFor = (key: string): Record<string, unknown> => ({
  type: "object",
  properties: { [key]: { type: "string" } },
  required: [key]
});

// A jsonSchema whose single `myProp` property is an `anyOf` union of strict
// single-key object branches — exactly the pattern
// `compactExclusiveSelectorProperties` is designed to collapse. Built fresh on
// every fast-check run (via `.map`) since the function under test mutates its
// input in place.
const matchingCase = uniqueKeys.map(keys => ({
  keys,
  jsonSchema: {
    properties: {
      myProp: { anyOf: keys.map(branchFor), description: "pick one" }
    }
  } as Record<string, unknown>
}));

describe("compactExclusiveSelectorProperties (property-based)", () => {
  // The source iterates `branches` in array order, pushing into `merged` (a
  // plain object — insertion order preserved for our non-numeric string keys)
  // and `oneOf` in that same order, so the compacted output preserves the
  // original branches' key order rather than merely containing the same set.
  test("collapses matching anyOf branches into one object, preserving branch order", () => {
    fc.assert(
      fc.property(matchingCase, ({ keys, jsonSchema }) => {
        compactExclusiveSelectorProperties(jsonSchema, ["myProp"]);
        const myProp = (jsonSchema.properties as Record<string, any>).myProp;
        const resultKeys = Object.keys(myProp.properties);
        const oneOfKeys = (myProp.oneOf as Array<{ required: string[] }>).map(o => o.required[0]);
        return (
          myProp.type === "object" &&
          myProp.additionalProperties === false &&
          myProp.description === "pick one" &&
          JSON.stringify(resultKeys) === JSON.stringify(keys) &&
          JSON.stringify(oneOfKeys) === JSON.stringify(keys)
        );
      }),
      RUN_OPTIONS
    );
  });

  // After compaction `myProp` no longer has an `anyOf`/`oneOf`-of-branches
  // shape (its `oneOf` entries are `{required:[key]}`, with no `type` or
  // `properties`), so the pattern match fails on a second pass and the
  // function skips it — the object should be byte-for-byte unchanged.
  test("a second compaction call is a no-op (idempotent)", () => {
    fc.assert(
      fc.property(matchingCase, ({ jsonSchema }) => {
        compactExclusiveSelectorProperties(jsonSchema, ["myProp"]);
        const once = JSON.stringify(jsonSchema);
        compactExclusiveSelectorProperties(jsonSchema, ["myProp"]);
        return JSON.stringify(jsonSchema) === once;
      }),
      RUN_OPTIONS
    );
  });

  // Shapes that each fail the strict "every branch is a single-key required
  // object" pattern in one specific way. compactExclusiveSelectorProperties
  // must leave these entirely alone rather than throwing or partially
  // rewriting `myProp`.
  const noAnyOfAtAll = uniqueKeys.map(keys => ({
    properties: {
      myProp: {
        type: "object",
        properties: Object.fromEntries(keys.map(k => [k, { type: "string" }]))
      }
    }
  } as Record<string, unknown>));

  const singleBranchAnyOf = keyName.map(key => ({
    properties: { myProp: { anyOf: [branchFor(key)] } }
  } as Record<string, unknown>));

  const missingRequired = uniqueKeys.map(keys => ({
    properties: {
      myProp: {
        anyOf: keys.map((k, i) =>
          i === 0 ? { type: "object", properties: { [k]: { type: "string" } } } : branchFor(k)
        )
      }
    }
  } as Record<string, unknown>));

  const multiKeyRequired = uniqueKeys.map(keys => ({
    properties: {
      myProp: {
        anyOf: keys.map((k, i) =>
          i === 0
            ? {
              type: "object",
              properties: Object.fromEntries(keys.map(kk => [kk, { type: "string" }])),
              required: keys.slice(0, 2)
            }
            : branchFor(k)
        )
      }
    }
  } as Record<string, unknown>));

  const nonObjectBranch = uniqueKeys.map(keys => ({
    properties: {
      myProp: {
        anyOf: keys.map((k, i) =>
          i === 0 ? { type: "string", properties: { [k]: { type: "string" } }, required: [k] } : branchFor(k)
        )
      }
    }
  } as Record<string, unknown>));

  const noPropertiesAtAll = fc.constant({} as Record<string, unknown>);

  const malformedSchema = fc.oneof(
    noAnyOfAtAll,
    singleBranchAnyOf,
    missingRequired,
    multiKeyRequired,
    nonObjectBranch,
    noPropertiesAtAll
  );

  test("malformed or non-matching shapes are left untouched and never throw", () => {
    fc.assert(
      fc.property(malformedSchema, s => {
        const before = JSON.stringify(s);
        compactExclusiveSelectorProperties(s, ["myProp"]);
        return JSON.stringify(s) === before;
      }),
      RUN_OPTIONS
    );
  });
});
