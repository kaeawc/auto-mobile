import { describe, expect, test } from "bun:test";
import { normalizeZod4JsonSchema } from "../../../src/server/pipeline/normalizeZod4JsonSchema";

describe("normalizeZod4JsonSchema", () => {
  test("spells a type array as anyOf of single-type branches, keeping siblings", () => {
    const apiLevel: Record<string, unknown> = {
      type: ["number", "null"],
      description: "API level",
    };
    normalizeZod4JsonSchema({ type: "object", properties: { apiLevel } });
    expect(apiLevel).toEqual({
      description: "API level",
      anyOf: [{ type: "number" }, { type: "null" }],
    });
  });

  test("rewrites type arrays nested in arrays and leaves an existing anyOf alone", () => {
    const schema: Record<string, unknown> = {
      anyOf: [{ type: ["string", "boolean"] }, { type: "null" }],
      items: [{ type: ["integer", "null"] }],
    };
    normalizeZod4JsonSchema(schema);
    expect(schema).toEqual({
      anyOf: [{ anyOf: [{ type: "string" }, { type: "boolean" }] }, { type: "null" }],
      items: [{ anyOf: [{ type: "integer" }, { type: "null" }] }],
    });
  });

  test("drops the non-standard check formats and keeps standard ones", () => {
    const room: Record<string, unknown> = {
      type: "string",
      format: "starts_with",
      pattern: "^\\/.*",
    };
    const id: Record<string, unknown> = { type: "string", format: "uuid" };
    normalizeZod4JsonSchema({ properties: { room, id } });
    expect(room).toEqual({ type: "string", pattern: "^\\/.*" });
    expect(id.format).toBe("uuid");
  });

  test("inlines a single-use definition, keeping sibling annotations", () => {
    const schema: Record<string, unknown> = {
      type: "object",
      properties: { a: { description: "d", $ref: "#/$defs/__schema0" } },
      $defs: { __schema0: { type: "object", properties: { x: { type: "string" } } } },
    };
    normalizeZod4JsonSchema(schema);
    expect(schema).toEqual({
      type: "object",
      properties: {
        a: { type: "object", properties: { x: { type: "string" } }, description: "d" },
      },
    });
  });

  test("keeps shared and recursive definitions behind a $ref", () => {
    const shared = { $ref: "#/$defs/shared" };
    const schema: Record<string, unknown> = {
      properties: { a: shared, b: { $ref: "#/$defs/shared" }, tree: { $ref: "#/$defs/node" } },
      $defs: {
        shared: { type: "string" },
        node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } },
      },
    };
    normalizeZod4JsonSchema(schema);
    expect(shared).toEqual({ $ref: "#/$defs/shared" });
    expect(Object.keys(schema.$defs ?? {})).toEqual(["shared", "node"]);
  });

  test("follows a definition that is itself a bare $ref to another single-use one", () => {
    const schema: Record<string, unknown> = {
      properties: { a: { $ref: "#/$defs/outer" } },
      $defs: { outer: { $ref: "#/$defs/inner" }, inner: { type: "number" } },
    };
    normalizeZod4JsonSchema(schema);
    expect(schema).toEqual({ properties: { a: { type: "number" } } });
  });
});
