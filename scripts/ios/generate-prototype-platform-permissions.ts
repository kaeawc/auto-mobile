import { readFileSync, writeFileSync } from "node:fs";
import mapping from "../../schemas/prototype-platform-permissions.json";

/** The embedded dylib has no resource bundle; the Swift reader decodes this JSON string. */
export function renderPrototypePlatformPermissionsData(): string {
  return [
    "// Generated from schemas/prototype-platform-permissions.json; do not edit.",
    "// Regenerate: bun scripts/ios/generate-prototype-platform-permissions.ts",
    "// swiftformat:disable all",
    'let prototypePlatformPermissionsData = #"""',
    JSON.stringify(mapping),
    '"""#',
    "",
  ].join("\n");
}

if (import.meta.main) {
  const url = new URL(
    "../../ios/prototype-agent/Sources/AutoMobilePrototypeAgentCore/PrototypePlatformPermissionsData.swift",
    import.meta.url,
  );
  const rendered = renderPrototypePlatformPermissionsData();
  if (!process.argv.includes("--check")) {
    writeFileSync(url, rendered);
  } else if (readFileSync(url, "utf8") !== rendered) {
    console.error(`${url.pathname} is stale; regenerate with this script.`);
    process.exitCode = 1;
  }
}
