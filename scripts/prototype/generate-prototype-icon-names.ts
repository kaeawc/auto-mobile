import { readFileSync, writeFileSync } from "node:fs";
import names from "../../schemas/prototype-icon-names.json";

export function renderPrototypeIconGuide(): string {
  return [
    "# Prototype icons",
    "",
    `Prototypes accept these ${names.length} icon names. Use snake_case exactly as listed.`,
    "Android supports every name in all five styles: `filled` (default), `outlined`, `rounded`, `sharp` and `twoTone`. Navigation items use `filled`. Android web previews use the same styles; `crop_169` and `eco` draw a placeholder because their web artwork is unavailable.",
    "On iOS, names use SF Symbols where an equivalent is available; other names draw a placeholder. An unavailable style uses the mapped default symbol.",
    "",
    "Search allowed names by reading `automobile:prototype/icons?query=<substring>`, for example `automobile:prototype/icons?query=home`. The prototype guide is available at `automobile:prototype`.",
    "Unknown names reject the spec with the field path and suggestions for names containing, or contained in, the supplied name. Replace the name with an allowed value before retrying.",
    "",
    "## Allowed names",
    "",
    ...names.map((name) => `- \`${name}\``),
    "",
  ].join("\n");
}

/** The curated data is authoritative; all renderers and R8 consume the resulting contract. */
export function renderPrototypeIconContract(): string {
  if (
    names.length < 250 ||
    names.length > 350 ||
    JSON.stringify(names) !== JSON.stringify([...new Set(names)].sort())
  ) {
    throw new Error("Prototype icon names must contain 250–350 unique, sorted names");
  }
  const url = new URL("../../schemas/prototype-spec-contract.json", import.meta.url);
  const contract = JSON.parse(readFileSync(url, "utf8"));
  contract.definitions.iconName.values = names;
  return JSON.stringify(contract, null, 2) + "\n";
}

if (import.meta.main) {
  const outputs = [
    {
      url: new URL("../../schemas/prototype-spec-contract.json", import.meta.url),
      rendered: renderPrototypeIconContract(),
    },
    {
      url: new URL("../../docs/using/prototype-icons.md", import.meta.url),
      rendered: renderPrototypeIconGuide(),
    },
  ];
  for (const { url, rendered } of outputs) {
    if (!process.argv.includes("--check")) {
      writeFileSync(url, rendered);
    } else if (
      url.pathname.endsWith(".json")
        ? JSON.stringify(JSON.parse(readFileSync(url, "utf8"))) !==
          JSON.stringify(JSON.parse(rendered))
        : readFileSync(url, "utf8") !== rendered
    ) {
      console.error(
        `${url.pathname} is stale; run bun scripts/prototype/generate-prototype-icon-names.ts`,
      );
      process.exitCode = 1;
    }
  }
}
