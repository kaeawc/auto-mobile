import { describe, expect, test } from "bun:test";
import { flattenTopLevelUnion } from "../../src/server/toolRegistry";

describe("flattenTopLevelUnion", () => {
  test("returns non-union schema unchanged", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    expect(flattenTopLevelUnion(schema)).toEqual(schema);
  });

  test("flattens anyOf branches into single object", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      ],
    };
    const result = flattenTopLevelUnion(schema);
    expect(result.type).toBe("object");
    expect(result.anyOf).toBeUndefined();
    expect((result.properties as any).text).toEqual({ type: "string" });
    expect((result.properties as any).id).toEqual({ type: "string" });
    expect(result.required).toBeUndefined();
  });

  test("flattens oneOf branches", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { a: { type: "number" } } },
        { type: "object", properties: { b: { type: "boolean" } } },
      ],
    };
    const result = flattenTopLevelUnion(schema);
    expect(result.type).toBe("object");
    expect((result.properties as any).a).toEqual({ type: "number" });
    expect((result.properties as any).b).toEqual({ type: "boolean" });
  });

  test("merges shared properties from first branch", () => {
    const textDef = { type: "string", description: "from branch 1" };
    const schema = {
      anyOf: [
        { type: "object", properties: { text: textDef, timeout: { type: "number" } } },
        {
          type: "object",
          properties: {
            text: { type: "string", description: "from branch 2" },
            id: { type: "string" },
          },
        },
      ],
    };
    const result = flattenTopLevelUnion(schema);
    // First-seen wins for duplicate keys
    expect((result.properties as any).text).toEqual(textDef);
    expect((result.properties as any).timeout).toEqual({ type: "number" });
    expect((result.properties as any).id).toEqual({ type: "string" });
  });

  test("preserves additionalProperties when consistent across branches", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: {}, additionalProperties: false },
        { type: "object", properties: {}, additionalProperties: false },
      ],
    };
    const result = flattenTopLevelUnion(schema);
    expect(result.additionalProperties).toBe(false);
  });

  test("drops additionalProperties when inconsistent across branches", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: {}, additionalProperties: false },
        { type: "object", properties: {}, additionalProperties: true },
      ],
    };
    const result = flattenTopLevelUnion(schema);
    expect(result.additionalProperties).toBeUndefined();
  });

  test("preserves $schema if present", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      anyOf: [{ type: "object", properties: { a: { type: "string" } } }],
    };
    const result = flattenTopLevelUnion(schema);
    expect(result.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("preserves $defs referenced by flattened branch properties", () => {
    const schema = {
      $defs: {
        node: {
          type: "object",
          properties: {
            child: { $ref: "#/$defs/node" },
          },
        },
      },
      anyOf: [
        { type: "object", properties: { node: { $ref: "#/$defs/node" } } },
        { type: "object", properties: { artifact: { type: "object" } } },
      ],
    };

    const result = flattenTopLevelUnion(schema);

    expect(result.$defs).toEqual(schema.$defs);
    expect((result.properties as any).node).toEqual({ $ref: "#/$defs/node" });
  });

  test("handles empty properties in branches", () => {
    const schema = {
      anyOf: [{ type: "object" }, { type: "object", properties: { x: { type: "string" } } }],
    };
    const result = flattenTopLevelUnion(schema);
    expect(result.type).toBe("object");
    expect((result.properties as any).x).toEqual({ type: "string" });
  });

  test("keeps discriminator branches flattened without top-level combinators", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            platform: { type: "string", const: "ios", description: "Target platform" },
            title: { type: "string" },
            appId: { type: "string" },
          },
          required: ["platform", "title", "appId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            platform: { type: "string", const: "android", description: "Target platform" },
            title: { type: "string" },
            appId: { type: "string" },
          },
          required: ["platform", "title"],
          additionalProperties: false,
        },
      ],
    };

    const result = flattenTopLevelUnion(schema);

    expect(result.type).toBe("object");
    expect(result.oneOf).toBeUndefined();
    expect(result.allOf).toBeUndefined();
    expect((result.properties as any).platform).toEqual({
      type: "string",
      description: "Target platform",
      enum: ["ios", "android"],
    });
    expect(result.required).toEqual(["platform", "title"]);
  });

  test("preserves a branch-only required field as a conditional requirement", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: {
            platform: { type: "string", const: "ios", description: "Target platform" },
            title: { type: "string" },
            appId: { type: "string" },
          },
          required: ["platform", "title", "appId"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            platform: { type: "string", const: "android", description: "Target platform" },
            title: { type: "string" },
            appId: { type: "string" },
          },
          required: ["platform", "title"],
          additionalProperties: false,
        },
      ],
    };

    const result = flattenTopLevelUnion(schema);

    expect(result.required).toEqual(["platform", "title"]);
    expect(result.if).toEqual({
      properties: {
        platform: { const: "ios" },
      },
      required: ["platform"],
    });
    expect(result.then).toEqual({
      required: ["appId"],
    });
  });
});
