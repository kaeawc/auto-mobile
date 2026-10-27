import { existsSync, readFileSync, writeFileSync } from "node:fs";
import contract from "../../schemas/prototype-spec-contract.json";
import type { Rule } from "../../src/features/prototype/prototypeBindingValidation";
import { prototypeModelSelection, prototypeTypeRefs } from "./prototype-model-selection";

import { renderObject } from "./prototype-model-rendering";
import { renderUnion } from "./prototype-model-unions";
export { escapeModelIdentifier } from "./prototype-model-rendering";

export type ModelLanguage = "kotlin" | "swift";
export interface ModelOptions {
  readonly languages?: readonly ModelLanguage[];
  readonly swiftName?: string;
  readonly kotlinName?: string;
  readonly swiftConformances?: readonly string[];
  readonly variantNames?: Readonly<Record<string, string>>;
  readonly variantDocs?: Readonly<Record<string, string>>;
  readonly doc?: string;
}
export type TypeRefs = Readonly<
  Record<string, { readonly kotlin?: string; readonly swift?: string }>
>;
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

/** Render contract objects, refs, nested objects and tagged unions; validation stays in the contract interpreters. */
export function renderPrototypeSpecModels(
  source: { definitions: Readonly<Record<string, Rule>> },
  selection: ModelSelection,
  refs: TypeRefs = {},
): ModelSources {
  const kotlin = [
    ...header,
    "package dev.jasonpearson.automobile.protocol",
    "",
    "import kotlinx.serialization.Serializable",
  ];
  const swift = [...header];
  if (
    Object.entries(selection).some(
      ([name, options]) =>
        source.definitions[name]?.kind === "tagged" &&
        (!options.languages || options.languages.includes("kotlin")),
    )
  ) {
    kotlin.splice(kotlin.length - 1, 0, "import kotlinx.serialization.SerialName");
  }
  for (const [name, options] of Object.entries(selection)) {
    const definition = source.definitions[name];
    if (!definition) {
      throw new Error(`Definition ${name}: not found`);
    }
    for (const language of options.languages ?? ["kotlin", "swift"]) {
      const context = {
        definitions: source.definitions,
        selection,
        refs,
        language,
        output: language === "kotlin" ? kotlin : swift,
      };
      if (definition.kind === "object" && definition.fields) {
        renderObject(name, definition, options, context, [name]);
      } else if (definition.kind === "tagged") {
        renderUnion(name, definition, options, context);
      } else {
        throw new Error(
          `Definition ${name}: unsupported kind ${definition.kind}; expected object or tagged`,
        );
      }
    }
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
  const sources = renderPrototypeSpecModels(contract, prototypeModelSelection, prototypeTypeRefs);
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
