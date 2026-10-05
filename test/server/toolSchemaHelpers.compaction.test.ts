import { describe, expect, test } from "bun:test";
import { compactExclusiveSelectorProperties } from "../../src/server/toolSchemaHelpers";

const textBranch = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const idBranch = {
  type: "object",
  properties: { elementId: { type: "string" } },
  required: ["elementId"],
};

describe("exclusive selector compaction characterization", () => {
  test.each(["anyOf", "oneOf"])("compacts %s and preserves only string descriptions", (keyword) => {
    const schema = {
      properties: {
        selector: {
          [keyword]: [textBranch, idBranch],
          description: "pick one",
          title: "discarded",
        },
        noDescription: { [keyword]: [idBranch, textBranch], description: 123 },
      },
    };
    compactExclusiveSelectorProperties(schema, ["selector", "noDescription", "missing"]);
    expect(schema.properties).toEqual({
      selector: {
        type: "object",
        additionalProperties: false,
        description: "pick one",
        properties: { text: { type: "string" }, elementId: { type: "string" } },
        anyOf: [{ required: ["text"] }, { required: ["elementId"] }],
      },
      noDescription: {
        type: "object",
        additionalProperties: false,
        properties: { elementId: { type: "string" }, text: { type: "string" } },
        anyOf: [{ required: ["elementId"] }, { required: ["text"] }],
      },
    });
  });

  test.each([
    null,
    { type: "string" },
    { type: "object", properties: undefined, required: ["text"] },
    { type: "object", properties: { text: {} }, required: "text" },
    { type: "object", properties: { text: {} }, required: [] },
    { type: "object", properties: { text: {}, optional: {} }, required: ["text"] },
    { type: "object", properties: { other: {} }, required: ["text"] },
  ])("leaves the entire property untouched for a nonmatching branch %p", (branch) => {
    const prop = { anyOf: [textBranch, branch], description: "original" };
    const schema = { properties: { selector: prop } };
    const before = structuredClone(schema);
    compactExclusiveSelectorProperties(schema, ["selector"]);
    expect(schema).toEqual(before);
    expect(schema.properties.selector).toBe(prop);
  });

  test("anyOf takes precedence over oneOf even when it cannot be compacted", () => {
    const schema = { properties: { selector: { anyOf: [], oneOf: [textBranch, idBranch] } } };
    const before = structuredClone(schema);
    compactExclusiveSelectorProperties(schema, ["selector"]);
    expect(schema).toEqual(before);
  });

  test("preserves the existing error for null branch properties", () => {
    const schema = {
      properties: {
        selector: { anyOf: [textBranch, { type: "object", properties: null, required: ["text"] }] },
      },
    };
    expect(() => compactExclusiveSelectorProperties(schema, ["selector"])).toThrow(TypeError);
  });
});
