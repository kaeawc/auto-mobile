import { expect, test } from "bun:test";
import { flattenTopLevelUnion } from "../../src/server/TopLevelUnionFlattener";

test("merges repeated properties in branch order while retaining nested unions verbatim", () => {
  const nested = { anyOf: [{ type: "string" }, { type: "number" }] };
  const schema = {
    $id: "nested-tool",
    definitions: { nested },
    anyOf: [
      {
        properties: { mode: { const: "a", description: "first" }, nested, zero: false },
        required: ["nested"],
        additionalProperties: false,
      },
      {
        properties: {
          mode: { enum: ["b", "a"] },
          nested: { oneOf: [{ type: "boolean" }] },
          zero: { type: "number" },
        },
        required: ["nested"],
        additionalProperties: true,
      },
      { additionalProperties: "ignored" },
    ],
  };
  expect(flattenTopLevelUnion(schema)).toEqual({
    $id: "nested-tool",
    definitions: { nested },
    type: "object",
    properties: {
      mode: { description: "first", enum: ["a", "b"] },
      nested,
      zero: { type: "number" },
    },
    if: { properties: { mode: { const: "a" } }, required: ["mode"] },
    then: { required: ["nested"] },
  });
  expect(schema.anyOf[0].properties?.mode).toEqual({ const: "a", description: "first" });
});

test("an empty preferred anyOf masks oneOf and retains metadata", () => {
  expect(
    flattenTopLevelUnion({
      anyOf: [],
      oneOf: [{ properties: { x: {} } }],
      $schema: "draft",
      $defs: {},
    }),
  ).toEqual({
    $schema: "draft",
    $defs: {},
    type: "object",
    properties: {},
  });
});
