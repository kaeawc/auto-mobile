import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The custom rules' file-scoping used to be enforced (and tested) through
// eslint.config.mjs's `files:` globs. Under oxlint that scoping lives in
// .oxlintrc.json's `overrides`, so the "does not apply outside <glob>"
// guarantees that bareExpectRule / accumulatorForEachRule / stressExplicitTimeout
// used to assert are now asserted here, against the config itself.
//
// .oxlintrc.json is JSONC (it carries `//` comment lines), so strip whole-line
// comments before parsing. Every comment in the file is a full-line comment.

interface OxlintOverride {
  files: string[];
  rules: Record<string, unknown>;
}
interface OxlintConfig {
  rules: Record<string, unknown>;
  overrides: OxlintOverride[];
}

function loadConfig(): OxlintConfig {
  const path = join(process.cwd(), ".oxlintrc.json");
  const text = readFileSync(path, "utf8");
  const stripped = text
    .split("\n")
    .filter(line => !/^\s*\/\//.test(line))
    .join("\n");
  return JSON.parse(stripped) as OxlintConfig;
}

function overrideFor(config: OxlintConfig, rule: string): OxlintOverride | undefined {
  return config.overrides.find(o => Object.prototype.hasOwnProperty.call(o.rules, rule));
}

describe(".oxlintrc.json rule scoping", () => {
  const config = loadConfig();

  test("catch-convention and no-unknown-cast are scoped to src/**", () => {
    for (const rule of ["auto-mobile/catch-convention", "auto-mobile/no-unknown-cast"]) {
      const override = overrideFor(config, rule);
      expect(override?.files).toEqual(["src/**/*.ts"]);
    }
  });

  test("no-accumulator-foreach is scoped to src/**, not the whole tree", () => {
    const override = overrideFor(config, "auto-mobile/no-accumulator-foreach");
    expect(override?.files).toEqual(["src/**/*.ts"]);
    // And it is NOT enabled at the top level (which would apply it to test/).
    expect(config.rules["auto-mobile/no-accumulator-foreach"]).toBeUndefined();
  });

  test("stress-explicit-timeout is scoped to test/stress/**", () => {
    const override = overrideFor(config, "auto-mobile/stress-explicit-timeout");
    expect(override?.files).toEqual(["test/stress/**/*.ts"]);
  });

  test("no-bare-expect is scoped to test/**", () => {
    const override = overrideFor(config, "auto-mobile/no-bare-expect");
    expect(override?.files).toEqual(["test/**/*.ts"]);
  });

  test("naming-convention and no-extension-import apply to all *.ts (top-level)", () => {
    expect(config.rules["auto-mobile/naming-convention"]).toBe("error");
    expect(config.rules["auto-mobile/no-extension-import"]).toBe("error");
  });

  test("no-explicit-any is scoped to the two correctness-sensitive navigation files", () => {
    const override = overrideFor(config, "typescript/no-explicit-any");
    expect(override?.files).toEqual([
      "src/features/navigation/ScreenFingerprint.ts",
      "src/features/navigation/ExploreElementExtraction.ts",
    ]);
  });
});
