import { expect, test } from "bun:test";
import { renderPrototypeSpecModels } from "../../../scripts/prototype/generate-prototype-spec-models";
import type { ModelOptions } from "../../../scripts/prototype/prototype-model-selection";
import type { Rule } from "../../../src/features/prototype/prototypeBindingValidation";

const header = `// Generated from schemas/prototype-spec-contract.json; do not edit.
// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts
`;
const kotlinHeader = `${header}package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.Serializable
`;
const field = (rule: Rule, optional = false) => ({ rule, optional });
const object = (fields: NonNullable<Rule["fields"]>): Rule => ({ kind: "object", fields });
const render = (rule: Rule, options: ModelOptions = {}) =>
  renderPrototypeSpecModels({ definitions: { sample: rule } }, { sample: options });

test("opaque JSON, scalar and records map recursively and import JsonElement only when used", () => {
  const result = render(
    object({
      json: field({ kind: "json" }),
      scalar: field({ kind: "scalar" }, true),
      values: field({ kind: "record", item: { kind: "json" } }),
      counts: field({ kind: "record", item: { kind: "number", integer: true } }, true),
    }),
  );
  expect(result).toEqual({
    kotlin: `${kotlinHeader}import kotlinx.serialization.json.JsonElement

@Serializable
data class PrototypeSample(
  val json: JsonElement,
  val scalar: PrototypeScalar? = null,
  val values: Map<String, JsonElement>,
  val counts: Map<String, Int>? = null,
)
`,
    swift: `${header}
struct Sample: Codable, Equatable, Sendable {
    let json: JSONValue
    let scalar: JSONValue?
    let values: [String: JSONValue]
    let counts: [String: Int]?
}
`,
  });
  expect(render(object({ value: field({ kind: "scalar" }) })).kotlin).not.toContain(
    "import kotlinx.serialization.json",
  );
  expect(() =>
    render(object({ value: field({ kind: "record", item: { kind: "choice" } }) })),
  ).toThrow("unsupported kind choice");
  expect(() => render(object({ value: field({ kind: "record" }) }))).toThrow(
    "unsupported kind record",
  );
});

test("explicit language types bypass unmappable choice/ref rules and preserve optionality", () => {
  const rule = object({
    value: field({ kind: "choice" }, true),
    screens: field({ kind: "screenMap" }),
  });
  const result = render(rule, {
    fieldTypes: {
      value: { kotlin: "NativeValue", swift: "OtherValue" },
      screens: { kotlin: "NativeScreens", swift: "OtherScreens" },
    },
    swiftConformances: ["Decodable"],
  });
  expect(result).toEqual({
    kotlin: `${kotlinHeader}
@Serializable
data class PrototypeSample(
  val value: NativeValue? = null,
  val screens: NativeScreens,
)
`,
    swift: `${header}
struct Sample: Decodable {
    let value: OtherValue?
    let screens: OtherScreens
}
`,
  });
  expect(() =>
    render(rule, {
      fieldTypes: { value: { kotlin: "NativeValue" }, screens: { kotlin: "NativeScreens" } },
    }),
  ).toThrow("unsupported kind choice");
  expect(
    render(object({ value: field({ kind: "ref", name: "handWritten" }) }), {
      fieldTypes: { value: { kotlin: "HandWritten", swift: "HandWritten" } },
    }).swift,
  ).toBe(`${header}
struct Sample: Codable, Equatable, Sendable {
    let value: HandWritten
}
`);
});

test("field docs, Kotlin defaults and object validators render exact declarations and decoder", () => {
  const result = render(
    object({
      variant: field({ kind: "string" }, true),
      value: field({ kind: "number", integer: true }),
    }),
    {
      fieldDocs: { variant: "First line.\nSecond line.", value: "Value." },
      fieldDefaults: { variant: { kotlin: '"filled"' } },
      validators: {
        variant: { kotlin: "validateVariant", swift: "validateVariant" },
        value: { kotlin: "validateValue", swift: "validateValue" },
      },
      swiftConformances: ["Decodable", "Equatable"],
    },
  );
  expect(result).toEqual({
    kotlin: `${kotlinHeader}
@Serializable
data class PrototypeSample(
  /**
   * First line.
   * Second line.
   */
  val variant: String = "filled",
  /** Value. */
  val value: Int,
) {
  init {
    validateVariant(variant)
    validateValue(value)
  }
}
`,
    swift: `${header}
struct Sample: Decodable, Equatable {
    /// First line.
    /// Second line.
    let variant: String?
    /// Value.
    let value: Int

    private enum CodingKeys: String, CodingKey {
        case variant
        case value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let variant = try container.decodeIfPresent(String.self, forKey: .variant)
        try validateVariant(variant, forKey: .variant, in: container)
        let value = try container.decode(Int.self, forKey: .value)
        try validateValue(value, forKey: .value, in: container)
        self.variant = variant
        self.value = value
    }
}
`,
  });
});

