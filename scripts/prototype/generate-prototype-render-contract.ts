import { readFileSync, writeFileSync } from "node:fs";
import contract from "../../schemas/prototype-spec-contract.json";

/**
 * The contract values the still renderer's import closure reads, generated so that closure does
 * not bundle the whole contract JSON (#16451). Add a name here before reading a new limit there.
 */
export const renderContractLimitNames = [
  "MAX_PROTOTYPE_DATA_POINTER_LENGTH",
  "MAX_PROTOTYPE_LIST_ITEMS",
  "MAX_PROTOTYPE_NODES",
  "MAX_PROTOTYPE_STRING_KEYS",
  "MAX_PROTOTYPE_STRING_LENGTH",
  "MAX_PROTOTYPE_STRING_LOCALES",
  "MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH",
] as const;

export const renderContractOutputPath =
  "src/features/prototype/prototypeRenderContract.generated.ts";

interface RenderContractSource {
  limits: Readonly<Record<string, number>>;
  patterns: Readonly<Record<string, string>>;
  stringFields: readonly string[];
  stringOpaqueFields: readonly string[];
  platformModules: {
    device: { state: { widthClass: { breakpoints?: readonly number[] } } };
  };
  definitions: {
    repeat: {
      fields: { items: { rule: { options: readonly { kind: string; max?: number }[] } } };
    };
  };
}

const literal = (value: string | number) => JSON.stringify(value);

function objectLines(name: string, entries: readonly (readonly [string, string | number])[]) {
  return [
    `export const ${name} = {`,
    ...entries.map(([key, value]) => `  ${key}: ${literal(value)},`),
    "} as const;",
  ];
}

function arrayLines(name: string, values: readonly string[]) {
  return [
    `export const ${name} = [`,
    ...values.map((value) => `  ${literal(value)},`),
    "] as const;",
  ];
}

export function renderPrototypeRenderContract(source: RenderContractSource): string {
  const limits = renderContractLimitNames.map((name) => {
    const value = source.limits[name];
    if (typeof value !== "number") {
      throw new Error(`Contract limit ${name}: not found`);
    }
    return [name, value] as const;
  });
  const repeatMax = source.definitions.repeat.fields.items.rule.options.find(
    (option) => option.kind === "array",
  )?.max;
  if (repeatMax === undefined) {
    throw new Error("Contract repeat.items: no array option with a max");
  }
  const breakpoints = source.platformModules.device.state.widthClass.breakpoints;
  if (!breakpoints || breakpoints.length !== 2) {
    throw new Error("Contract platformModules.device widthClass: expected two breakpoints");
  }
  return [
    "// Generated from schemas/prototype-spec-contract.json; do not edit.",
    "// Regenerate: bun scripts/prototype/generate-prototype-render-contract.ts",
    "",
    ...objectLines("prototypeRenderLimits", limits),
    "",
    "/** The largest literal `repeat.items` array. */",
    `export const PROTOTYPE_REPEAT_ITEMS_MAX = ${repeatMax};`,
    "",
    "/** The `/device/widthClass` medium and expanded breakpoints, in dp. */",
    `export const PROTOTYPE_WIDTH_CLASS_BREAKPOINTS = [${breakpoints.join(", ")}] as const;`,
    "",
    ...objectLines("prototypeContractPatternSources", Object.entries(source.patterns)),
    "",
    ...arrayLines("prototypeStringFields", source.stringFields),
    "",
    ...arrayLines("prototypeStringOpaqueFields", source.stringOpaqueFields),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const expected = renderPrototypeRenderContract(contract);
  const url = new URL(`../../${renderContractOutputPath}`, import.meta.url);
  if (process.argv.includes("--check")) {
    const current = readFileSync(url, "utf8").replace(/\r\n/g, "\n");
    if (current !== expected) {
      console.error(
        `${renderContractOutputPath} is stale; regenerate: bun scripts/prototype/generate-prototype-render-contract.ts`,
      );
      process.exitCode = 1;
    }
  } else {
    writeFileSync(url, expected);
  }
}
