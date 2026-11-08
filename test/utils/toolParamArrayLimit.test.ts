import { describe, expect, test } from "bun:test";
import { ZodError, z } from "zod/v4";
import { parseStepParams } from "../../src/utils/plan/planStepParams";
import {
  assertToolParamArraysBounded,
  findOversizedArray,
  MAX_TOOL_PARAM_ARRAY_LENGTH,
} from "../../src/utils/toolParamArrayLimit";

describe("tool param array limit (#16102)", () => {
  test("arrays at the limit pass", () => {
    expect(findOversizedArray({ a: [1, 2, 3], b: { c: [[1], [2]] } }, 3)).toBeUndefined();
    expect(() => assertToolParamArraysBounded({ a: [1, 2, 3] }, 3)).not.toThrow();
  });

  test("scalars and null pass", () => {
    for (const value of [undefined, null, 1, "x", true]) {
      expect(findOversizedArray(value, 0)).toBeUndefined();
    }
  });

  test("reports the path of a nested oversized array", () => {
    const params = { outer: [{ ok: [1] }, { inner: { list: [1, 2, 3, 4] } }] };
    expect(findOversizedArray(params, 3)).toEqual({
      path: ["outer", 1, "inner", "list"],
      length: 4,
    });
  });

  test("a top-level oversized array has an empty path", () => {
    expect(findOversizedArray([1, 2], 1)).toEqual({ path: [], length: 2 });
  });

  test("throws a too_big ZodError naming the path", () => {
    let caught: unknown;
    try {
      assertToolParamArraysBounded({ list: [1, 2] }, 1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ZodError);
    expect((caught as ZodError).issues).toMatchObject([
      { code: "too_big", origin: "array", maximum: 1, path: ["list"] },
    ]);
  });

  test("shared references are walked once", () => {
    const shared = [1];
    const wide = Array.from({ length: 3 }, () => ({ a: shared, b: shared }));
    expect(findOversizedArray({ wide }, 3)).toBeUndefined();
  });

  test("an oversized array under deep nesting is found", () => {
    let deep: unknown = [1, 2];
    for (let i = 0; i < 5_000; i++) {
      deep = { next: deep };
    }
    expect(findOversizedArray(deep, 1)?.length).toBe(2);
  });

  test("plan step params refuse an oversized array before validating any element", () => {
    let checks = 0;
    const schema = z.object({
      items: z.array(
        z.string().refine(() => {
          checks++;
          return true;
        }),
      ),
    });
    const items = Array.from({ length: MAX_TOOL_PARAM_ARRAY_LENGTH + 1 }, () => "x");
    expect(() => parseStepParams(schema, { items })).toThrow(ZodError);
    expect(checks).toBe(0);
    expect(parseStepParams(schema, { items: ["a"] })).toEqual({ items: ["a"] });
    expect(checks).toBe(1);
  });
});
