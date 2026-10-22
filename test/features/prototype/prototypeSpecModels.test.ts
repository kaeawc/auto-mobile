import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  modelOutputPaths,
  renderPrototypeSpecModels,
  staleModelOutputs,
} from "../../../scripts/prototype/generate-prototype-spec-models";
import { prototypeModelOverrides } from "../../../scripts/prototype/prototype-model-overrides";
import {
  offsetSchema,
  paddingSchema,
} from "../../../src/features/prototype/prototypePresentationSchemas";
import fixture from "../../fixtures/prototype-spec/models.json";

const tinyContract = {
  definitions: {
    point: {
      kind: "object",
      fields: {
        count: { rule: { kind: "number", integer: true }, optional: false },
        distance: { rule: { kind: "number", integer: false }, optional: true },
      },
    },
    unselected: { kind: "tagged" },
  },
};
const selection = { point: { count: "Int", distance: "Double" } } as const;
const header = `// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts
`;

describe("prototype model generator", () => {
  test("renders exact Kotlin and Swift sources, preserving field order and optionality", () => {
    expect(renderPrototypeSpecModels(tinyContract, selection)).toEqual({
      kotlin: `${header}package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable

@Serializable
data class PrototypePoint(
  val count: Int,
  val distance: Double? = null,
)
`,
      swift: `${header}
struct Point: Decodable, Encodable {
    let count: Int
    let distance: Double?
}
`,
    });
  });

  test("Kotlin numeric representation comes only from the explicit override", () => {
    const result = renderPrototypeSpecModels(tinyContract, {
      point: { count: "Double", distance: "Double" },
    });
    expect(result.kotlin).toContain("val count: Double,");
    expect(result.swift).toContain("let count: Int");
  });

  test.each([
    "ref",
    "enum",
    "string",
    "object",
    "array",
    "color",
    "boundKey",
    "choice",
    "tagged",
    "boolean",
    "pointer",
    "key",
    "json",
    "scalar",
    "record",
    "map",
    "screenMap",
    "data",
    "true",
  ])("refuses unsupported selected field kind %s with its definition and field", (kind) => {
    expect(() =>
      renderPrototypeSpecModels(
        {
          definitions: {
            point: { kind: "object", fields: { value: { rule: { kind }, optional: false } } },
          },
        },
        { point: {} },
      ),
    ).toThrow(`Definition point.value: unsupported kind ${kind}`);
  });

  test("refuses selected non-object definitions and absent definitions", () => {
    expect(() => renderPrototypeSpecModels(tinyContract, { unselected: {} })).toThrow(
      "Definition unselected: unsupported kind tagged",
    );
    expect(() => renderPrototypeSpecModels(tinyContract, { absent: {} })).toThrow(
      "Definition absent: not found",
    );
    expect(() =>
      renderPrototypeSpecModels(
        { definitions: { point: { kind: "object", fields: {} } } },
        { point: {} },
      ),
    ).toThrow("Definition point: empty objects are unsupported");
  });

  test("refuses missing and stale number overrides instead of guessing", () => {
    expect(() => renderPrototypeSpecModels(tinyContract, { point: {} })).toThrow(
      "Definition point.count: missing Kotlin Int/Double override",
    );
    expect(() =>
      renderPrototypeSpecModels(tinyContract, { point: { ...selection.point, stale: "Int" } }),
    ).toThrow("Definition point.stale: unused Kotlin number override");
  });

  test("drift check detects stale, missing, and individually changed outputs", () => {
    const expected = renderPrototypeSpecModels(tinyContract, selection);
    expect(staleModelOutputs(expected, expected)).toEqual([]);
    expect(staleModelOutputs(expected, { ...expected, kotlin: expected.kotlin + "\n" })).toEqual([
      modelOutputPaths.kotlin,
    ]);
    expect(staleModelOutputs(expected, { ...expected, swift: "stale" })).toEqual([
      modelOutputPaths.swift,
    ]);
    expect(staleModelOutputs(expected, { kotlin: undefined, swift: undefined })).toEqual([
      modelOutputPaths.kotlin,
      modelOutputPaths.swift,
    ]);
  });

  test("checked-in outputs equal the canonical contract rendering", () => {
    const expected = renderPrototypeSpecModels(contract, prototypeModelOverrides);
    const read = (path: string) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    expect(
      staleModelOutputs(expected, {
        kotlin: read(modelOutputPaths.kotlin),
        swift: read(modelOutputPaths.swift),
      }),
    ).toEqual([]);
  });

  test("filled shared model fixture round-trips through the TypeScript leaf schemas", () => {
    const decoded = {
      offset: offsetSchema.parse(fixture.offset),
      padding: paddingSchema.parse(fixture.padding),
    };
    expect(JSON.parse(JSON.stringify(decoded))).toEqual(fixture);
    expect(offsetSchema.safeParse({ ...fixture.offset, unknown: 1 }).success).toBe(false);
    expect(paddingSchema.safeParse({ ...fixture.padding, unknown: 1 }).success).toBe(false);
    expect(paddingSchema.parse({})).toEqual({});
  });
});
