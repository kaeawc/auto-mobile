import { describe, expect, test } from "bun:test";
import { compileAjv2020, compileLargeAjv2020 } from "./jsonSchemaCompile";

// A recursive schema with internal JSON-pointer refs, the shape that makes the large-schema
// options matter: the verdicts must match the default options exactly.
const schema = {
  $defs: {
    node: {
      type: "object",
      properties: {
        type: { enum: ["text", "column"] },
        children: { type: "array", items: { $ref: "#/$defs/node" } },
        text: { type: "string" },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  type: "object",
  properties: { root: { $ref: "#/$defs/node" }, other: { $ref: "#/properties/root" } },
  required: ["root"],
};

const samples: unknown[] = [
  { root: { type: "text", text: "a" } },
  { root: { type: "column", children: [{ type: "text" }, { type: "column", children: [] }] } },
  { root: { type: "column", children: [{ type: "image" }] } },
  { root: { type: "text", extra: 1 } },
  { root: { type: "text" }, other: { type: "column", children: [{ text: "missing type" }] } },
  {},
];

describe("compileLargeAjv2020", () => {
  test("gives the same verdicts as the default options", () => {
    const fast = compileLargeAjv2020(structuredClone(schema));
    const reference = compileAjv2020(structuredClone(schema));
    expect(samples.map((sample) => fast(sample))).toEqual(
      samples.map((sample) => reference(sample)),
    );
    expect(samples.map((sample) => fast(sample))).toEqual([true, true, false, false, false, false]);
  });
});
