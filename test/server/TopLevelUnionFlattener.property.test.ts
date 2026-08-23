import { describe, test } from "bun:test";
import fc from "fast-check";
import { flattenTopLevelUnion } from "../../src/server/TopLevelUnionFlattener";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Property names include Object.prototype members to exercise the #4187 guard.
const propName = fc.constantFrom("a", "b", "c", "id", "kind", "constructor", "toString");
const propSchema = fc.oneof(
  fc.constant({ type: "string" } as Record<string, unknown>),
  fc.record({ const: fc.string({ maxLength: 4 }) }),
  fc.record({ enum: fc.array(fc.string({ maxLength: 4 }), { minLength: 1, maxLength: 3 }) }),
);
const branch = fc.record(
  {
    type: fc.constant("object"),
    properties: fc.dictionary(propName, propSchema, { maxKeys: 5 }),
    required: fc.array(propName, { maxLength: 4 }),
    additionalProperties: fc.oneof(fc.boolean(), fc.constant(undefined)),
  },
  { requiredKeys: ["type", "properties"] },
);

type Branch = {
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};
const unionInput = fc
  .record({
    combinator: fc.constantFrom("anyOf", "oneOf"),
    branches: fc.array(branch, { minLength: 1, maxLength: 4 }),
  })
  .map(({ combinator, branches }) => ({
    schema: { [combinator]: branches } as Record<string, unknown>,
    branches: branches as Branch[],
  }));

const allKeys = (branches: Branch[]): Set<string> =>
  new Set(branches.flatMap((b) => Object.keys(b.properties ?? {})));
const requiredIntersection = (branches: Branch[]): Set<string> => {
  const sets = branches.map((b) => new Set(b.required ?? []));
  return new Set([...sets[0]].filter((k) => sets.every((s) => s.has(k))));
};
const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

describe("flattenTopLevelUnion (property-based)", () => {
  test("passes a schema without a top-level anyOf/oneOf array through unchanged", () => {
    const nonUnion = fc.oneof(
      fc.record({
        type: fc.constant("object"),
        properties: fc.dictionary(propName, propSchema, { maxKeys: 3 }),
      }),
      fc.record({ anyOf: fc.constant("not-an-array") }),
      fc.record({ type: fc.constant("string") }),
    );
    fc.assert(
      fc.property(nonUnion, (s) => flattenTopLevelUnion(s) === s),
      RUN_OPTIONS,
    );
  });

  test("flattens a union to an object schema with no combinator left", () => {
    fc.assert(
      fc.property(unionInput, ({ schema }) => {
        const r = flattenTopLevelUnion(schema);
        return (
          r.type === "object" &&
          typeof r.properties === "object" &&
          !("anyOf" in r) &&
          !("oneOf" in r)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("the merged properties are exactly the union of every branch's property keys", () => {
    fc.assert(
      fc.property(unionInput, ({ schema, branches }) => {
        const r = flattenTopLevelUnion(schema);
        return setsEqual(new Set(Object.keys(r.properties as object)), allKeys(branches));
      }),
      RUN_OPTIONS,
    );
  });

  test("required is the intersection of the branches' required fields", () => {
    fc.assert(
      fc.property(unionInput, ({ schema, branches }) => {
        const r = flattenTopLevelUnion(schema);
        const expected = requiredIntersection(branches);
        return expected.size === 0
          ? !("required" in r)
          : setsEqual(new Set(r.required as string[]), expected);
      }),
      RUN_OPTIONS,
    );
  });

  test("additionalProperties is set only when every branch that specifies it agrees", () => {
    fc.assert(
      fc.property(unionInput, ({ schema, branches }) => {
        const r = flattenTopLevelUnion(schema);
        const distinct = new Set(
          branches.map((b) => b.additionalProperties).filter((x) => typeof x === "boolean"),
        );
        return distinct.size === 1
          ? r.additionalProperties === [...distinct][0]
          : !("additionalProperties" in r);
      }),
      RUN_OPTIONS,
    );
  });

  test("is idempotent — the flattened schema flattens to itself", () => {
    fc.assert(
      fc.property(unionInput, ({ schema }) => {
        const once = flattenTopLevelUnion(schema);
        return flattenTopLevelUnion(once) === once;
      }),
      RUN_OPTIONS,
    );
  });

  test("preserves a branch property named like an Object.prototype member (issue #4187)", () => {
    const protoKeyBranch = fc.record({
      type: fc.constant("object"),
      properties: fc.constant({
        constructor: { type: "string" },
        toString: { const: "x" },
        id: { type: "number" },
      }),
    });
    fc.assert(
      fc.property(fc.array(protoKeyBranch, { minLength: 1, maxLength: 3 }), (branches) => {
        const r = flattenTopLevelUnion({ anyOf: branches });
        const keys = Object.keys(r.properties as object);
        return keys.includes("constructor") && keys.includes("toString") && keys.includes("id");
      }),
      RUN_OPTIONS,
    );
  });
});