test("rejects Swift defaults, null defaults, required-field defaults and validators without decoding", () => {
  const rule = object({ value: field({ kind: "string" }, true) });
  expect(() => render(rule, { fieldDefaults: { value: { swift: '"x"' } } })).toThrow(
    "Swift field defaults are unsupported",
  );
  expect(() => render(rule, { fieldDefaults: { value: { kotlin: "null" } } })).toThrow(
    "non-null value",
  );
  expect(() =>
    render(object({ value: field({ kind: "string" }) }), {
      fieldDefaults: { value: { kotlin: '"x"' } },
    }),
  ).toThrow("optional field");
  expect(() =>
    render(rule, { swiftConformances: ["Encodable"], validators: { value: { swift: "check" } } }),
  ).toThrow("Decodable conformance");
});

test("String overloads retain parameter order, defaults and ModeValue delegation", () => {
  const options = {
    languages: ["kotlin"],
    kotlinStringOverloads: ["image"],
    fieldTypes: { image: { kotlin: "PrototypeModeValue" } },
  } as const;
  expect(
    render(
      object({
        label: field({ kind: "string" }),
        icon: field({ kind: "string" }, true),
        image: field({ kind: "choice" }, true),
      }),
      options,
    ).kotlin,
  ).toBe(`${kotlinHeader}
@Serializable
data class PrototypeSample(
  val label: String,
  val icon: String? = null,
  val image: PrototypeModeValue? = null,
) {
  constructor(
    label: String,
    icon: String? = null,
    image: String,
  ) : this(label, icon, PrototypeModeValue.Single(image))
}
`);
  const mode = field({ kind: "ref", name: "colorValue" });
  const result = renderPrototypeSpecModels(
    {
      definitions: {
        border: object({ width: field({ kind: "number" }), color: mode }),
        stop: object({ color: mode, position: field({ kind: "number" }, true) }),
      },
    },
    {
      border: { languages: ["kotlin"], kotlinStringOverloads: ["color"] },
      stop: { languages: ["kotlin"], kotlinStringOverloads: ["color"] },
    },
    { colorValue: { kotlin: "PrototypeModeValue" } },
  );
  expect(result.kotlin).toBe(`${kotlinHeader}
@Serializable
data class PrototypeBorder(
  val width: Double,
  val color: PrototypeModeValue,
) {
  constructor(width: Double, color: String) : this(width, PrototypeModeValue.Single(color))
}

@Serializable
data class PrototypeStop(
  val color: PrototypeModeValue,
  val position: Double? = null,
) {
  constructor(
    color: String,
    position: Double? = null,
  ) : this(PrototypeModeValue.Single(color), position)
}
`);
  expect(() =>
    render(object({ image: field({ kind: "string" }) }), { kotlinStringOverloads: ["image"] }),
  ).toThrow("requires a PrototypeModeValue field");
  expect(() =>
    render(object({ image: field({ kind: "string" }) }), { kotlinStringOverloads: ["missing"] }),
  ).toThrow("requires a PrototypeModeValue field");
});

test("union field options prefer variant keys, with language fallback and exact validation bodies", () => {
  const rule: Rule = {
    kind: "tagged",
    variants: {
      one: object({
        type: field({ kind: "enum", values: ["one"] }),
        value: field({ kind: "choice" }, true),
      }),
      two: object({
        type: field({ kind: "enum", values: ["two"] }),
        value: field({ kind: "choice" }, true),
      }),
    },
  };
  const result = render(rule, {
    fieldTypes: { value: { kotlin: "String", swift: "String" }, "one.value": { kotlin: "Int" } },
    fieldDocs: { value: "Shared.", "one.value": "One." },
    fieldDefaults: { value: { kotlin: '"fallback"' }, "one.value": { kotlin: "1" } },
    validators: {
      value: { kotlin: "checkShared", swift: "checkShared" },
      "one.value": { kotlin: "checkOne", swift: "checkOne" },
    },
    swiftConformances: ["Decodable"],
  });
  expect(result.kotlin)
    .toBe(`${kotlinHeader.replace("import kotlinx.serialization.Serializable", "import kotlinx.serialization.SerialName\nimport kotlinx.serialization.Serializable")}
@Serializable sealed class PrototypeSample

@SerialName("one")
@Serializable
data class PrototypeOneSample(
  /** One. */
  val value: Int = 1,
) : PrototypeSample() {
  init {
    checkOne(value)
  }
}

@SerialName("two")
@Serializable
data class PrototypeTwoSample(
  /** Shared. */
  val value: String = "fallback",
) : PrototypeSample() {
  init {
    checkShared(value)
  }
}
`);
  expect(result.swift).toBe(`${header}
enum Sample: Decodable {
    /// One.
    case one(value: String?)
    /// Shared.
    case two(value: String?)

    private enum CodingKeys: String, CodingKey {
        case type
        case value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "one":
            let value = try container.decodeIfPresent(String.self, forKey: .value)
            try checkOne(value, forKey: .value, in: container)
            self = .one(
                value: value
            )
        case "two":
            let value = try container.decodeIfPresent(String.self, forKey: .value)
            try checkShared(value, forKey: .value, in: container)
            self = .two(
                value: value
            )
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unknown Sample type \\(type)"
            )
        }
    }
}
`);
});
