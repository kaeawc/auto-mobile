import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  modelOutputPaths,
  renderPrototypeSpecModels,
  staleModelOutputs,
} from "../../../scripts/prototype/generate-prototype-spec-models";
import { prototypeModelSelection } from "../../../scripts/prototype/prototype-model-selection";
import {
  boundsSchema,
  offsetSchema,
  paddingSchema,
  safeAreaPaddingSchema,
  sheetConditionSchema,
} from "../../../src/features/prototype/prototypePresentationSchemas";
import type { Rule } from "../../../src/features/prototype/prototypeBindingValidation";
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
const selection = { point: {} } as const;
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
struct Point: Codable, Equatable, Sendable {
    let count: Int
    let distance: Double?
}
`,
    });
  });

  test("number representation follows the contract's integer flag in both languages", () => {
    const result = renderPrototypeSpecModels(tinyContract, selection);
    expect(result.kotlin).toContain("val count: Int,");
    expect(result.kotlin).toContain("val distance: Double? = null,");
    expect(result.swift).toContain("let count: Int");
  });

  test("maps strings, booleans, enums and arrays of those", () => {
    const rich = {
      definitions: {
        mixed: {
          kind: "object",
          fields: {
            name: { rule: { kind: "string" }, optional: false },
            key: { rule: { kind: "boundKey" }, optional: true },
            on: { rule: { kind: "boolean" }, optional: false },
            mode: { rule: { kind: "enum", values: ["a", "b"] }, optional: true },
            tags: { rule: { kind: "array", item: { kind: "string" } }, optional: false },
            edges: {
              rule: { kind: "array", item: { kind: "enum", values: ["top"] }, min: 1 },
              optional: false,
            },
          },
        },
      },
    };
    const result = renderPrototypeSpecModels(rich, { mixed: { doc: "Mixed." } });
    expect(result.kotlin).toContain(`/** Mixed. */
@Serializable
data class PrototypeMixed(
  val name: String,
  val key: String? = null,
  val on: Boolean,
  val mode: String? = null,
  val tags: List<String>,
  val edges: List<String>,
)`);
    expect(result.swift).toContain(`/// Mixed.
struct Mixed: Codable, Equatable, Sendable {
    let name: String
    let key: String?
    let on: Bool
    let mode: String?
    let tags: [String]
    let edges: [String]
}`);
  });

  test("languages and swiftName restrict and rename the emitted models", () => {
    const kotlinOnly = renderPrototypeSpecModels(tinyContract, {
      point: { languages: ["kotlin"] },
    });
    expect(kotlinOnly.kotlin).toContain("data class PrototypePoint(");
    expect(kotlinOnly.swift).not.toContain("Point");
    const swiftOnly = renderPrototypeSpecModels(tinyContract, {
      point: { languages: ["swift"], swiftName: "PrototypePoint" },
    });
    expect(swiftOnly.kotlin).not.toContain("Point");
    expect(swiftOnly.swift).toContain("struct PrototypePoint: Codable");
  });

  test.each([
    "ref",
    "object",
    "color",
    "choice",
    "tagged",
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

  test("refuses enums with non-string values and arrays of unsupported items", () => {
    const field = (rule: Rule) => ({
      definitions: { point: { kind: "object", fields: { value: { rule, optional: false } } } },
    });
    expect(() =>
      renderPrototypeSpecModels(field({ kind: "enum", values: [true, false] }), { point: {} }),
    ).toThrow("Definition point.value: unsupported kind enum");
    expect(() =>
      renderPrototypeSpecModels(field({ kind: "array", item: { kind: "ref", name: "x" } }), {
        point: {},
      }),
    ).toThrow("Definition point.value: unsupported kind array");
    expect(() =>
      renderPrototypeSpecModels(field({ kind: "array", item: { kind: "array" } }), { point: {} }),
    ).toThrow("Definition point.value: unsupported kind array");
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
    const expected = renderPrototypeSpecModels(contract, prototypeModelSelection);
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
      bounds: boundsSchema.parse(fixture.bounds),
      sheetCondition: sheetConditionSchema.parse(fixture.sheetCondition),
      safeAreaPadding: safeAreaPaddingSchema.parse(fixture.safeAreaPadding),
    };
    const { offset, padding, bounds, sheetCondition, safeAreaPadding } = fixture;
    expect(JSON.parse(JSON.stringify(decoded))).toEqual({
      offset,
      padding,
      bounds,
      sheetCondition,
      safeAreaPadding,
    });
    expect(offsetSchema.safeParse({ ...fixture.offset, unknown: 1 }).success).toBe(false);
    expect(paddingSchema.safeParse({ ...fixture.padding, unknown: 1 }).success).toBe(false);
    expect(paddingSchema.parse({})).toEqual({});
  });
});
