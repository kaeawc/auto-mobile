import { readFileSync, writeFileSync } from "node:fs";
import contract from "../../schemas/prototype-spec-contract.json";

/** The embedded dylib has no resource bundle; include motionTokens with the complete canonical contract. */
export function renderPrototypeSpecContractData(): string {
  return [
    "// Generated from schemas/prototype-spec-contract.json; do not edit.",
    "// Regenerate: bun scripts/ios/generate-prototype-spec-contract.ts",
    "// swiftformat:disable all",
    'let prototypeSpecContractData = #"""',
    JSON.stringify(contract),
    '"""#',
    "",
  ].join("\n");
}

if (import.meta.main) {
  const url = new URL(
    "../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypeSpecContractData.swift",
    import.meta.url,
  );
  const rendered = renderPrototypeSpecContractData();
  if (!process.argv.includes("--check")) {
    writeFileSync(url, rendered);
  } else if (readFileSync(url, "utf8") !== rendered) {
    console.error(`${url.pathname} is stale; regenerate with this script.`);
    process.exitCode = 1;
  }
}
