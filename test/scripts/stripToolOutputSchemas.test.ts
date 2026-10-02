import { expect, test } from "bun:test";
import { stripToolOutputSchemas } from "../../scripts/build/strip-tool-output-schemas";

test("strips only top-level outputSchema, preserving other keys, order, and input", () => {
  const definitions = [
    {
      name: "observe",
      outputSchema: { type: "object" },
      description: "unchanged",
      inputSchema: { properties: { outputSchema: { type: "string" } } },
      _meta: { ui: "unchanged" },
      futureKey: true,
    },
    { description: "no output schema", name: "tapOn", inputSchema: {} },
  ];
  const before = JSON.stringify(definitions);
  const stripped = stripToolOutputSchemas(definitions);
  expect(stripped).toEqual([
    {
      name: "observe",
      description: "unchanged",
      inputSchema: definitions[0]!.inputSchema,
      _meta: { ui: "unchanged" },
      futureKey: true,
    },
    definitions[1],
  ]);
  expect(Object.keys(stripped[0]!)).toEqual([
    "name",
    "description",
    "inputSchema",
    "_meta",
    "futureKey",
  ]);
  expect(Object.keys(stripped[1]!)).toEqual(Object.keys(definitions[1]!));
  expect(JSON.stringify(definitions)).toBe(before);
  expect(stripToolOutputSchemas(stripped)).toEqual(stripped);
  expect(stripToolOutputSchemas([])).toEqual([]);
});
