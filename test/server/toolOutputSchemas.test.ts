import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod";
import { elementBoundsSchema, elementSchema, tapOnResultSchema } from "../../src/server/toolOutputSchemas";

/**
 * Wire-schema coverage for the `--observe-result-compact` tuple form (issue #2990,
 * task 2). When the flag is on, `finalizeToolResponse` flattens every `bounds`
 * object `{left, top, right, bottom}` to the positional tuple `[left, top, right,
 * bottom]`. Tools that advertise an `outputSchema` (tapOn, accessibility, …) all
 * route their `bounds` through `elementBoundsSchema`, so that schema must accept —
 * and machine-readably document — both shapes; otherwise a strict MCP client would
 * reject the compact response and an external consumer could not decode the tuple
 * without reading prose docs.
 */
describe("elementBoundsSchema: object + compact tuple (#2990)", () => {
  const objectBounds = { left: 0, top: 10, right: 1080, bottom: 1920 };
  const tupleBounds = [0, 10, 1080, 1920];

  test("accepts the default object form", () => {
    expect(elementBoundsSchema.parse(objectBounds)).toEqual(objectBounds);
  });

  test("accepts the object form with optional centerX/centerY", () => {
    const withCenters = { ...objectBounds, centerX: 540, centerY: 965 };
    expect(elementBoundsSchema.parse(withCenters)).toEqual(withCenters);
  });

  test("accepts the compact [left, top, right, bottom] tuple", () => {
    expect(elementBoundsSchema.parse(tupleBounds)).toEqual(tupleBounds);
  });

  test("rejects a tuple of the wrong arity", () => {
    expect(() => elementBoundsSchema.parse([0, 10, 1080])).toThrow();
    expect(() => elementBoundsSchema.parse([0, 10, 1080, 1920, 5])).toThrow();
  });

  test("rejects non-numeric tuple members", () => {
    expect(() => elementBoundsSchema.parse([0, 10, 1080, "x"])).toThrow();
  });

  test("elementSchema accepts a node whose bounds is the compact tuple", () => {
    const el = { bounds: tupleBounds, text: "btn" };
    expect(elementSchema.parse(el)).toMatchObject({ bounds: tupleBounds, text: "btn" });
  });

  test("the advertised JSON schema documents the tuple order (machine-readable)", () => {
    const json = JSON.stringify(toJSONSchema(tapOnResultSchema));
    // The union carries a description naming the positional tuple order and the flag,
    // so an external client can decode [l,t,r,b] from the wire schema alone.
    expect(json).toContain("left, top, right, bottom");
    expect(json.toLowerCase()).toContain("observe-result-compact");
  });
});
