import { describe, expect, test } from "bun:test";
import { flattenTopLevelUnion } from "../../src/server/TopLevelUnionFlattener";

/**
 * Locks in the extracted module's public API directly (the behavioural
 * matrix lives in flattenTopLevelUnion.test.ts, which imports the
 * backward-compatible re-export from toolRegistry).
 */
describe("TopLevelUnionFlattener module", () => {
  test("re-export and direct import resolve to the same function", async () => {
    const fromRegistry = (await import("../../src/server/toolRegistry")).flattenTopLevelUnion;
    expect(fromRegistry).toBe(flattenTopLevelUnion);
  });

  // D7 (issue #4181): the non-union pass-through row lived here AND in
  // flattenTopLevelUnion.test.ts ("returns non-union schema unchanged"); the
  // canonical behavioural matrix owns it, so the duplicate is removed.

  test("chains multiple branch-only requirements into nested if/then/else", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            kind: { const: "a" },
            shared: { type: "string" },
            aOnly: { type: "string" },
          },
          required: ["kind", "shared", "aOnly"],
        },
        {
          type: "object",
          properties: {
            kind: { const: "b" },
            shared: { type: "string" },
            bOnly: { type: "string" },
          },
          required: ["kind", "shared", "bOnly"],
        },
      ],
    };

    const result = flattenTopLevelUnion(schema);

    expect(result.required).toEqual(["kind", "shared"]);
    expect(result.if).toEqual({ properties: { kind: { const: "a" } }, required: ["kind"] });
    expect(result.then).toEqual({ required: ["aOnly"] });
    // Second branch's requirement is chained via else.
    expect((result.else as any).then).toEqual({ required: ["bOnly"] });
  });

  // Issue #4187: `mergedProperties` was a `{}` map guarded by `!mergedProperties[key]`,
  // so a union property named after an `Object.prototype` member read back as the
  // inherited member (truthy) and the real schema was merged into it instead.
  describe("prototype-named union properties (issue #4187)", () => {
    test.each([
      ["constructor"],
      ["toString"],
      ["valueOf"],
      ["hasOwnProperty"],
      ["__proto__"],
      // Control row: a normal property name must behave identically.
      ["normalProp"],
    ])("flattens a %s property to its real schema", (key) => {
      const result = flattenTopLevelUnion({
        anyOf: [
          { type: "object", properties: { [key]: { type: "string" } } },
          { type: "object", properties: { other: { type: "number" } } },
        ],
      });

      const properties = result.properties as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(properties, key)).toBe(true);
      expect(properties[key]).toEqual({ type: "string" });
      expect(properties.other).toEqual({ type: "number" });
    });

    test("still merges const values of a prototype-named property across branches", () => {
      const result = flattenTopLevelUnion({
        anyOf: [
          { type: "object", properties: { constructor: { const: "a" } } },
          { type: "object", properties: { constructor: { const: "b" } } },
        ],
      });

      const properties = result.properties as Record<string, unknown>;
      expect(properties.constructor).toEqual({ enum: ["a", "b"] });
    });
  });
});
