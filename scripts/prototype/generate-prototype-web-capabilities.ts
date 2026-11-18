import { readFileSync, writeFileSync } from "node:fs";
import { knownPrototypeCapabilities } from "../../src/features/prototype/prototypeCapabilityGates";

/**
 * The capabilities the web library advertises (#16453), excluding validation-only contracts.
 * Generated because the gate table's import closure is not browser-safe.
 */
export const webCapabilitiesOutputPath =
  "src/features/prototype/web/embed/prototypeWebCapabilities.generated.ts";

const REGENERATE = "bun scripts/prototype/generate-prototype-web-capabilities.ts";

export function renderPrototypeWebCapabilities(capabilities: readonly string[]): string {
  const advertised = capabilities.filter(
    (capability) => capability !== "prototype_remote_image_v1",
  );
  if (advertised.length === 0) {
    throw new Error("No prototype capabilities to advertise");
  }
  return [
    "// Generated from knownPrototypeCapabilities() in prototypeCapabilityGates.ts; do not edit.",
    `// Regenerate: ${REGENERATE}`,
    "",
    "/** Capabilities advertised by this release of the web library. */",
    "export const PROTOTYPE_WEB_CAPABILITIES: readonly string[] = [",
    ...advertised.sort().map((capability) => `  ${JSON.stringify(capability)},`),
    "];",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const expected = renderPrototypeWebCapabilities(knownPrototypeCapabilities());
  const url = new URL(`../../${webCapabilitiesOutputPath}`, import.meta.url);
  if (process.argv.includes("--check")) {
    const current = readFileSync(url, "utf8").replace(/\r\n/g, "\n");
    if (current !== expected) {
      console.error(`${webCapabilitiesOutputPath} is stale; regenerate: ${REGENERATE}`);
      process.exitCode = 1;
    }
  } else {
    writeFileSync(url, expected);
  }
}
