import { existsSync, readFileSync, writeFileSync } from "node:fs";
import contract from "../../schemas/prototype-spec-contract.json";
import type { Rule } from "../../src/features/prototype/prototypeBindingValidation";
import { prototypeModelOverrides } from "./prototype-model-overrides";

export type ModelSelection = Readonly<Record<string, Readonly<Record<string, "Int" | "Double">>>>;
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
 * Deliberately only plain objects with number fields. Rules still validate at the existing
 * contract boundary; models do not duplicate numeric bounds or add decoding error paths.
 * Everything else (including refs and nested objects) must remain hand-written for now.
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
  for (const [name, numbers] of Object.entries(selection)) {
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
    const typeName = name.charAt(0).toUpperCase() + name.slice(1);
    kotlin.push("", "@Serializable", `data class Prototype${typeName}(`);
    swift.push("", `struct ${typeName}: Decodable, Encodable {`);
    for (const [fieldName, field] of fields) {
      if (!field || field.rule.kind !== "number") {
        throw new Error(
          `Definition ${name}.${fieldName}: unsupported kind ${field?.rule.kind ?? "missing"}; expected number`,
        );
      }
      const kotlinType = numbers[fieldName];
      if (kotlinType !== "Int" && kotlinType !== "Double") {
        throw new Error(`Definition ${name}.${fieldName}: missing Kotlin Int/Double override`);
      }
      const swiftType = field.rule.integer ? "Int" : "Double";
      kotlin.push(`  val ${fieldName}: ${kotlinType}${field.optional ? "? = null" : ""},`);
      swift.push(`    let ${fieldName}: ${swiftType}${field.optional ? "?" : ""}`);
    }
    for (const fieldName of Object.keys(numbers)) {
      if (!Object.hasOwn(definition.fields, fieldName)) {
        throw new Error(`Definition ${name}.${fieldName}: unused Kotlin number override`);
      }
    }
    kotlin.push(")");
    swift.push("}");
  }
  return { kotlin: kotlin.join("\n") + "\n", swift: swift.join("\n") + "\n" };
}

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
  const sources = renderPrototypeSpecModels(contract, prototypeModelOverrides);
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
