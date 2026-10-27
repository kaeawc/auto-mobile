import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  escapeModelIdentifier,
  modelOutputPaths,
  renderPrototypeSpecModels,
  staleModelOutputs,
} from "../../../scripts/prototype/generate-prototype-spec-models";
import {
  prototypeModelSelection,
  prototypeTypeRefs,
} from "../../../scripts/prototype/prototype-model-selection";
import {
  boundsSchema,
  offsetSchema,
  paddingSchema,
  safeAreaPaddingSchema,
  sheetConditionSchema,
} from "../../../src/features/prototype/prototypePresentationSchemas";
import type { Rule } from "../../../src/features/prototype/prototypeBindingValidation";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import * as presentation from "../../../src/features/prototype/prototypePresentationSchemas";
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

  test("renders nested objects before their parent and resolves selected refs", () => {
    const result = renderPrototypeSpecModels(
      {
        definitions: {
          parent: {
            kind: "object",
            fields: {
              child: {
                rule: {
                  kind: "object",
                  fields: { value: { rule: { kind: "string" }, optional: false } },
                },
                optional: false,
              },
              point: { rule: { kind: "ref", name: "point" }, optional: true },
            },
          },
          point: tinyContract.definitions.point,
        },
      },
      { parent: {}, point: { kotlinName: "CustomPoint" } },
    );
    expect(result.kotlin).toContain("val point: CustomPoint? = null");
    expect(result.kotlin.indexOf("data class PrototypeParentChild")).toBeLessThan(
      result.kotlin.indexOf("data class PrototypeParent("),
    );
    expect(result.swift).toContain("let child: ParentChild");
  });

  test.each([
    ["kotlin", "when", "`when`"],
    ["kotlin", "typeof", "`typeof`"],
    ["swift", "switch", "`switch`"],
    ["swift", "default", "`default`"],
    ["swift", "in", "`in`"],
    ["swift", "class", "`class`"],
    ["kotlin", "value", "value"],
    ["swift", "value", "value"],
  ] as const)("escapes %s identifier %s", (language, name, expected) => {
    expect(escapeModelIdentifier(name, language)).toBe(expected);
  });

  test("leaves contextual Swift keywords unescaped", () => {
    for (const name of [
      "left",
      "right",
      "get",
      "set",
      "optional",
      "required",
      "none",
      "lazy",
      "weak",
      "dynamic",
      "didSet",
      "willSet",
      "actor",
      "async",
      "await",
      "some",
      "any",
      "borrowing",
      "consuming",
      "nonisolated",
      "open",
      "isolated",
      "distributed",
      "sending",
      "macro",
      "package",
    ]) {
      expect(escapeModelIdentifier(name, "swift")).toBe(name);
    }
  });

  test("escapes Swift member names and argument labels only where required", () => {
    for (const name of ["self", "Type", "Protocol", "init", "switch", "in"]) {
      expect(escapeModelIdentifier(name, "swift", "member")).toBe(
        ["self", "Type", "Protocol", "init"].includes(name) ? `\`${name}\`` : name,
      );
    }
    for (const name of ["inout", "var", "let", "switch", "in"]) {
      expect(escapeModelIdentifier(name, "swift", "argument")).toBe(
        ["inout", "var", "let"].includes(name) ? `\`${name}\`` : name,
      );
    }
  });

  const tagged = {
    definitions: {
      choice: {
        kind: "tagged",
        variants: {
          switch: {
            kind: "object",
            fields: {
              type: { rule: { kind: "enum", values: ["switch"] }, optional: false },
              in: { rule: { kind: "string" }, optional: true },
            },
          },
          default: {
            kind: "object",
            fields: {
              type: { rule: { kind: "enum", values: ["default"] }, optional: false },
              when: { rule: { kind: "boolean" }, optional: false },
            },
          },
        },
      },
    },
  };
  test("renders exact tagged Kotlin with names, docs and keyword fields", () => {
    expect(
      renderPrototypeSpecModels(tagged, {
        choice: {
          kotlinName: "CustomChoice",
          variantNames: { switch: "CustomSwitch" },
          doc: "Choice.",
          variantDocs: { switch: "Switch." },
        },
      }).kotlin,
    ).toBe(`${header}package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Choice. */
@Serializable sealed class CustomChoice

/** Switch. */
@SerialName("switch")
@Serializable
data class CustomSwitch(val \`in\`: String? = null) : CustomChoice()

@SerialName("default")
@Serializable
data class PrototypeDefaultChoice(val \`when\`: Boolean) : CustomChoice()
`);
  });
  test("renders exact Swift tagged Codable with optional values and escaped identifiers", () => {
    expect(renderPrototypeSpecModels(tagged, { choice: { swiftName: "ChoiceValue" } }).swift)
      .toBe(`${header}
enum ChoiceValue: Codable, Equatable, Sendable {
    case \`switch\`(in: String?)
    case \`default\`(when: Bool)

    private enum CodingKeys: String, CodingKey {
        case type
        case \`in\`
        case when
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "switch":
            self = try .switch(
                in: container.decodeIfPresent(String.self, forKey: .in)
            )
        case "default":
            self = try .default(
                when: container.decode(Bool.self, forKey: .when)
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown ChoiceValue type \\(type)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .switch(in: \`in\`):
            try container.encode("switch", forKey: .type)
            try container.encodeIfPresent(\`in\`, forKey: .in)
        case let .default(when: when):
            try container.encode("default", forKey: .type)
            try container.encode(when, forKey: .when)
        }
    }
}
`);
  });
  test("honors independent Swift encode/decode conformances for structs and unions", () => {
    const decode = renderPrototypeSpecModels(tagged, {
      choice: { languages: ["swift"], swiftConformances: ["Decodable"] },
    });
    expect(decode.kotlin).not.toContain("sealed");
    expect(decode.swift).toContain("enum Choice: Decodable");
    expect(decode.swift).not.toContain("func encode");
    const encode = renderPrototypeSpecModels(tagged, {
      choice: { swiftConformances: ["Encodable"] },
    });
    expect(encode.swift).toContain("func encode");
    expect(encode.swift).not.toContain("init(from");
    expect(
      renderPrototypeSpecModels(tinyContract, { point: { swiftConformances: ["Decodable"] } })
        .swift,
    ).toContain("struct Point: Decodable {");
  });
  test("resolves selected models before typeRefs, string enums before typeRefs, and external types per language", () => {
    const source = {
      definitions: {
        ...tinyContract.definitions,
        stringEnum: { kind: "enum", values: ["a"] },
        holder: {
          kind: "object",
          fields: {
            selected: { rule: { kind: "ref", name: "point" }, optional: false },
            enum: { rule: { kind: "ref", name: "stringEnum" }, optional: false },
            external: {
              rule: { kind: "array", item: { kind: "ref", name: "external" } },
              optional: false,
            },
          },
        },
      },
    };
    const refs = {
      point: { kotlin: "Wrong", swift: "Wrong" },
      stringEnum: { kotlin: "Wrong", swift: "Wrong" },
      external: { kotlin: "External" },
    };
    const result = renderPrototypeSpecModels(
      source,
      { holder: { languages: ["kotlin"] }, point: { kotlinName: "Renamed" } },
      refs,
    );
    expect(result.kotlin).toContain("val selected: Renamed");
    expect(result.kotlin).toContain("val enum: String");
    expect(result.kotlin).toContain("val external: List<External>");
    expect(() => renderPrototypeSpecModels(source, { holder: {}, point: {} }, refs)).toThrow(
      "Definition holder.external: unsupported kind ref external",
    );
    expect(() => renderPrototypeSpecModels(source, { holder: {}, point: {} })).toThrow(
      "Definition holder.external: unsupported kind ref external",
    );
  });
  test("supports recursive Kotlin refs and refuses direct and mutual Swift recursion", () => {
    const source = {
      definitions: {
        a: {
          kind: "object",
          fields: { child: { rule: { kind: "ref", name: "a" }, optional: true } },
        },
      },
    };
    expect(renderPrototypeSpecModels(source, { a: { languages: ["kotlin"] } }).kotlin).toContain(
      "val child: PrototypeA? = null",
    );
    expect(() => renderPrototypeSpecModels(source, { a: {} })).toThrow(
      "recursive ref a is unsupported for Swift",
    );
    const mutual = {
      definitions: {
        a: {
          kind: "object",
          fields: { child: { rule: { kind: "ref", name: "b" }, optional: true } },
        },
        b: source.definitions.a,
      },
    };
    expect(() => renderPrototypeSpecModels(mutual, { a: {}, b: {} })).toThrow("recursive ref");
  });
  test("does not descend into Kotlin-only recursion behind an external Swift ref", () => {
    const result = renderPrototypeSpecModels(
      {
        definitions: {
          holder: {
            kind: "object",
            fields: { value: { rule: { kind: "ref", name: "wrapper" }, optional: false } },
          },
          wrapper: {
            kind: "object",
            fields: { child: { rule: { kind: "ref", name: "recursive" }, optional: false } },
          },
          recursive: {
            kind: "object",
            fields: { child: { rule: { kind: "ref", name: "recursive" }, optional: true } },
          },
        },
      },
      { holder: {}, wrapper: {}, recursive: { languages: ["kotlin"] } },
      { recursive: { swift: "ExternalRecursive" } },
    );
    expect(result.swift).toContain("let value: Wrapper");
    expect(result.swift).toContain("let child: ExternalRecursive");
    expect(result.swift).not.toContain("struct Recursive");
    expect(result.kotlin).toContain("val child: PrototypeRecursive? = null");
  });
  test("detects tags structurally and rejects inconsistent tags and empty variants", () => {
    const variant = (
      tag: string,
      value: string,
      fields: Record<string, { rule: Rule; optional: boolean }> = {},
    ) => ({
      kind: "object",
      fields: { [tag]: { rule: { kind: "enum", values: [value] }, optional: false }, ...fields },
    });
    const render = (variants: Record<string, Rule>, swiftOnly = false) =>
      renderPrototypeSpecModels(
        { definitions: { union: { kind: "tagged", variants } } },
        { union: swiftOnly ? { languages: ["swift"] } : {} },
      );
    expect(() => render({ a: variant("type", "a"), b: variant("kind", "b") })).toThrow(
      "no consistent tag field",
    );
    expect(() => render({ a: variant("type", "a") })).toThrow("variant without fields");
    const kindVariants = {
      a: variant("kind", "a", { value: { rule: { kind: "string" }, optional: false } }),
    };
    expect(() => render(kindVariants)).toThrow(
      'Definition union: Kotlin tagged union requires tag field "type" to match classDiscriminator; found "kind"',
    );
    expect(
      render({ a: variant("type", "a", { value: { rule: { kind: "string" }, optional: false } }) })
        .kotlin,
    ).toContain("@Serializable sealed class PrototypeUnion");
    expect(render(kindVariants, true).swift).toContain("forKey: .kind");
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

  test.each(["ref", "color", "choice", "tagged", "record", "map", "screenMap", "data", "true"])(
    "refuses unsupported selected field kind %s with its definition and field",
    (kind) => {
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
    },
  );

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
    ).toThrow("Definition point.value: unsupported kind ref x");
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
    const expected = renderPrototypeSpecModels(
      contract,
      prototypeModelSelection,
      prototypeTypeRefs,
    );
    const read = (path: string) =>
      readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    expect(
      staleModelOutputs(expected, {
        kotlin: read(modelOutputPaths.kotlin),
        swift: read(modelOutputPaths.swift),
      }),
    ).toEqual([]);
  });

  test("filled fixtures cover every contract field, with a separate semantic condition tree", () => {
    for (const [definition, value] of [
      [contract.definitions.condition, fixture.conditionFilled],
      [contract.definitions.style, fixture.style],
      [contract.definitions.item, fixture.item],
    ] as const) {
      expect(Object.keys(value).sort()).toEqual(Object.keys(definition.fields).sort());
    }
    // The contract allows one condition selector/comparator at a time, unlike the wire model.
    expect(presentation.conditionSchema.safeParse(fixture.conditionFilled).success).toBe(false);
  });

  test("every migrated fixture satisfies the existing contract interpreters", () => {
    const leaves = [
      [presentation.conditionSchema, fixture.condition],
      [presentation.styleSchema, fixture.style],
      [presentation.itemSchema, fixture.item],
      [presentation.itemSchema, fixture.itemString],
      [presentation.containerSchema, fixture.container],
      [presentation.selectorSchema, fixture.selector],
      [presentation.styleWhenEntrySchema, fixture.styleWhenEntry],
      [presentation.anchorSchema, fixture.anchorBounds],
      [presentation.anchorSchema, fixture.anchorElement],
      [presentation.placementSchema, fixture.placementFullscreen],
      [presentation.placementSchema, fixture.placementSheet],
      [presentation.placementSchema, fixture.placementFloating],
      [presentation.gradientSchema, fixture.gradientLinear],
      [presentation.gradientSchema, fixture.gradientRadial],
      [presentation.borderSchema, fixture.border],
      [presentation.gradientStopSchema, fixture.gradientStop],
    ] as const;
    for (const [schema, value] of leaves) {
      expect<unknown>(schema.parse(value)).toEqual(value);
    }
    const spec = {
      id: "models",
      state: { enabled: true },
      window: { placement: fixture.placementFullscreen, opacity: 100 },
      root: {
        type: "column",
        children: [
          { type: "topAppBar", title: "Title", actions: [fixture.appBarAction] },
          {
            type: "dialog",
            openWhen: { key: "enabled", equals: true },
            title: "Title",
            confirm: fixture.dialogButton,
          },
          {
            type: "scroll",
            axis: "vertical",
            refresh: fixture.scrollRefresh,
            child: { type: "column", children: [] },
          },
          ...[
            fixture.listItemTrailingSwitch,
            fixture.listItemTrailingCheckbox,
            fixture.listItemTrailingIcon,
          ].map((trailing) => ({ type: "listItem", headline: "Item", trailing })),
        ],
      },
    };
    expect<unknown>(validatePrototypeSpec(spec)).toEqual({ success: true, data: spec });
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

test("selected bounded records generate native number maps", () => {
  const sources = renderPrototypeSpecModels(
    {
      definitions: {
        shader: {
          kind: "object",
          fields: {
            uniforms: {
              optional: true,
              rule: { kind: "record", maxEntries: 16, item: { kind: "number", integer: false } },
            },
          },
        },
      },
    },
    { shader: {} },
  );
  expect(sources.kotlin).toContain("Map<String, Double>?");
  expect(sources.swift).toContain("[String: Double]?");
});
