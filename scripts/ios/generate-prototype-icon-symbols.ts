import { readFileSync, writeFileSync } from "node:fs";
import table from "../../schemas/prototype-ios-icon-symbols.json";
import contract from "../../schemas/prototype-spec-contract.json";

export interface PrototypeIconSymbolEntry {
  symbol: string;
  filled?: string;
  outlined?: string;
}
export interface PrototypeIconSymbolData {
  minimumIOS: string;
  placeholder: string;
  mapped: Record<string, PrototypeIconSymbolEntry>;
  unmapped: readonly string[];
}

/** Compile the canonical table in contract order; the dylib has no resource bundle. */
export function renderPrototypeIconSymbolData(table: PrototypeIconSymbolData): string {
  const lines = contract.definitions.iconName.values.map((name) => {
    const entry = table.mapped[name];
    return entry ? [name, entry.symbol, entry.filled ?? "", entry.outlined ?? ""].join("\t") : name;
  });
  return [
    "// Generated from schemas/prototype-ios-icon-symbols.json; do not edit.",
    "// Regenerate: bun scripts/ios/generate-prototype-icon-symbols.ts",
    "// swiftformat:disable all",
    "// swiftlint:disable all",
    `let prototypeIconSymbolPlaceholder = ${JSON.stringify(table.placeholder)}`,
    'let prototypeIconSymbolData = #"""',
    ...lines,
    '"""#',
    "",
  ].join("\n");
}

if (import.meta.main) {
  const output = new URL(
    "../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeIconSymbolData.swift",
    import.meta.url,
  );
  const rendered = renderPrototypeIconSymbolData(table);
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== rendered) {
      console.error("PrototypeIconSymbolData.swift is stale; regenerate with this script.");
      process.exitCode = 1;
    }
  } else {
    writeFileSync(output, rendered);
  }
}
