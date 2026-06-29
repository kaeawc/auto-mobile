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

  test("passes through a non-union schema untouched", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(flattenTopLevelUnion(schema)).toEqual(schema);
  });

  test("chains multiple branch-only requirements into nested if/then/else", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "a" }, shared: { type: "string" }, aOnly: { type: "string" } },
          required: ["kind", "shared", "aOnly"],
        },
        {
          type: "object",
          properties: { kind: { const: "b" }, shared: { type: "string" }, bOnly: { type: "string" } },
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
});
