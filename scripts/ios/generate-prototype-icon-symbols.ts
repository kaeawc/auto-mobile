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

/** Human-reviewable rendering of the canonical table, in contract order. */
export function renderPrototypeIconSymbolDoc(table: PrototypeIconSymbolData): string {
  const names = contract.definitions.iconName.values;
  const mappedNames = names.filter((name) => table.mapped[name]);
  const unmappedNames = names.filter((name) => !table.mapped[name]);
  const entries = mappedNames.map((name) => table.mapped[name]);
  const filledCount = entries.filter((entry) => entry.filled).length;
  const outlinedCount = entries.filter((entry) => entry.outlined).length;
  const cell = (symbol: string | undefined): string => (symbol ? `\`${symbol}\`` : "");
  return [
    "# Prototype icon names on iOS (SF Symbols)",
    "",
    "Generated from schemas/prototype-ios-icon-symbols.json; do not edit. Regenerate: bun scripts/ios/generate-prototype-icon-symbols.ts",
    "",
    `- Contract icon names: ${names.length}`,
    `- Mapped to an SF Symbol: ${mappedNames.length}`,
    `- Fallback (draw the placeholder): ${unmappedNames.length}`,
    `- Mapped names with a filled form: ${filledCount}`,
    `- Mapped names with an outlined form: ${outlinedCount}`,
    `- Minimum iOS: ${table.minimumIOS}`,
    `- Placeholder symbol: \`${table.placeholder}\``,
    "",
    "## Rules",
    "",
    "iOS draws Apple SF Symbols only, never Material artwork. A contract name without an honest SF Symbol equivalent draws the placeholder, and the host lists it in `platformNotes`. Symbols Apple restricts to its own products or services (per the `symbol_restrictions` list in macOS CoreGlyphs, for example `video`, `icloud.*`, `iphone`, `ipad`, `touchid`, `applewatch`, `safari`) are never used, which is why names such as `videocam`, `cloud_upload`, `fingerprint` and `phone_iphone` are fallbacks. Several Material names may share one symbol where SF Symbols has no finer distinction. The `filled` and `outlined` icon-node variants use the listed form when present; otherwise, and for `rounded`, `sharp` and `twoTone`, the default symbol is drawn. At runtime a symbol the OS cannot load falls back to the entry's default symbol, then the placeholder.",
    "",
    `## Fallback names (${unmappedNames.length})`,
    "",
    ...unmappedNames.map((name) => `- \`${name}\``),
    "",
    `## Mapped names (${mappedNames.length})`,
    "",
    "| Name | Default symbol | Filled | Outlined |",
    "| --- | --- | --- | --- |",
    ...mappedNames.map(
      (name) =>
        `| ${cell(name)} | ${cell(table.mapped[name].symbol)} | ${cell(table.mapped[name].filled)} | ${cell(table.mapped[name].outlined)} |`,
    ),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const outputs = [
    {
      url: new URL(
        "../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeIconSymbolData.swift",
        import.meta.url,
      ),
      rendered: renderPrototypeIconSymbolData(table),
    },
    {
      url: new URL("../../ios/prototype-agent/ICON-SYMBOLS.md", import.meta.url),
      rendered: renderPrototypeIconSymbolDoc(table),
    },
  ];
  for (const { url, rendered } of outputs) {
    if (!process.argv.includes("--check")) {
      writeFileSync(url, rendered);
    } else if (readFileSync(url, "utf8") !== rendered) {
      console.error(`${url.pathname} is stale; regenerate with this script.`);
      process.exitCode = 1;
    }
  }
}
