import { describe, expect, test } from "bun:test";
import { z as z3 } from "zod/v3";
import { z } from "zod/v4";
import {
  prototypeOwnKeyRecord,
  prototypeOwnKeyRecordV3,
} from "../../../src/features/prototype/prototypeOwnKeyRecord";

const authored = (json: string): unknown => JSON.parse(json);

describe("prototypeOwnKeyRecord (zod/v4)", () => {
  const schema = prototypeOwnKeyRecord(z.string().min(1), z.object({ value: z.number() }).strict());

  test("keeps an own __proto__ entry as data without touching the prototype", () => {
    const parsed = schema.parse(authored('{"__proto__":{"value":3},"a":{"value":1}}'));
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(
      authored('{"a":{"value":1},"__proto__":{"value":3}}'),
    );
    expect(Object.getOwnPropertySymbols(parsed)).toEqual([]);
  });

  test("validates the __proto__ entry with the value schema", () => {
    const result = schema.safeParse(authored('{"__proto__":{"value":"x"}}'));
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["__proto__", "value"]]);
  });

  test("validates the __proto__ name with the key schema", () => {
    const strictKeys = prototypeOwnKeyRecord(z.string().regex(/^[a-z]+$/), z.number());
    expect(strictKeys.safeParse(authored('{"__proto__":1}')).success).toBe(false);
  });

  test("advertises the plain record shape", () => {
    expect(z.toJSONSchema(schema)).toMatchObject({
      allOf: [{ type: "object", additionalProperties: { type: "object" } }, {}],
    });
  });
});

describe("prototypeOwnKeyRecordV3 (zod/v3)", () => {
  const schema = prototypeOwnKeyRecordV3(z3.string(), z3.boolean());

  test("keeps an own __proto__ entry and ordinary keys", () => {
    const parsed = schema.parse(authored('{"__proto__":true,"b":false}'));
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed).sort()).toEqual(["__proto__", "b"]);
  });

  test("rejects an invalid __proto__ value at its path", () => {
    const result = schema.safeParse(authored('{"__proto__":1}'));
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["__proto__"]]);
  });

  test("leaves a record without __proto__ unchanged", () => {
    expect(schema.parse({ a: true })).toEqual({ a: true });
  });
});
