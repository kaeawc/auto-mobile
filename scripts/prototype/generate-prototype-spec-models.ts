import { existsSync, readFileSync, writeFileSync } from "node:fs";
import contract from "../../schemas/prototype-spec-contract.json";
import type { Rule } from "../../src/features/prototype/prototypeBindingValidation";
import { prototypeModelSelection } from "./prototype-model-selection";

export type ModelLanguage = "kotlin" | "swift";
export interface ModelOptions {
  readonly languages?: readonly ModelLanguage[];
  readonly swiftName?: string;
  readonly doc?: string;
}
export type ModelSelection = Readonly<Record<string, ModelOptions>>;
export interface ModelSources {
  kotlin: string;
  swift: string;
}

export const modelOutputPaths = {
  kotlin:
    "android/protocol/src/main/kotlin/dev/jasonpearson/automobile/protocol/PrototypeSpecModels.generated.kt",
  swift:
    "ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSpecModels.generated.swift",
} as const;

const header = [
  "// Generated from schemas/prototype-spec-contract.json; do not edit.",
  "// Regenerate: bun scripts/prototype/generate-prototype-spec-models.ts",
];

/**
 * Plain objects whose fields are numbers, strings, booleans, enums (carried as strings, so models
 * add no decoding error of their own) or arrays of those. Bounds, enum values and formats stay in
 * the contract and are enforced by its interpreters. Refs and nested objects remain hand-written.
 */
export function renderPrototypeSpecModels(
  source: { definitions: Readonly<Record<string, Rule>> },
  selection: ModelSelection,
): ModelSources {
  const kotlin = [
    ...header,
    "package dev.jasonpearson.automobile.protocol",
    "",
    "import kotlinx.serialization.Serializable",
  ];
  const swift = [...header];
  for (const [name, options] of Object.entries(selection)) {
    const definition = source.definitions[name];
    if (!definition) {
      throw new Error(`Definition ${name}: not found`);
    }
    if (definition.kind !== "object" || !definition.fields) {
      throw new Error(`Definition ${name}: unsupported kind ${definition.kind}; expected object`);
    }
    const fields = Object.entries(definition.fields);
    if (!fields.length) {
      throw new Error(`Definition ${name}: empty objects are unsupported`);
    }
    const languages = options.languages ?? ["kotlin", "swift"];
    const typeName = name.charAt(0).toUpperCase() + name.slice(1);
    const kotlinFields: string[] = [];
    const swiftFields: string[] = [];
    for (const [fieldName, field] of fields) {
      const types = field ? fieldTypes(field.rule) : undefined;
      if (!field || !types) {
        throw new Error(
          `Definition ${name}.${fieldName}: unsupported kind ${field?.rule.kind ?? "missing"}`,
        );
      }
      kotlinFields.push(`  val ${fieldName}: ${types.kotlin}${field.optional ? "? = null" : ""},`);
      swiftFields.push(`    let ${fieldName}: ${types.swift}${field.optional ? "?" : ""}`);
    }
    if (languages.includes("kotlin")) {
      kotlin.push(
        "",
        ...docLines(options.doc, "kotlin"),
        "@Serializable",
        `data class Prototype${typeName}(`,
      );
      kotlin.push(...kotlinFields, ")");
    }
    if (languages.includes("swift")) {
      swift.push(
        "",
        ...docLines(options.doc, "swift"),
        `struct ${options.swiftName ?? typeName}: Codable, Equatable, Sendable {`,
        ...swiftFields,
        "}",
      );
    }
  }
  return { kotlin: kotlin.join("\n") + "\n", swift: swift.join("\n") + "\n" };
}

function docLines(doc: string | undefined, language: ModelLanguage): string[] {
  if (!doc) {
    return [];
  }
  return language === "kotlin" ? [`/** ${doc} */`] : [`/// ${doc}`];
}

function fieldTypes(rule: Rule): { kotlin: string; swift: string } | undefined {
  switch (rule.kind) {
    case "number":
      return rule.integer ? { kotlin: "Int", swift: "Int" } : { kotlin: "Double", swift: "Double" };
    case "boolean":
      return { kotlin: "Boolean", swift: "Bool" };
    case "enum":
      return rule.values?.every((value) => typeof value === "string") ? stringTypes : undefined;
    case "string":
    case "key":
    case "boundKey":
    case "pointer":
      return stringTypes;
    case "array": {
      const item = rule.item?.kind === "array" || !rule.item ? undefined : fieldTypes(rule.item);
      return item && { kotlin: `List<${item.kotlin}>`, swift: `[${item.swift}]` };
    }
    default:
      return undefined;
  }
}

const stringTypes = { kotlin: "String", swift: "String" };

/** Byte-for-byte comparison is shared by --check and fast, in-memory stale-output tests. */
export function staleModelOutputs(
  expected: ModelSources,
  actual: { [K in keyof ModelSources]: string | undefined },
): string[] {
  return (Object.keys(modelOutputPaths) as (keyof ModelSources)[])
    .filter((language) => expected[language] !== actual[language])
    .map((language) => modelOutputPaths[language]);
}

if (import.meta.main) {
  const sources = renderPrototypeSpecModels(contract, prototypeModelSelection);
  const urls = {
    kotlin: new URL(`../../${modelOutputPaths.kotlin}`, import.meta.url),
    swift: new URL(`../../${modelOutputPaths.swift}`, import.meta.url),
  };
  if (process.argv.includes("--check")) {
    const read = (url: URL) => (existsSync(url) ? readFileSync(url, "utf8") : undefined);
    const stale = staleModelOutputs(sources, {
      kotlin: read(urls.kotlin),
      swift: read(urls.swift),
    });
    for (const path of stale) {
      console.error(
        `${path} is stale; regenerate: bun scripts/prototype/generate-prototype-spec-models.ts`,
      );
    }
    process.exitCode = stale.length ? 1 : 0;
    if (!stale.length) {
      console.log("Prototype spec models are current.");
    }
  } else {
    writeFileSync(urls.kotlin, sources.kotlin);
    writeFileSync(urls.swift, sources.swift);
  }
}
